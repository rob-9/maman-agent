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
import { fetchTransport, type HttpTransport } from "@maman/connector-adapters";
import {
  createUserConnection,
  listPendingObligations,
  listUserConnections,
  setObligationOutcome,
  type UserContext,
} from "@maman/db";
import { createUserVaultCredentialProvider, runGmailSyncJob } from "@maman/sync";
import { requirePrincipal } from "./auth.js";
import { authorize } from "./authorization.js";

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
  now?: () => Date;
};

export function registerWorkspaceRoutes(app: FastifyInstance, deps: WorkspaceRouteDeps): void {
  const { env } = deps;
  const master = Buffer.from(
    createHash("sha256").update(env.CONNECTOR_ENCRYPTION_MASTER_KEY).digest(),
  );
  const now = deps.now ?? (() => new Date());
  const tokenTransport = deps.tokenTransport ?? createConnectorTokenTransport();
  const gmailTransport = deps.gmailTransport ?? fetchTransport;

  const clientFor = (provider: string) =>
    provider === "gmail" && env.GOOGLE_CLIENT_ID
      ? {
          client_id: env.GOOGLE_CLIENT_ID,
          ...(env.GOOGLE_CLIENT_SECRET ? { client_secret: env.GOOGLE_CLIENT_SECRET } : {}),
        }
      : null;

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
      if (!result.ok) return reply.status(502).send({ status: 502, detail: result.error });

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
      // STATUS ONLY. No token, no ciphertext.
      return { connected: true, connection_id: created.id, provider };
    },
  );

  // ---- sync ----

  app.post("/v1/me/sync", { schema: { tags: ["me"] } }, async (req, reply) => {
    const principal = await requirePrincipal(req, reply);
    if (!principal) return;
    if (!deps.sql) return reply.status(503).send({ status: 503 });
    const sql = deps.sql;
    const result = await runGmailSyncJob(
      {
        sql,
        credentials: createUserVaultCredentialProvider({
          sql,
          masterKey: master,
          transport: tokenTransport,
          clientCredentials: clientFor,
        }),
        transport: gmailTransport,
        now,
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
    return { obligations: await listPendingObligations(deps.sql, userCtx(principal), limit) };
  });

  const outcomeBody = z
    .object({
      outcome: z.enum(["snoozed", "dismissed", "resolved", "drafted"]),
      snoozed_until: z.string().datetime().optional(),
    })
    .strict();

  app.post("/v1/me/obligations/:id/outcome", { schema: { tags: ["me"] } }, async (req, reply) => {
    const principal = await requirePrincipal(req, reply);
    if (!principal) return;
    if (!deps.sql) return reply.status(503).send({ status: 503 });
    const body = outcomeBody.safeParse(req.body);
    if (!body.success) return reply.status(400).send({ status: 400, title: "Bad Request" });
    const id = (req.params as { id: string }).id;
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
    return { id, outcome: body.data.outcome };
  });
}
