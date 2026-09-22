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
  createGmailDraft,
  fetchTransport,
  gmailContentReader,
  type HttpTransport,
} from "@maman/connector-adapters";
import {
  createUserConnection,
  getObligationForDraft,
  globalGetUserById,
  listPendingObligations,
  listUserConnections,
  recordDraft,
  setObligationOutcome,
  type UserContext,
} from "@maman/db";
import {
  createOrgVaultCredentialProvider,
  createUserVaultCredentialProvider,
  encryptBody,
  forgetIntent,
  intentsFor,
  listIntentViews,
  meetingContext,
  resolveDealSource,
  skippedWithReasons,
  stateIntent,
  runGmailSyncJob,
  storedThreadContent,
  voiceFor,
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
      return { authorization_url: url, expires_in_seconds: 600 };
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
        // The agent pass runs only when switched on; off means the list is
        // the deterministic ranking, exactly as before the agent existed.
        ...(agentOn
          ? {
              agent: {
                provider: modelProvider,
                content: gmailContentReader({ credentials, transport: gmailTransport }),
              },
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

  app.post("/v1/me/intents/:id/retire", { schema: { tags: ["me"] } }, async (req, reply) => {
    const principal = await requirePrincipal(req, reply);
    if (!principal) return;
    if (!deps.sql) return reply.status(503).send({ status: 503 });
    const id = (req.params as { id: string }).id;
    const ok = await forgetIntent({ sql: deps.sql, contentKey: master }, userCtx(principal), id);
    if (!ok) return reply.status(404).send({ status: 404, title: "Not Found" });
    return { id, status: "retired" };
  });

  // ---- drafting: the first write, and the only kind the demo performs ----

  app.post("/v1/me/obligations/:id/draft", { schema: { tags: ["me"] } }, async (req, reply) => {
    const principal = await requirePrincipal(req, reply);
    if (!principal) return;
    if (!deps.sql) return reply.status(503).send({ status: 503 });
    const sql = deps.sql;
    const ctx = userCtx(principal);
    const id = (req.params as { id: string }).id;

    const target = await getObligationForDraft(sql, ctx, id);
    // Missing, decided, and someone else's are one 404.
    if (!target) return reply.status(404).send({ status: 404, title: "Not Found" });

    const reason = target.reason as { days_elapsed?: number };
    const credentials = createUserVaultCredentialProvider({
      sql,
      masterKey: master,
      transport: tokenTransport,
      clientCredentials: clientFor,
    });
    // The conversation, from the store; Gmail only if the store has nothing.
    const content =
      (await storedThreadContent({ sql, contentKey: master }, ctx, target.thread.id)) ??
      (await gmailContentReader({ credentials, transport: gmailTransport }).read(
        { organization_id: ctx.organizationId, user_id: ctx.userId },
        target.thread.external_id,
        [],
      ));
    if (content.messages.length === 0) {
      return reply.status(409).send({ status: 409, reason: "no_thread_content" });
    }
    const sender = await globalGetUserById(sql, ctx.userId);
    const voice = await voiceFor({ sql, contentKey: master }, ctx, target.contact.id);
    const meetings = await meetingContext(
      { sql, contentKey: master },
      ctx,
      target.contact.external_id,
      now(),
    );
    const preferences = await intentsFor({ sql, contentKey: master }, ctx, {
      contact_address: target.contact.external_id,
      account_name: target.contact.account_name,
      kind: target.kind,
    });
    const draft = await composer.compose({
      kind: target.kind,
      contact_display_name: target.contact.display_name,
      contact_address: target.contact.external_id,
      account_name: target.contact.account_name,
      subject: target.thread.subject,
      days_elapsed: reason.days_elapsed ?? 0,
      has_open_deal: target.facts.has_open_deal,
      ...(target.facts.open_deal_value !== null
        ? { open_deal_value: target.facts.open_deal_value }
        : {}),
      ...(target.facts.last_meeting_at ? { last_meeting_at: target.facts.last_meeting_at } : {}),
      ...meetings,
      sender_name: sender?.display_name ?? sender?.email ?? "me",
      sender_address: sender?.email ?? "",
      messages: content.messages.slice(-8),
      ...(target.assessment?.ask ? { ask: target.assessment.ask } : {}),
      ...(preferences.length > 0 ? { preferences } : {}),
      voice,
    });

    // A DRAFT. It lands in the person's Drafts folder and nothing happens until
    // they open it and press Send. The scope cannot send; neither can this.
    const created = await createGmailDraft(
      { credentials, transport: gmailTransport },
      { organization_id: ctx.organizationId, user_id: ctx.userId },
      {
        to: draft.to,
        subject: draft.subject,
        body: draft.body,
        thread_id: target.thread.external_id,
      },
    );

    // Mark it AFTER the draft exists. If Gmail refused, the obligation stays
    // pending and the person sees it again, rather than a "drafted" that
    // points at nothing.
    await setObligationOutcome(sql, ctx, id, "drafted");
    // Recorded so the next sync can match it to what was actually sent.
    await recordDraft(sql, ctx, {
      obligation_id: id,
      thread_id: target.thread.id,
      gmail_draft_id: created.draft_id,
      subject: draft.subject,
      body_ciphertext: encryptBody(draft.body, master, ctx),
      body_chars: draft.body.length,
      composer: draft.composer,
      model_alias: draft.model_alias,
      fallback_reason: draft.fallback_reason,
    });
    return {
      obligation_id: id,
      draft_id: created.draft_id,
      to: draft.to,
      subject: draft.subject,
      composer: draft.composer,
      ...(draft.fallback_reason ? { fallback_reason: draft.fallback_reason } : {}),
    };
  });
}
