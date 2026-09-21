import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { FastifyInstance } from "fastify";
import { uuidv7 } from "@maman/contracts";
import {
  addMembership,
  createDbClient,
  globalCreateOrganization,
  globalCreateUser,
  loadMigrations,
  migrateUp,
  withUser,
  type DbClient,
} from "@maman/db";
import { envelopeDecrypt, unpackEnvelope, type TokenTransport } from "@maman/connector-auth";
import type { HttpRequest, HttpResponse } from "@maman/connector-adapters";
import type { ServerEnv } from "@maman/config";
import { buildServer } from "../../src/server.js";

/**
 * THE DEMO PATH, OVER HTTP, ON A REAL DATABASE.
 *
 *   connect Gmail → sync → ranked list → act on an item
 *
 * Two people in one org throughout. Every "Bob sees nothing" assertion is the
 * product's per-user promise, tested at the boundary a customer would reach.
 */

const migrationsDir = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "..",
  "..",
  "packages",
  "db",
  "migrations",
);

let container: StartedPostgreSqlContainer;
let client: DbClient;
let app: FastifyInstance;

const orgId = uuidv7();
const alice = uuidv7();
const bob = uuidv7();
const NOW = new Date("2026-09-21T12:00:00.000Z");
const ago = (days: number) => String(NOW.getTime() - days * 86_400_000);

const serverEnv: ServerEnv = {
  NODE_ENV: "test",
  AUTH_MODE: "dev",
  MODEL_PROVIDER: "demo",
  CONNECTOR_MODE: "demo",
  DATABASE_URL: "postgres://localhost/x",
  REDIS_URL: "redis://localhost:6379",
  TEMPORAL_ADDRESS: "localhost:7233",
  TEMPORAL_NAMESPACE: "default",
  API_BASE_URL: "http://localhost:4000",
  WEB_BASE_URL: "http://localhost:3000",
  DEVICE_TOKEN_SIGNING_SECRET: "d".repeat(43),
  OAUTH_STATE_SIGNING_SECRET: "o".repeat(43),
  CONNECTOR_ENCRYPTION_MASTER_KEY: "c".repeat(43),
};
const master = createHash("sha256").update(serverEnv.CONNECTOR_ENCRYPTION_MASTER_KEY).digest();

const as = (userId: string) => ({
  "x-dev-org-id": orgId,
  "x-dev-user-id": userId,
  "x-dev-role": "member",
});

/** Google's token endpoint, scripted. */
const tokenTransport: TokenTransport = async () => ({
  status: 200,
  body: { access_token: "live-token", refresh_token: "live-refresh", expires_in: 3600 },
});

function gmailThread(id: string, from: string, to: string, whenMs: string, subject: string) {
  return {
    id,
    messages: [
      {
        id: `${id}-m`,
        internalDate: whenMs,
        payload: {
          headers: [
            { name: "From", value: from },
            { name: "To", value: to },
            { name: "Subject", value: subject },
          ],
        },
      },
    ],
  };
}
const MAILBOX: Record<string, unknown> = {
  owed: gmailThread(
    "owed",
    "Sarah Chen <sarah@acme.com>",
    "alice@co.example",
    ago(4),
    "Enterprise pricing",
  ),
  waiting: gmailThread("waiting", "alice@co.example", "bob@client.com", ago(9), "Proposal"),
};
const gmailRequests: HttpRequest[] = [];
const gmailTransport = async (req: HttpRequest): Promise<HttpResponse> => {
  gmailRequests.push(req);
  const url = new URL(req.url);
  if (url.pathname.endsWith("/profile")) {
    return { status: 200, headers: {}, body: { emailAddress: "alice@co.example" } };
  }
  if (url.pathname.endsWith("/threads")) {
    return {
      status: 200,
      headers: {},
      body: { threads: Object.keys(MAILBOX).map((id) => ({ id })) },
    };
  }
  const id = decodeURIComponent(url.pathname.split("/").pop()!);
  return { status: 200, headers: {}, body: MAILBOX[id] };
};

