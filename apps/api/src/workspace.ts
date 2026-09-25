import { createHash } from "node:crypto";
import type { FastifyInstance } from "fastify";
import type { Sql } from "postgres";
import { z } from "zod";
import type { ServerEnv } from "@maman/config";
import { uuidv7 } from "@maman/contracts";
import {
  buildAuthorizationUrl,
  createConnectorTokenTransport,
  envelopeEncrypt,
  exchangeCode,
  generatePkce,
  getProvider,
  packEnvelope,
  signState,
  verifyState,
  type TokenTransport,
} from "@maman/connector-auth";
import {
  fetchTransport,
  gmailContentReader,
  salesforceActivityWriter,
  salesforceOpportunityWriter,
  type HttpTransport,
} from "@maman/connector-adapters";
import {
  createUserConnection,
  draftOutcomes,
  getObligationForDraft,
  getThreadMessages,
  listPendingObligations,
  listUserConnections,
  setObligationOutcome,
  type UserContext,
  listWorkflowEvents,
  pendingDraftForThread,
} from "@maman/db";
import {
  createOrgVaultCredentialProvider,
  createUserVaultCredentialProvider,
  applyAction,
  approveAction,
  declineAction,
  forgetIntent,
  listActionViews,
  listIntentViews,
  orgPolicyResolver,
  promoteAction,
  proposeActivityLog,
  resolveDealSource,
  revertAction,
  runDraftJob,
  runOpportunityPass,
  skippedWithReasons,
  stateIntent,
  runGmailSyncJob,
  routineViews,
  decideOnRoutine,
  startRoutine,
  keepIntent,
  proposeSend,
} from "@maman/sync";
import { createModelProvider } from "@maman/model-provider";
import {
  deterministicContextComposer,
  modelComposer,
  type ContextComposer,
} from "@maman/voice-engine";
import { DeterministicModelProvider } from "@maman/model-provider";
import { requirePrincipal } from "./auth.js";
import { authorize } from "./authorization.js";
import { landing } from "./connectors.js";

/**
 * THE PERSON'S WORKSPACE over HTTP — `/v1/me/*`.
 *
 * Everything here is scoped to the authenticated principal's own user id.
 * There is no route that takes a user id as a parameter, because there is no
 * legitimate reason for one person's request to name another person's data.
 * The RLS policy would return nothing anyway; not offering the parameter means
 * the API cannot even express the question.
 *
 * Mirrors connectors.ts for the OAuth dance, with two deliberate differences:
 * the envelope AAD binds the USER (so a token cannot be moved between reps),
 * and the row lands in `user_connections`, not the org-level vault.
 */

/**
 * Providers a person may connect for themselves. Org-installed connectors
 * (Salesforce, HubSpot) go through /v1/connectors; a mailbox is personal.
 */
const PERSONAL_PROVIDERS = new Set(["gmail"]);

/** Drafts the sweep writes per person per sweep when the agent is on. Enough to be useful, few enough to trust. */
const DEFAULT_PREDRAFT_PER_SWEEP = 3;

// PKCE verifiers keyed by the signed state nonce, cleared on callback. Same
// caveat as connectors.ts: a short-TTL store in production, memory here.
const pkceStore = new Map<string, string>();

export type WorkspaceRouteDeps = {
  env: ServerEnv;
  sql?: Sql | undefined;
  /** Token-endpoint transport (tests inject a fake). */
  tokenTransport?: TokenTransport;
  /** Provider API transport for sync (tests inject a scripted Gmail). */
  gmailTransport?: HttpTransport;
  /** CRM API transport for the deal step (tests inject a scripted Salesforce). */
  crmTransport?: HttpTransport;
  now?: () => Date;
  /** Draft composer override (tests). Default: model when the agent is on, template otherwise. */
  composer?: ContextComposer;
};

