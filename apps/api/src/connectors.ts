import { createHash } from "node:crypto";
import type { FastifyInstance } from "fastify";
import type { Sql } from "postgres";
import type { ServerEnv } from "@maman/config";
import { uuidv7 } from "@maman/contracts";
import {
  buildAuthorizationUrl,
  envelopeEncrypt,
  exchangeCode,
  generatePkce,
  getProvider,
  PROVIDERS,
  signState,
  verifyState,
  type TokenTransport,
} from "@maman/connector-auth";
import {
  disconnectConnector,
  getConnectorSecret,
  listConnectorAccounts,
  upsertConnectorAccount,
} from "@maman/db";
import { requirePrincipal } from "./auth.js";
import { authorize } from "./authorization.js";

/**
 * Connector Broker routes (spec §17 + Capability Mesh). OAuth 2.0 auth-code +
 * PKCE via the system browser. Tokens are envelope-encrypted server-side and
 * NEVER returned to the desktop client or extension — every response is a
 * status view. Disconnect pauses dependent agents.
 */

// PKCE verifiers live server-side keyed by the signed state nonce, cleared on
// callback. In production this is a short-TTL store (Redis); demo uses memory.
const pkceStore = new Map<string, string>();

function realTransport(): TokenTransport {
  return async (tokenEndpoint, form) => {
    const res = await fetch(tokenEndpoint, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(form).toString(),
    });
    return { status: res.status, body: await res.json().catch(() => ({})) };
  };
}

