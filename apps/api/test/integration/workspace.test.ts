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
  upsertConnectorAccount,
  withUser,
  type DbClient,
} from "@maman/db";
import {
  envelopeDecrypt,
  envelopeEncrypt,
  unpackEnvelope,
  type TokenTransport,
} from "@maman/connector-auth";
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

/** Google's token endpoint, scripted. Flip `tokenEndpointDown` to refuse the exchange. */
let tokenEndpointDown = false;
const tokenTransport: TokenTransport = async () =>
  tokenEndpointDown
    ? { status: 500, body: { error: "server_error" } }
    : {
        status: 200,
        body: { access_token: "live-token", refresh_token: "live-refresh", expires_in: 3600 },
      };

function gmailThread(
  id: string,
  from: string,
  to: string,
  whenMs: string,
  subject: string,
  text?: string,
) {
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
          ...(text
            ? { mimeType: "text/plain", body: { data: Buffer.from(text).toString("base64url") } }
            : {}),
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
    "Thanks Alex. Can you confirm pricing for 60 seats? We need it by Friday.",
  ),
  waiting: gmailThread("waiting", "alice@co.example", "bob@client.com", ago(9), "Proposal"),
};
const gmailRequests: HttpRequest[] = [];
/** Flip to make Gmail refuse the next draft, to prove the failure branch. */
let draftStatus = 200;
const gmailTransport = async (req: HttpRequest): Promise<HttpResponse> => {
  gmailRequests.push(req);
  const url = new URL(req.url);
  if (url.pathname.includes("/calendar/")) {
    return { status: 200, headers: {}, body: { items: [], nextSyncToken: "cal-1" } };
  }
  if (req.method === "POST" && url.pathname.endsWith("/drafts")) {
    return draftStatus === 200
      ? { status: 200, headers: {}, body: { id: "draft-1", message: { id: "msg-1" } } }
      : { status: draftStatus, headers: {}, body: { error: { message: "quota" } } };
  }
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

/** The organization's Salesforce, scripted: Bob is on a $40K open opportunity. */
const crmRequests: HttpRequest[] = [];
const crmTransport = async (req: HttpRequest): Promise<HttpResponse> => {
  crmRequests.push(req);
  return {
    status: 200,
    headers: {},
    body: {
      done: true,
      records: [
        {
          Contact: { Email: "bob@client.com", Account: { Name: "Client Co" } },
          Opportunity: { Amount: 40_000, IsClosed: false },
        },
      ],
    },
  };
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
    crmTransport,
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
    // The scope requested is read-only mail + compose. NEVER send.
    const scope = url.searchParams.get("scope") ?? "";
    expect(scope).toContain("gmail.readonly");
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

  it("callback exchanges the code, stores a USER-bound envelope, and sends the browser home", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/v1/me/connections/gmail/callback?code=abc&state=${encodeURIComponent(state)}`,
    });
    // A browser arrives here from Google; it leaves for the Connections page
    // with the provider and the outcome in the URL — no token, no id.
    expect(res.statusCode).toBe(303);
    expect(res.headers["location"]).toBe(
      "http://localhost:3000/connections?provider=gmail&connected=1",
    );
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

  it("when Google refuses the code exchange, the browser lands home with a reason, nothing stored", async () => {
    const auth = await app.inject({
      method: "POST",
      url: "/v1/me/connections/gmail/authorize",
      headers: as(bob),
    });
    const freshState = new URL(auth.json().authorization_url as string).searchParams.get("state")!;
    tokenEndpointDown = true;
    try {
      const res = await app.inject({
        method: "GET",
        url: `/v1/me/connections/gmail/callback?code=abc&state=${encodeURIComponent(freshState)}`,
      });
      expect(res.statusCode).toBe(303);
      expect(res.headers["location"]).toBe(
        "http://localhost:3000/connections?provider=gmail&error=exchange_failed",
      );
    } finally {
      tokenEndpointDown = false;
    }
    const bobs = await withUser(
      client.sql,
      { organizationId: orgId, userId: bob },
      (tx) => tx`SELECT count(*)::int AS n FROM user_connections`,
    );
    expect(bobs[0]!["n"]).toBe(0);
  });

  it("a replayed state is refused — single use — and stores nothing", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/v1/me/connections/gmail/callback?code=abc&state=${encodeURIComponent(state)}`,
    });
    expect(res.statusCode).toBe(303);
    expect(res.headers["location"]).toBe(
      "http://localhost:3000/connections?provider=gmail&error=state_reused",
    );
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
    // The same Google grant covers the calendar; the step ran on this sync.
    expect(res.json().calendar).toMatchObject({ ok: true });
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

  it("drafting creates a Gmail DRAFT — never a send — and marks the obligation drafted", async () => {
    const list = await app.inject({ method: "GET", url: "/v1/me/obligations", headers: as(alice) });
    const target = (list.json().obligations as Array<{ id: string; subject: string }>)[0]!;
    const before = gmailRequests.length;

    const res = await app.inject({
      method: "POST",
      url: `/v1/me/obligations/${target.id}/draft`,
      headers: as(alice),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      obligation_id: target.id,
      draft_id: "draft-1",
      subject: `Re: ${target.subject}`,
      composer: "deterministic",
    });

    // Exactly one new Gmail call, a POST to /drafts, with the LIVE token, and
    // nothing to any send endpoint.
    const news = gmailRequests.slice(before);
    expect(news).toHaveLength(1);
    expect(news[0]!.method).toBe("POST");
    expect(news[0]!.url).toMatch(/\/drafts$/);
    expect(news[0]!.headers["authorization"]).toBe("Bearer live-token");
    expect(gmailRequests.every((r) => !/\/send\b/.test(r.url))).toBe(true);
    // The draft is filed on the thread it answers.
    const sent = JSON.parse(news[0]!.body!) as { message: { threadId?: string } };
    expect(sent.message.threadId).toBeTruthy();

    // It left the pending list, and the next sync does not bring it back.
    const after = await app.inject({
      method: "GET",
      url: "/v1/me/obligations",
      headers: as(alice),
    });
    expect(
      (after.json().obligations as Array<{ id: string }>).some((o) => o.id === target.id),
    ).toBe(false);
    await app.inject({ method: "POST", url: "/v1/me/sync", headers: as(alice) });
    const again = await app.inject({
      method: "GET",
      url: "/v1/me/obligations",
      headers: as(alice),
    });
    expect(
      (again.json().obligations as Array<{ id: string }>).some((o) => o.id === target.id),
    ).toBe(false);
  });

  it("when Gmail refuses the draft, the obligation STAYS pending — never 'drafted' pointing at nothing", async () => {
    // THE HONEST HALF of "marked after Gmail confirms". Without this branch
    // tested, the claim is a comment.
    //
    // Earlier tests drafted or snoozed everything; put the drafted one back so
    // there is a pending item to fail against.
    await withUser(client.sql, { organizationId: orgId, userId: alice }, async (tx) => {
      await tx`UPDATE obligations SET outcome = 'pending' WHERE outcome = 'drafted'`;
    });
    const list = await app.inject({ method: "GET", url: "/v1/me/obligations", headers: as(alice) });
    expect((list.json().obligations as unknown[]).length).toBeGreaterThan(0);
    const target = (list.json().obligations as Array<{ id: string }>)[0]!;
    draftStatus = 500;
    try {
      const res = await app.inject({
        method: "POST",
        url: `/v1/me/obligations/${target.id}/draft`,
        headers: as(alice),
      });
      expect(res.statusCode).toBeGreaterThanOrEqual(500);
      expect(res.body).not.toContain("live-token");
    } finally {
      draftStatus = 200;
    }
    const after = await app.inject({
      method: "GET",
      url: "/v1/me/obligations",
      headers: as(alice),
    });
    expect(
      (after.json().obligations as Array<{ id: string }>).some((o) => o.id === target.id),
    ).toBe(true);
  });

  it("Bob cannot draft against Alice's obligation — 404", async () => {
    const res = await app.inject({
      method: "POST",
      url: `/v1/me/obligations/${obligationId}/draft`,
      headers: as(bob),
    });
    expect(res.statusCode).toBe(404);
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

describe("with the organization's Salesforce connected — the deal step over HTTP", () => {
  it("sync asks Salesforce about Alice's contacts with the ORG token, and the confirmed deal lands on her list", async () => {
    // The org connects Salesforce (org vault: org-bound AAD, the same key the
    // server derives from CONNECTOR_ENCRYPTION_MASTER_KEY).
    const master = createHash("sha256").update(serverEnv.CONNECTOR_ENCRYPTION_MASTER_KEY).digest();
    const envelope = envelopeEncrypt(
      { access_token: "sf-org-token", instance_url: "https://na1.example.com" },
      master,
      { organization_id: orgId, provider: "salesforce" },
    );
    await upsertConnectorAccount(
      client.sql,
      { organizationId: orgId },
      {
        id: uuidv7(),
        organization_id: orgId,
        provider: "salesforce",
        external_account_id_hash: "sf-hash",
        display_label: "Salesforce",
        scopes: ["api", "refresh_token"],
        status: "connected",
        encrypted_token_ciphertext: envelope.ciphertext,
        encrypted_data_key: envelope.encrypted_data_key,
        token_key_version: envelope.key_version,
      },
    );

    const res = await app.inject({ method: "POST", url: "/v1/me/sync", headers: as(alice) });
    expect(res.statusCode).toBe(200);
    expect(res.json().deals).toEqual({
      ok: true,
      provider: "salesforce",
      asked: 2,
      open: 1,
      closed: 0,
      unknown: 1,
    });
    // Read-only, on the org's instance, with the org's token — not Alice's Gmail token.
    expect(crmRequests).toHaveLength(1);
    expect(crmRequests[0]!.method).toBe("GET");
    expect(crmRequests[0]!.url.startsWith("https://na1.example.com/services/data/")).toBe(true);
    expect(crmRequests[0]!.headers["authorization"]).toBe("Bearer sf-org-token");
    const soql = new URL(crmRequests[0]!.url).searchParams.get("q")!;
    expect(soql).toContain("'bob@client.com'");
    expect(soql).toContain("'sarah@acme.com'");

    const contacts = await withUser(
      client.sql,
      { organizationId: orgId, userId: alice },
      (tx) =>
        tx`SELECT external_id, has_open_deal, open_deal_value, account_name FROM contacts ORDER BY external_id`,
    );
    expect(
      contacts.map((c) => [
        c["external_id"],
        c["has_open_deal"],
        c["open_deal_value"],
        c["account_name"],
      ]),
    ).toEqual([
      ["bob@client.com", true, "40000.00", "Client Co"],
      ["sarah@acme.com", null, null, null], // not in the CRM: unknown, still listed
    ]);
  });

  it("Bob's own sync in the same org asks about HIS contacts, not Alice's", async () => {
    crmRequests.length = 0;
    const res = await app.inject({ method: "POST", url: "/v1/me/sync", headers: as(bob) });
    // Bob has no mailbox connected, so the sync stops before the deal step —
    // and the CRM is never asked on his behalf about anyone.
    expect(res.statusCode).toBe(409);
    expect(crmRequests).toHaveLength(0);
  });
});

describe("AGENT_MODE=assist — the agent pass over HTTP", () => {
  let agentApp: FastifyInstance;
  beforeAll(async () => {
    agentApp = buildServer({
      env: { ...serverEnv, AGENT_MODE: "assist" },
      sql: client.sql,
      connectorTransport: tokenTransport,
      gmailTransport,
      crmTransport,
      now: () => NOW,
    });
    await agentApp.ready();
    // Earlier tests drafted and snoozed Alice's items; the agent should see both pending.
    await withUser(
      client.sql,
      { organizationId: orgId, userId: alice },
      (tx) => tx`UPDATE obligations SET outcome = 'pending', snoozed_until = NULL`,
    );
  });
  afterAll(async () => {
    await agentApp?.close();
  });

  it("sync reads the candidate threads in full and stores a judgment; the list leads with it", async () => {
    gmailRequests.length = 0;
    const res = await agentApp.inject({ method: "POST", url: "/v1/me/sync", headers: as(alice) });
    expect(res.statusCode).toBe(200);
    expect(res.json().agent).toMatchObject({
      considered: 2,
      assessed: 2,
      failed: 0,
      model_alias: "demo",
    });
    // The sync fetched both threads in full and stored them encrypted; the
    // agent read the store, so the pass added no Gmail requests.
    const fetches = gmailRequests.filter((r) => /\/threads\/[^?]+\?/.test(r.url));
    expect(fetches).toHaveLength(2);
    expect(fetches.every((r) => r.method === "GET" && r.url.includes("format=full"))).toBe(true);

    const list = await agentApp.inject({
      method: "GET",
      url: "/v1/me/obligations",
      headers: as(alice),
    });
    expect(list.json().agent_mode).toBe("assist");
    const pricing = (list.json().obligations as Array<Record<string, unknown>>).find(
      (o) => o["subject"] === "Enterprise pricing",
    )!;
    expect(pricing["assessment"]).toMatchObject({
      owed: true,
      ask: "Can you confirm pricing for 60 seats?",
      urgency: "high",
    });
  });

  it("drafts from the stored thread and the person's voice; grounded, recorded, never sent", async () => {
    gmailRequests.length = 0;
    const list = await agentApp.inject({
      method: "GET",
      url: "/v1/me/obligations",
      headers: as(alice),
    });
    const pricing = (list.json().obligations as Array<Record<string, unknown>>).find(
      (o) => o["subject"] === "Enterprise pricing",
    )!;
    const res = await agentApp.inject({
      method: "POST",
      url: `/v1/me/obligations/${pricing["id"]}/draft`,
      headers: as(alice),
    });
    expect(res.statusCode).toBe(200);
    // With the agent on, the configured provider writes (here the demo one,
    // whose draft is grounded by construction), so no fallback was needed.
    expect(res.json()).toMatchObject({ composer: "model", to: "sarah@acme.com" });
    expect(res.json().fallback_reason).toBeUndefined();
    const posted = gmailRequests.find((r) => r.method === "POST")!;
    expect(posted.url.endsWith("/drafts")).toBe(true);
    expect(gmailRequests.filter((r) => r.method === "POST")).toHaveLength(1);
    const raw = JSON.parse(posted.body!) as { message: { raw: string } };
    const mime = Buffer.from(raw.message.raw, "base64url").toString("utf8");
    // The draft answers the actual ask from the thread, in the sender's name.
    expect(mime).toContain("Can you confirm pricing for 60 seats?");
    expect(mime).toContain("alice@co.example");
    // Recorded, encrypted, unmatched until she sends it.
    const drafts = await withUser(
      client.sql,
      { organizationId: orgId, userId: alice },
      (tx) =>
        tx`SELECT composer, matched_at, body_ciphertext::text AS b FROM drafts ORDER BY created_at DESC LIMIT 1`,
    );
    expect(drafts[0]!["composer"]).toBe("model");
    expect(drafts[0]!["matched_at"]).toBeNull();
    expect(String(drafts[0]!["b"])).not.toContain("60 seats");
  });

  it("the same data, with the agent off, is the deterministic list and says so", async () => {
    const list = await app.inject({ method: "GET", url: "/v1/me/obligations", headers: as(alice) });
    expect(list.json().agent_mode).toBe("off");
    // The judgment rides along for display but decides nothing here. (The
    // pricing thread was drafted in the previous test, so it is no longer pending.)
    const subjects = (list.json().obligations as Array<Record<string, unknown>>).map(
      (o) => o["subject"],
    );
    expect(subjects).toContain("Proposal");
  });
});