export function registerWorkspaceRoutes(app: FastifyInstance, deps: WorkspaceRouteDeps): void {
  const { env } = deps;
  const master = Buffer.from(
    createHash("sha256").update(env.CONNECTOR_ENCRYPTION_MASTER_KEY).digest(),
  );
  const now = deps.now ?? (() => new Date());
  const tokenTransport = deps.tokenTransport ?? createConnectorTokenTransport();
  const gmailTransport = deps.gmailTransport ?? fetchTransport;
  const crmTransport = deps.crmTransport ?? fetchTransport;
  const agentOn = env.AGENT_MODE === "assist";
  const modelProvider = createModelProvider(env);
  // The template composer is the deterministic provider's draft: grounded by
  // construction. With the agent on, the model writes and the template is
  // the fallback; off, the template is the composer. Same interface.
  const template = deterministicContextComposer(new DeterministicModelProvider());
  const composer =
    deps.composer ??
    (agentOn ? modelComposer({ provider: modelProvider, fallback: template }) : template);

  const clientFor = (provider: string) =>
    provider === "gmail" && env.GOOGLE_CLIENT_ID
      ? {
          client_id: env.GOOGLE_CLIENT_ID,
          ...(env.GOOGLE_CLIENT_SECRET ? { client_secret: env.GOOGLE_CLIENT_SECRET } : {}),
        }
      : null;
  const orgClientFor = (provider: string) =>
    provider === "salesforce" && env.SALESFORCE_CLIENT_ID
      ? {
          client_id: env.SALESFORCE_CLIENT_ID,
          ...(env.SALESFORCE_CLIENT_SECRET ? { client_secret: env.SALESFORCE_CLIENT_SECRET } : {}),
        }
      : null;
  /** Writes to the organization's CRM: the org vault, the org's policy, this person's ledger. */
  const actionDeps = (sql: Sql) => {
    const credentials = createOrgVaultCredentialProvider({
      sql,
      masterKey: master,
      transport: tokenTransport,
      clientCredentials: orgClientFor,
    });
    return {
      sql,
      contentKey: master,
      writer: salesforceActivityWriter({ credentials, transport: crmTransport }),
      opportunities: salesforceOpportunityWriter({ credentials, transport: crmTransport }),
      orgPolicy: orgPolicyResolver(sql),
      // Sends go out as the person, through their own Gmail connection.
      gmail: {
        credentials: createUserVaultCredentialProvider({
          sql,
          masterKey: master,
          transport: tokenTransport,
          clientCredentials: clientFor,
        }),
        transport: gmailTransport,
      },
      now,
    };
  };

  /** The organization's CRM, looked up per sync; the org vault, never the user's. */
  const dealsFor = (sql: Sql) =>
    resolveDealSource({
      sql,
      credentials: createOrgVaultCredentialProvider({
        sql,
        masterKey: master,
        transport: tokenTransport,
        clientCredentials: orgClientFor,
      }),
      transport: crmTransport,
    });

  const userCtx = (p: { organization_id: string; user_id: string }): UserContext => ({
    organizationId: p.organization_id,
    userId: p.user_id,
  });

  // ---- connections ----

  app.get("/v1/me/connections", { schema: { tags: ["me"] } }, async (req, reply) => {
    const principal = await requirePrincipal(req, reply);
    if (!principal) return;
    if (!deps.sql) return reply.status(503).send({ status: 503 });
    // Status views only — the repository has no function that returns a token.
    return { connections: await listUserConnections(deps.sql, userCtx(principal)) };
  });

  app.post(
    "/v1/me/connections/:provider/authorize",
    { schema: { tags: ["me"] } },
    async (req, reply) => {
      const principal = await requirePrincipal(req, reply);
      if (!principal) return;
      if (!authorize(principal, "connectors.manage_own").allowed) {
        return reply.status(403).send({ status: 403, title: "Forbidden" });
      }
      const provider = (req.params as { provider: string }).provider;
      const config = getProvider(provider);
      if (!config || !PERSONAL_PROVIDERS.has(provider)) {
        return reply.status(404).send({ status: 404 });
      }

      const redirectUri = `${env.API_BASE_URL}/v1/me/connections/${provider}/callback`;
      const nonce = uuidv7();
      const state = signState(
        {
          organization_id: principal.organization_id,
          user_id: principal.user_id,
          provider,
          redirect_uri: redirectUri,
          nonce,
          issued_at_ms: now().getTime(),
        },
        env.OAUTH_STATE_SIGNING_SECRET,
      );
      let challenge: string | undefined;
      if (config.supports_pkce) {
        const pkce = generatePkce();
        pkceStore.set(nonce, pkce.verifier);
        challenge = pkce.challenge;
      }
      const url = buildAuthorizationUrl({
        provider,
        client_id: clientFor(provider)?.client_id ?? "demo-client-id",
        redirect_uri: redirectUri,
        state,
        ...(challenge ? { pkce_challenge: challenge } : {}),
      });
      // Demo mode: there is no provider to consent at. The browser lands on
      // our own callback with a demo code, and the same exchange, storage and
      // redirect run as they would after a real consent.
      const demoUrl = `${redirectUri}?code=demo&state=${encodeURIComponent(state)}`;
      return {
        authorization_url: env.CONNECTOR_MODE === "demo" ? demoUrl : url,
        expires_in_seconds: 600,
      };
    },
  );

  app.get(
    "/v1/me/connections/:provider/callback",
    { schema: { tags: ["me"] } },
    async (req, reply) => {
      const provider = (req.params as { provider: string }).provider;
      const query = req.query as { code?: string; state?: string };
      if (!query.code || !query.state) return reply.status(400).send({ status: 400 });
      if (!PERSONAL_PROVIDERS.has(provider)) return reply.status(404).send({ status: 404 });

      const verified = verifyState(query.state, env.OAUTH_STATE_SIGNING_SECRET, now().getTime());
      if (!verified.valid) return reply.status(400).send({ status: 400, detail: verified.reason });
      const payload = verified.payload;
      if (payload.provider !== provider) return reply.status(400).send({ status: 400 });
      if (!deps.sql) return reply.status(503).send({ status: 503 });

      const verifier = pkceStore.get(payload.nonce);
      pkceStore.delete(payload.nonce); // single use
      // A PKCE provider with no verifier on file means this state was already
      // spent (or minted by another process): the exchange would either fail
      // at the provider or, worse, succeed without the proof. Refuse here.
      if (getProvider(provider)!.supports_pkce && !verifier) {
        return reply.redirect(landing(env, provider, { error: "state_reused" }), 303);
      }

      const client = clientFor(provider);
      const result = await exchangeCode(
        {
          provider,
          client_id: client?.client_id ?? "demo-client-id",
          ...(client?.client_secret ? { client_secret: client.client_secret } : {}),
          code: query.code,
          redirect_uri: payload.redirect_uri,
          ...(verifier ? { pkce_verifier: verifier } : {}),
        },
        tokenTransport,
      );
      if (!result.ok) {
        return reply.redirect(landing(env, provider, { error: "exchange_failed" }), 303);
      }

      // THE USER IS IN THE AAD. Copy this ciphertext into a colleague's row and
      // it will not open. The plaintext token dies with this scope.
      const ctx = userCtx(payload);
      const packed = packEnvelope(
        envelopeEncrypt(
          {
            access_token: result.tokens.access_token,
            ...(result.tokens.refresh_token ? { refresh_token: result.tokens.refresh_token } : {}),
            ...(result.tokens.scope ? { scope: result.tokens.scope } : {}),
          },
          master,
          { organization_id: ctx.organizationId, user_id: ctx.userId, provider },
        ),
      );
      const created = await createUserConnection(deps.sql, ctx, {
        provider,
        // The mailbox address is learned on the first sync (Gmail's token
        // response does not carry it without an identity scope we do not ask
        // for). One label per provider until then means one connection each.
        external_account_label: getProvider(provider)!.display_name,
        encrypted_credentials: packed,
        scopes: getProvider(provider)!.scopes,
      });
      // The browser came from Google's consent screen; send it home. The URL
      // says which provider connected and nothing else — no token, no id.
      void created;
      return reply.redirect(landing(env, provider, { connected: true }), 303);
    },
  );

  // ---- sync ----

  app.post("/v1/me/sync", { schema: { tags: ["me"] } }, async (req, reply) => {
    const principal = await requirePrincipal(req, reply);
    if (!principal) return;
    if (!deps.sql) return reply.status(503).send({ status: 503 });
    const sql = deps.sql;
    const credentials = createUserVaultCredentialProvider({
      sql,
      masterKey: master,
      transport: tokenTransport,
      clientCredentials: clientFor,
    });
    const result = await runGmailSyncJob(
      {
        sql,
        credentials,
        transport: gmailTransport,
        now,
        // Mail content is stored encrypted to the person, under the same
        // derived key that opens their mailbox token.
        contentKey: master,
        deals: dealsFor(sql),
        actions: actionDeps(sql),
        // The event stream, unless switched off.
        ...(env.EVENT_STREAM === "off" ? {} : { events: {} }),
        ...(env.EVENT_STREAM === "off" || env.DISCOVERY === "off" ? {} : { discovery: {} }),
        // The agent pass runs only when switched on; off means the list is
        // the deterministic ranking, exactly as before the agent existed.
        ...(agentOn
          ? {
              agent: {
                provider: modelProvider,
                content: gmailContentReader({ credentials, transport: gmailTransport }),
              },
              predraft: { composer, max: env.PREDRAFT_PER_SWEEP ?? DEFAULT_PREDRAFT_PER_SWEEP },
            }
          : {}),
      },
      userCtx(principal),
    );
    if (!result.ok) {
      // 409: the request was well-formed and the person is who they say; the
      // workspace is simply not in a state where a sync can happen. The body
      // says which state, so the UI can offer "connect" or "reconnect".
      return reply.status(409).send({ status: 409, ...result });
    }
    return result;
  });

  // ---- obligations ----

  app.get("/v1/me/obligations", { schema: { tags: ["me"] } }, async (req, reply) => {
    const principal = await requirePrincipal(req, reply);
    if (!principal) return;
    if (!deps.sql) return reply.status(503).send({ status: 503 });
    const limit = Math.min(200, Math.max(1, Number((req.query as { limit?: string }).limit ?? 50)));
    const ctx = userCtx(principal);
    return {
      obligations: await listPendingObligations(deps.sql, ctx, limit, { agent: agentOn }),
      // What the person's own rules set aside, with the rule in their words.
      skipped: await skippedWithReasons({ sql: deps.sql, contentKey: master }, ctx),
      // The product's own measure of its drafts, for the last seven days.
      drafts_this_week: await draftOutcomes(deps.sql, ctx, {
        since: new Date(now().getTime() - 7 * 86_400_000),
      }),
      agent_mode: agentOn ? "assist" : "off",
    };
  });

  const outcomeBody = z
    .object({
      outcome: z.enum(["snoozed", "dismissed", "resolved", "drafted"]),
      snoozed_until: z.string().datetime().optional(),
      /** Why, in the person's words. Kept as intent shown by action. */
      note: z.string().max(300).optional(),
    })
    .strict();

  app.post("/v1/me/obligations/:id/outcome", { schema: { tags: ["me"] } }, async (req, reply) => {
    const principal = await requirePrincipal(req, reply);
    if (!principal) return;
    if (!deps.sql) return reply.status(503).send({ status: 503 });
    const body = outcomeBody.safeParse(req.body);
    if (!body.success) return reply.status(400).send({ status: 400, title: "Bad Request" });
    const id = (req.params as { id: string }).id;
    // Read what it was about BEFORE it stops being pending, so a dismissal
    // can be written down with the subject and the person it concerned.
    const target =
      body.data.outcome === "dismissed"
        ? await getObligationForDraft(deps.sql, userCtx(principal), id).catch(() => null)
        : null;
    const updated = await setObligationOutcome(
      deps.sql,
      userCtx(principal),
      id,
      body.data.outcome,
      body.data.snoozed_until ? new Date(body.data.snoozed_until) : undefined,
    );
    // Missing and someone-else's are the same 404. Never 403: a 403 confirms
    // the row exists, which is exactly the fact RLS is there to withhold.
    if (!updated) return reply.status(404).send({ status: 404, title: "Not Found" });
    // A dismissal is the person telling the agent something. It is written
    // down, scoped to the contact, as an observation; never turned into a
    // rule on its own.
    if (body.data.outcome === "dismissed") {
      const subject = target?.thread.subject ?? "a thread";
      const who = target?.contact.display_name ?? "a contact";
      const text = body.data.note?.trim()
        ? `Dismissed "${subject}" with ${who}: ${body.data.note.trim()}`
        : `Dismissed "${subject}" with ${who} as not needed.`;
      await stateIntent(
        { sql: deps.sql, contentKey: master },
        userCtx(principal),
        text,
        "observed",
        { obligation_id: id },
      ).catch(() => undefined);
    }
    return { id, outcome: body.data.outcome };
  });

  // ---- the intent store: what the person has told the agent ----

  app.get("/v1/me/intents", { schema: { tags: ["me"] } }, async (req, reply) => {
    const principal = await requirePrincipal(req, reply);
    if (!principal) return;
    if (!deps.sql) return reply.status(503).send({ status: 503 });
    return {
      intents: await listIntentViews({ sql: deps.sql, contentKey: master }, userCtx(principal)),
    };
  });

  const intentBody = z.object({ text: z.string().min(1).max(300) }).strict();

  app.post("/v1/me/intents", { schema: { tags: ["me"] } }, async (req, reply) => {
    const principal = await requirePrincipal(req, reply);
    if (!principal) return;
    if (!deps.sql) return reply.status(503).send({ status: 503 });
    const body = intentBody.safeParse(req.body);
    if (!body.success) return reply.status(400).send({ status: 400, title: "Bad Request" });
    const intent = await stateIntent(
      { sql: deps.sql, contentKey: master },
      userCtx(principal),
      body.data.text,
    );
    return { intent };
  });

  /** The person keeps something the agent inferred. Only a proposed entry can be kept. */
  app.post("/v1/me/intents/:id/keep", { schema: { tags: ["me"] } }, async (req, reply) => {
    const principal = await requirePrincipal(req, reply);
    if (!principal) return;
    if (!deps.sql) return reply.status(503).send({ status: 503 });
    const id = (req.params as { id: string }).id;
    const ok = await keepIntent({ sql: deps.sql, contentKey: master }, userCtx(principal), id);
    if (!ok) return reply.status(404).send({ status: 404, title: "Not Found" });
    return { id, status: "active" };
  });

  app.post("/v1/me/intents/:id/retire", { schema: { tags: ["me"] } }, async (req, reply) => {
    const principal = await requirePrincipal(req, reply);
    if (!principal) return;
    if (!deps.sql) return reply.status(503).send({ status: 503 });
    const id = (req.params as { id: string }).id;
    const ok = await forgetIntent({ sql: deps.sql, contentKey: master }, userCtx(principal), id);
    if (!ok) return reply.status(404).send({ status: 404, title: "Not Found" });
    return { id, status: "retired" };
  });

  // ---- the event stream: what the person did, as discovery sees it ----

  app.get("/v1/me/events", { schema: { tags: ["me"] } }, async (req, reply) => {
    const principal = await requirePrincipal(req, reply);
    if (!principal) return;
    if (!deps.sql) return reply.status(503).send({ status: 503 });
    const q = req.query as { limit?: string };
    const limit = Math.min(5000, Math.max(1, Number(q.limit ?? 500) || 500));
    return { events: await listWorkflowEvents(deps.sql, userCtx(principal), { limit }) };
  });

  // ---- routines discovery found, and the person's word on each ----

  app.get("/v1/me/routines", { schema: { tags: ["me"] } }, async (req, reply) => {
    const principal = await requirePrincipal(req, reply);
    if (!principal) return;
    if (!deps.sql) return reply.status(503).send({ status: 503 });
    return { routines: await routineViews(deps.sql, userCtx(principal), now()) };
  });

  const decideBody = z.object({ decision: z.enum(["dismissed", "never", "accepted"]) }).strict();

  /** Not now (held back for the cooldown), never (an entry in the intent store), or accepted (also an entry). */
  app.post("/v1/me/routines/:id/decide", { schema: { tags: ["me"] } }, async (req, reply) => {
    const principal = await requirePrincipal(req, reply);
    if (!principal) return;
    if (!deps.sql) return reply.status(503).send({ status: 503 });
    const body = decideBody.safeParse(req.body);
    if (!body.success) return reply.status(400).send({ status: 400, title: "Bad Request" });
    const id = (req.params as { id: string }).id;
    const r = await decideOnRoutine(
      { sql: deps.sql, contentKey: master, now },
      userCtx(principal),
      id,
      body.data.decision,
    );
    if (!r.ok && r.reason === "not_found") {
      return reply.status(404).send({ status: 404, title: "Not Found" });
    }
    if (!r.ok) return reply.status(409).send({ status: 409, reason: r.reason });
    return { routine: r.routine };
  });

  /** Start: from running alongside the person to producing drafts and proposals for their approval. */
  app.post("/v1/me/routines/:id/start", { schema: { tags: ["me"] } }, async (req, reply) => {
    const principal = await requirePrincipal(req, reply);
    if (!principal) return;
    if (!deps.sql) return reply.status(503).send({ status: 503 });
    const id = (req.params as { id: string }).id;
    const r = await startRoutine(deps.sql, userCtx(principal), id, now());
    if (!r.ok && r.reason === "not_found") {
      return reply.status(404).send({ status: 404, title: "Not Found" });
    }
    if (!r.ok) return reply.status(409).send({ status: 409, reason: r.reason });
    return { routine: r.routine };
  });

  // ---- actions: writes to the organization's CRM, with the receipts ----

  app.get("/v1/me/actions", { schema: { tags: ["me"] } }, async (req, reply) => {
    const principal = await requirePrincipal(req, reply);
    if (!principal) return;
    if (!deps.sql) return reply.status(503).send({ status: 503 });
    return { actions: await listActionViews(actionDeps(deps.sql), userCtx(principal)) };
  });

  /** "Send" on a card: propose sending the draft waiting on this thread, exactly as it is. */
  app.post("/v1/me/obligations/:id/send", { schema: { tags: ["me"] } }, async (req, reply) => {
    const principal = await requirePrincipal(req, reply);
    if (!principal) return;
    if (!deps.sql) return reply.status(503).send({ status: 503 });
    const ctx = userCtx(principal);
    const id = (req.params as { id: string }).id;
    const target = await getObligationForDraft(deps.sql, ctx, id);
    if (!target) return reply.status(404).send({ status: 404, title: "Not Found" });
    const draft = await pendingDraftForThread(deps.sql, ctx, target.thread.id);
    if (!draft) return reply.status(409).send({ status: 409, reason: "no_draft" });
    const proposed = await proposeSend(actionDeps(deps.sql), ctx, { draft_id: draft.id });
    if ("ok" in proposed) return reply.status(409).send({ status: 409, reason: proposed.reason });
    return {
      action: { id: proposed.id, diff_sha256: proposed.diff_sha256, status: proposed.status },
    };
  });

  /** Proposes logging the last email the person sent on this thread. */
  app.post("/v1/me/obligations/:id/log", { schema: { tags: ["me"] } }, async (req, reply) => {
    const principal = await requirePrincipal(req, reply);
    if (!principal) return;
    if (!deps.sql) return reply.status(503).send({ status: 503 });
    const ctx = userCtx(principal);
    const id = (req.params as { id: string }).id;
    const target = await getObligationForDraft(deps.sql, ctx, id);
    if (!target) return reply.status(404).send({ status: 404, title: "Not Found" });
    const messages = await getThreadMessages(deps.sql, ctx, target.thread.id);
    const sent = [...messages].reverse().find((m) => m.direction === "outbound");
    if (!sent) return reply.status(409).send({ status: 409, reason: "nothing_sent" });
    const proposed = await proposeActivityLog(actionDeps(deps.sql), ctx, {
      thread_id: target.thread.id,
      contact_id: target.contact.id,
      contact_email: target.contact.external_id,
      contact_display_name: target.contact.display_name,
      subject: target.thread.subject,
      message_external_id: sent.external_id,
      sent_at: sent.sent_at,
    });
    if ("ok" in proposed) return reply.status(409).send({ status: 409, reason: proposed.reason });
    return {
      action: { id: proposed.id, diff_sha256: proposed.diff_sha256, status: proposed.status },
    };
  });

  /** "Update Salesforce" on a card: read this thread for the deal's next step and close date, and propose. */
  app.post(
    "/v1/me/obligations/:id/update-crm",
    { schema: { tags: ["me"] } },
    async (req, reply) => {
      const principal = await requirePrincipal(req, reply);
      if (!principal) return;
      if (!deps.sql) return reply.status(503).send({ status: 503 });
      const ctx = userCtx(principal);
      const id = (req.params as { id: string }).id;
      const target = await getObligationForDraft(deps.sql, ctx, id);
      if (!target) return reply.status(404).send({ status: 404, title: "Not Found" });
      const r = await runOpportunityPass(
        {
          ...actionDeps(deps.sql),
          provider: modelProvider,
          max_candidates: 50,
          only_thread_id: target.thread.id,
        },
        ctx,
      );
      return { result: r };
    },
  );

  const approveBody = z.object({ diff_sha256: z.string().min(1) }).strict();

  /** Approval bound to the diff's hash; applied at once; verified by read-back. */
  app.post("/v1/me/actions/:id/approve", { schema: { tags: ["me"] } }, async (req, reply) => {
    const principal = await requirePrincipal(req, reply);
    if (!principal) return;
    if (!deps.sql) return reply.status(503).send({ status: 503 });
    const body = approveBody.safeParse(req.body);
    if (!body.success) return reply.status(400).send({ status: 400, title: "Bad Request" });
    const ctx = userCtx(principal);
    const id = (req.params as { id: string }).id;
    const approved = await approveAction(actionDeps(deps.sql), ctx, id, body.data.diff_sha256);
    if (!approved.ok) {
      if (approved.reason === "not_found")
        return reply.status(404).send({ status: 404, title: "Not Found" });
      return reply.status(409).send({ status: 409, reason: approved.reason });
    }
    const applied = await applyAction(actionDeps(deps.sql), ctx, id);
    return {
      id,
      status: applied.action?.status ?? "failed",
      verified: applied.ok,
      ...(applied.ok ? { external_id: applied.action.external_id } : { reason: applied.reason }),
    };
  });

  app.post("/v1/me/actions/:id/decline", { schema: { tags: ["me"] } }, async (req, reply) => {
    const principal = await requirePrincipal(req, reply);
    if (!principal) return;
    if (!deps.sql) return reply.status(503).send({ status: 503 });
    const id = (req.params as { id: string }).id;
    const ok = await declineAction(actionDeps(deps.sql), userCtx(principal), id);
    if (!ok) return reply.status(404).send({ status: 404, title: "Not Found" });
    return { id, status: "declined" };
  });

  app.post("/v1/me/actions/:id/revert", { schema: { tags: ["me"] } }, async (req, reply) => {
    const principal = await requirePrincipal(req, reply);
    if (!principal) return;
    if (!deps.sql) return reply.status(503).send({ status: 503 });
    const id = (req.params as { id: string }).id;
    const r = await revertAction(actionDeps(deps.sql), userCtx(principal), id);
    if (!r.ok) {
      if (r.reason === "not_found")
        return reply.status(404).send({ status: 404, title: "Not Found" });
      return reply.status(409).send({ status: 409, reason: r.reason });
    }
    return { id, status: r.action.status };
  });

  /** "Always do this": a promotion, kept as the person's own standing instruction. */
  app.post("/v1/me/actions/:id/always", { schema: { tags: ["me"] } }, async (req, reply) => {
    const principal = await requirePrincipal(req, reply);
    if (!principal) return;
    if (!deps.sql) return reply.status(503).send({ status: 503 });
    const id = (req.params as { id: string }).id;
    const r = await promoteAction(actionDeps(deps.sql), userCtx(principal), id);
    if (!r.ok) {
      if (r.reason === "not_found")
        return reply.status(404).send({ status: 404, title: "Not Found" });
      return reply.status(409).send({ status: 409, reason: r.reason });
    }
    return { id, intent_id: r.intent_id };
  });

  // ---- drafting: the first write, and the only kind the demo performs ----

  app.post("/v1/me/obligations/:id/draft", { schema: { tags: ["me"] } }, async (req, reply) => {
    const principal = await requirePrincipal(req, reply);
    if (!principal) return;
    if (!deps.sql) return reply.status(503).send({ status: 503 });
    const sql = deps.sql;
    const ctx = userCtx(principal);
    const id = (req.params as { id: string }).id;
    // One job for a click and for the sweep (sync/draft-job.ts). The item
    // stays pending with the draft attached until the person sends it.
    const result = await runDraftJob(
      {
        sql,
        contentKey: master,
        credentials: createUserVaultCredentialProvider({
          sql,
          masterKey: master,
          transport: tokenTransport,
          clientCredentials: clientFor,
        }),
        transport: gmailTransport,
        composer,
        now,
      },
      ctx,
      id,
      "manual",
    );
    if (!result.ok) {
      // Missing, decided, and someone else's are one 404.
      if (result.reason === "not_found") {
        return reply.status(404).send({ status: 404, title: "Not Found" });
      }
      return reply.status(409).send({ status: 409, reason: result.reason });
    }
    return result;
  });
}