export function registerConnectorRoutes(
  app: FastifyInstance,
  deps: { env: ServerEnv; sql?: Sql | undefined; transport?: TokenTransport },
): void {
  const { env } = deps;
  const master = Buffer.from(
    createHash("sha256").update(env.CONNECTOR_ENCRYPTION_MASTER_KEY).digest(),
  );

  app.get("/v1/connectors", { schema: { tags: ["connectors"] } }, async (req, reply) => {
    const principal = await requirePrincipal(req, reply);
    if (!principal) return;
    const providers = Object.values(PROVIDERS).map((p) => ({
      id: p.id,
      display_name: p.display_name,
      scopes: p.scopes,
      supports_pkce: p.supports_pkce,
    }));
    if (!deps.sql) return { providers, connected: [] };
    const connected = await listConnectorAccounts(deps.sql, {
      organizationId: principal.organization_id,
    });
    return { providers, connected };
  });

  app.post("/v1/connectors/:provider/authorize", async (req, reply) => {
    const principal = await requirePrincipal(req, reply);
    if (!principal) return;
    if (!authorize(principal, "connectors.manage_own").allowed) {
      return reply.status(403).send({ status: 403, title: "Forbidden" });
    }
    const provider = (req.params as { provider: string }).provider;
    const config = getProvider(provider);
    if (!config) return reply.status(404).send({ status: 404 });

    const redirectUri = `${env.API_BASE_URL}/v1/connectors/${provider}/callback`;
    const nonce = uuidv7();
    const state = signState(
      {
        organization_id: principal.organization_id,
        user_id: principal.user_id,
        provider,
        redirect_uri: redirectUri,
        nonce,
        issued_at_ms: Date.now(),
      },
      env.OAUTH_STATE_SIGNING_SECRET,
    );
    let challenge: string | undefined;
    if (config.supports_pkce) {
      const pkce = generatePkce();
      pkceStore.set(nonce, pkce.verifier);
      challenge = pkce.challenge;
    }
    const clientId = clientIdFor(provider, env) ?? "demo-client-id";
    const url = buildAuthorizationUrl({
      provider,
      client_id: clientId,
      redirect_uri: redirectUri,
      state,
      ...(challenge ? { pkce_challenge: challenge } : {}),
    });
    // The desktop opens this in the system browser. Tokens never touch it.
    // Demo mode: no provider to consent at; land on our own callback instead.
    const demoUrl = `${redirectUri}?code=demo&state=${encodeURIComponent(state)}`;
    return {
      authorization_url: env.CONNECTOR_MODE === "demo" ? demoUrl : url,
      expires_in_seconds: 600,
    };
  });

  app.get("/v1/connectors/:provider/callback", async (req, reply) => {
    const provider = (req.params as { provider: string }).provider;
    const query = req.query as { code?: string; state?: string };
    if (!query.code || !query.state) return reply.status(400).send({ status: 400 });

    const verified = verifyState(query.state, env.OAUTH_STATE_SIGNING_SECRET, Date.now());
    if (!verified.valid) {
      return reply.status(400).send({ status: 400, detail: verified.reason });
    }
    const payload = verified.payload;
    if (payload.provider !== provider) return reply.status(400).send({ status: 400 });
    if (!deps.sql) return reply.status(503).send({ status: 503 });

    const verifier = pkceStore.get(payload.nonce);
    pkceStore.delete(payload.nonce); // single use
    // A PKCE provider with no verifier on file means this state was already
    // spent (or minted by another process). Refuse rather than exchange
    // without the proof.
    if (getProvider(provider)!.supports_pkce && !verifier) {
      return reply.redirect(landing(env, provider, { error: "state_reused" }), 303);
    }

    const result = await exchangeCode(
      {
        provider,
        client_id: clientIdFor(provider, env) ?? "demo-client-id",
        ...(clientSecretFor(provider, env)
          ? { client_secret: clientSecretFor(provider, env)! }
          : {}),
        code: query.code,
        redirect_uri: payload.redirect_uri,
        ...(verifier ? { pkce_verifier: verifier } : {}),
      },
      deps.transport ?? realTransport(),
    );
    if (!result.ok) {
      // The browser is mid-flow: land it back on the web app with a reason
      // it can show, never on a JSON error page. The reason names the step,
      // not the token.
      return reply.redirect(landing(env, provider, { error: "exchange_failed" }), 303);
    }

    // Envelope-encrypt and store; the plaintext token dies with this scope.
    // Salesforce returns a per-org `instance_url` alongside the token (the token
    // response schema is passthrough, so it survives on the parsed object); it
    // is required for every subsequent REST call and is stored encrypted too.
    const rawTokens = result.tokens as typeof result.tokens & { instance_url?: string };
    const envelope = envelopeEncrypt(
      {
        access_token: result.tokens.access_token,
        refresh_token: result.tokens.refresh_token,
        ...(rawTokens.instance_url ? { instance_url: rawTokens.instance_url } : {}),
        ...(result.tokens.scope ? { scope: result.tokens.scope } : {}),
      },
      master,
      { organization_id: payload.organization_id, provider },
    );
    const accountHash = createHash("sha256")
      .update(`${payload.organization_id}:${provider}:${result.tokens.access_token}`)
      .digest("hex")
      .slice(0, 32);
    const view = await upsertConnectorAccount(
      deps.sql,
      { organizationId: payload.organization_id },
      {
        id: uuidv7(),
        organization_id: payload.organization_id,
        owner_user_id: payload.user_id,
        provider,
        external_account_id_hash: accountHash,
        display_label: getProvider(provider)!.display_name,
        scopes: getProvider(provider)!.scopes,
        status: "connected",
        encrypted_token_ciphertext: envelope.ciphertext,
        encrypted_data_key: envelope.encrypted_data_key,
        token_key_version: envelope.key_version,
        ...(result.tokens.expires_in
          ? { expires_at: new Date(Date.now() + result.tokens.expires_in * 1000).toISOString() }
          : {}),
        last_verified_at: new Date().toISOString(),
      },
    );
    // The browser arrived here from the provider's consent screen; send it
    // home to the Connections page. The URL carries the provider and nothing
    // else — no token, no id.
    void view;
    return reply.redirect(landing(env, provider, { connected: true }), 303);
  });

  app.post("/v1/connectors/:provider/disconnect", async (req, reply) => {
    const principal = await requirePrincipal(req, reply);
    if (!principal) return;
    if (!authorize(principal, "connectors.manage_own").allowed) {
      return reply.status(403).send({ status: 403 });
    }
    if (!deps.sql) return reply.status(503).send({ status: 503 });
    const provider = (req.params as { provider: string }).provider;
    const result = await disconnectConnector(
      deps.sql,
      { organizationId: principal.organization_id },
      provider,
    );
    return result;
  });

  app.post("/v1/connectors/:provider/test", async (req, reply) => {
    const principal = await requirePrincipal(req, reply);
    if (!principal) return;
    if (!deps.sql) return { healthy: false, reason: "database unavailable" };
    const provider = (req.params as { provider: string }).provider;
    const secret = await getConnectorSecret(
      deps.sql,
      { organizationId: principal.organization_id },
      provider,
    );
    // Health is derived from stored metadata; the token is never returned.
    if (!secret) return { healthy: false, reason: "not connected" };
    return { healthy: secret.status === "connected", status: secret.status };
  });
}

function clientIdFor(provider: string, env: ServerEnv): string | undefined {
  if (provider === "salesforce") return env.SALESFORCE_CLIENT_ID;
  if (provider.startsWith("google") || provider === "gmail") return env.GOOGLE_CLIENT_ID;
  return undefined;
}
function clientSecretFor(provider: string, env: ServerEnv): string | undefined {
  if (provider === "salesforce") return env.SALESFORCE_CLIENT_SECRET;
  if (provider.startsWith("google") || provider === "gmail") return env.GOOGLE_CLIENT_SECRET;
  return undefined;
}

/** Where a browser lands after an OAuth round-trip: the web app's Connections page. */
export function landing(
  env: ServerEnv,
  provider: string,
  outcome: { connected: true } | { error: string },
): string {
  const url = new URL("/connections", env.WEB_BASE_URL);
  url.searchParams.set("provider", provider);
  if ("connected" in outcome) url.searchParams.set("connected", "1");
  else url.searchParams.set("error", outcome.error);
  return url.toString();
}