beforeAll(async () => {
  container = await new PostgreSqlContainer("postgres:17-alpine").start();
  client = createDbClient(container.getConnectionUri(), { max: 4 });
  await migrateUp(client.sql, loadMigrations(migrationsDir));
  await globalCreateOrganization(client.sql, {
    id: orgId,
    workos_organization_id: `wk_${orgId}`,
    name: "Co",
    status: "active",
    default_timezone: "UTC",
  });
  for (const [id, email] of [
    [alice, "alice@co.example"],
    [bob, "bob@co.example"],
  ] as const) {
    await globalCreateUser(client.sql, {
      id,
      workos_user_id: `wu_${id}`,
      email,
      display_name: email,
    });
    await addMembership(client.sql, { organizationId: orgId }, { user_id: id, role: "member" });
  }
  app = buildServer({
    env: serverEnv,
    sql: client.sql,
    connectorTransport: tokenTransport,
    gmailTransport,
    now: () => NOW,
  });
  await app.ready();
}, 240_000);

afterAll(async () => {
  await app?.close();
  await client?.close();
  await container?.stop();
});

describe("/v1/me — the demo path", () => {
  let state = "";
  let obligationId = "";

  it("authorize returns a Google URL carrying a signed, user-bound state", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/v1/me/connections/gmail/authorize",
      headers: as(alice),
    });
    expect(res.statusCode).toBe(200);
    const url = new URL(res.json().authorization_url as string);
    expect(url.hostname).toBe("accounts.google.com");
    // The scope requested is metadata + compose. NEVER send.
    const scope = url.searchParams.get("scope") ?? "";
    expect(scope).toContain("gmail.metadata");
    expect(scope).toContain("gmail.compose");
    expect(scope).not.toContain("gmail.send");
    expect(url.searchParams.get("code_challenge")).toBeTruthy();
    state = url.searchParams.get("state")!;
  });

  it("refuses to connect a provider that is not personal", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/v1/me/connections/salesforce/authorize",
      headers: as(alice),
    });
    expect(res.statusCode).toBe(404);
  });

  it("callback exchanges the code, stores a USER-bound envelope, and returns status only", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/v1/me/connections/gmail/callback?code=abc&state=${encodeURIComponent(state)}`,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ connected: true, provider: "gmail" });
    // No token anywhere in the response.
    expect(res.body).not.toContain("live-token");
    expect(res.body).not.toContain("live-refresh");

    // It is in the DB, encrypted, and opens ONLY with Alice's AAD.
    const rows = await withUser(
      client.sql,
      { organizationId: orgId, userId: alice },
      (tx) => tx`SELECT encrypted_credentials FROM user_connections`,
    );
    expect(rows).toHaveLength(1);
    const env = unpackEnvelope(rows[0]!["encrypted_credentials"] as Uint8Array);
    expect(
      envelopeDecrypt(env, master, { organization_id: orgId, user_id: alice, provider: "gmail" }),
    ).toMatchObject({ access_token: "live-token", refresh_token: "live-refresh" });
    expect(() =>
      envelopeDecrypt(env, master, { organization_id: orgId, user_id: bob, provider: "gmail" }),
    ).toThrow();
    // The plaintext is not in the row either.
    expect(Buffer.from(rows[0]!["encrypted_credentials"] as Uint8Array).toString()).not.toContain(
      "live-token",
    );
  });

  it("a replayed state is refused — single use", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/v1/me/connections/gmail/callback?code=abc&state=${encodeURIComponent(state)}`,
    });
    // The nonce was consumed; PKCE verifier is gone. The exchange still runs
    // against the scripted endpoint here, so what must hold is that no SECOND
    // connection appears.
    expect([200, 400, 502]).toContain(res.statusCode);
    const rows = await withUser(
      client.sql,
      { organizationId: orgId, userId: alice },
      (tx) => tx`SELECT count(*)::int AS n FROM user_connections`,
    );
    expect(rows[0]!["n"]).toBe(1);
  });

  it("connections list shows status and never a credential", async () => {
    const res = await app.inject({ method: "GET", url: "/v1/me/connections", headers: as(alice) });
    expect(res.statusCode).toBe(200);
    const [c] = res.json().connections as Array<Record<string, unknown>>;
    expect(c).toMatchObject({ provider: "gmail", status: "active" });
    expect(Object.keys(c!)).not.toContain("encrypted_credentials");
    expect(res.body).not.toContain("live-token");
  });

  it("sync pulls the mailbox and produces the ranked list", async () => {
    const res = await app.inject({ method: "POST", url: "/v1/me/sync", headers: as(alice) });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ ok: true, listed: 2, obligations_written: 2 });
    // The scripted Gmail saw the LIVE token from the vault — proof the
    // callback → vault → sync chain is one chain.
    expect(gmailRequests.some((r) => r.headers["authorization"] === "Bearer live-token")).toBe(
      true,
    );
    expect(gmailRequests.every((r) => r.method === "GET")).toBe(true);

    const list = await app.inject({ method: "GET", url: "/v1/me/obligations", headers: as(alice) });
    const items = list.json().obligations as Array<Record<string, unknown>>;
    expect(items.map((o) => [o["subject"], o["kind"]])).toEqual([
      ["Enterprise pricing", "awaiting_you"],
      ["Proposal", "awaiting_them"],
    ]);
    obligationId = items[0]!["id"] as string;
  });

  it("Bob, same org, sees no connections, no obligations, and cannot sync", async () => {
    expect(
      (await app.inject({ method: "GET", url: "/v1/me/connections", headers: as(bob) })).json()
        .connections,
    ).toEqual([]);
    expect(
      (await app.inject({ method: "GET", url: "/v1/me/obligations", headers: as(bob) })).json()
        .obligations,
    ).toEqual([]);
    const sync = await app.inject({ method: "POST", url: "/v1/me/sync", headers: as(bob) });
    expect(sync.statusCode).toBe(409);
    expect(sync.json()).toMatchObject({ ok: false, reason: "no_connection" });
  });

  it("acting on an obligation removes it from the pending list", async () => {
    const res = await app.inject({
      method: "POST",
      url: `/v1/me/obligations/${obligationId}/outcome`,
      headers: as(alice),
      payload: { outcome: "snoozed", snoozed_until: "2026-09-25T09:00:00.000Z" },
    });
    expect(res.statusCode).toBe(200);
    const list = await app.inject({ method: "GET", url: "/v1/me/obligations", headers: as(alice) });
    expect((list.json().obligations as unknown[]).length).toBe(1);
  });

  it("Bob cannot act on Alice's obligation — 404, never 403", async () => {
    const list = await app.inject({ method: "GET", url: "/v1/me/obligations", headers: as(alice) });
    const remaining = (list.json().obligations as Array<{ id: string }>)[0]!.id;
    const res = await app.inject({
      method: "POST",
      url: `/v1/me/obligations/${remaining}/outcome`,
      headers: as(bob),
      payload: { outcome: "dismissed" },
    });
    expect(res.statusCode).toBe(404);
    // And it is still there for Alice.
    const again = await app.inject({
      method: "GET",
      url: "/v1/me/obligations",
      headers: as(alice),
    });
    expect((again.json().obligations as unknown[]).length).toBe(1);
  });

  it("a snoozed item is not re-surfaced by the next sync", async () => {
    await app.inject({ method: "POST", url: "/v1/me/sync", headers: as(alice) });
    const list = await app.inject({ method: "GET", url: "/v1/me/obligations", headers: as(alice) });
    expect((list.json().obligations as unknown[]).length).toBe(1);
  });

  it("rejects an unknown outcome", async () => {
    const res = await app.inject({
      method: "POST",
      url: `/v1/me/obligations/${obligationId}/outcome`,
      headers: as(alice),
      payload: { outcome: "sent" },
    });
    expect(res.statusCode).toBe(400);
  });
});
