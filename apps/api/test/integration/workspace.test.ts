import { createDemoWorld } from "@maman/connector-adapters";
import { encryptBody } from "@maman/sync";
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
  // Real connectors, scripted at the wire by the transports below; the demo
  // world has its own describe at the end.
  CONNECTOR_MODE: "real",
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

/** The organization's Salesforce, scripted: Bob is on a $40K open opportunity; tasks can be written. */
const crmRequests: HttpRequest[] = [];
const sfTasks = new Map<string, Record<string, unknown>>();
const crmTransport = async (req: HttpRequest): Promise<HttpResponse> => {
  crmRequests.push(req);
  const url = new URL(req.url);
  const q = url.searchParams.get("q") ?? "";
  if (q.includes("FROM Contact ")) {
    return q.includes("bob@client.com")
      ? { status: 200, headers: {}, body: { records: [{ Id: "003BOB", AccountId: "001CL" }] } }
      : { status: 200, headers: {}, body: { records: [] } };
  }
  if (q.includes("FROM OpportunityContactRole WHERE ContactId")) {
    return { status: 200, headers: {}, body: { records: [{ OpportunityId: "006DEAL" }] } };
  }
  if (url.pathname.endsWith("/sobjects/Opportunity/006DEAL") && req.method === "GET") {
    return {
      status: 200,
      headers: {},
      body: {
        Id: "006DEAL",
        Name: "Client Co renewal",
        StageName: "Proposal",
        NextStep: null,
        CloseDate: "2026-12-31",
        IsClosed: false,
      },
    };
  }
  if (url.pathname.endsWith("/sobjects/Opportunity/006DEAL") && req.method === "PATCH") {
    return { status: 204, headers: {}, body: "" };
  }
  if (q.includes("Description LIKE")) {
    const m = /'%(\[maman:[^%]+\])%'/.exec(q)?.[1] ?? "";
    const hit = [...sfTasks.values()].find((t) => String(t["Description"]).includes(m));
    return { status: 200, headers: {}, body: { records: hit ? [hit] : [] } };
  }
  if (req.method === "POST" && url.pathname.endsWith("/sobjects/Task")) {
    const id = `00T${sfTasks.size + 1}`;
    sfTasks.set(id, { Id: id, ...(JSON.parse(req.body!) as Record<string, unknown>) });
    return { status: 201, headers: {}, body: { id, success: true } };
  }
  const taskMatch = /\/sobjects\/Task\/([^?]+)/.exec(url.pathname);
  if (taskMatch && req.method === "GET") {
    const t = sfTasks.get(decodeURIComponent(taskMatch[1]!));
    return t ? { status: 200, headers: {}, body: t } : { status: 404, headers: {}, body: {} };
  }
  if (taskMatch && req.method === "DELETE") {
    sfTasks.delete(decodeURIComponent(taskMatch[1]!));
    return { status: 204, headers: {}, body: "" };
  }
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

  it("drafting creates a Gmail DRAFT — never a send — and attaches it to the item, which stays pending", async () => {
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

    // It stays on the list with the draft attached, and the next sync keeps
    // it that way: the draft is waiting until she sends it.
    const after = await app.inject({
      method: "GET",
      url: "/v1/me/obligations",
      headers: as(alice),
    });
    const kept = (after.json().obligations as Array<Record<string, unknown>>).find(
      (o) => o["id"] === target.id,
    )!;
    expect(kept).toBeTruthy();
    expect(kept["draft"]).toMatchObject({
      gmail_draft_id: "draft-1",
      gmail_message_id: "msg-1",
      mode: "manual",
    });
    await app.inject({ method: "POST", url: "/v1/me/sync", headers: as(alice) });
    const again = await app.inject({
      method: "GET",
      url: "/v1/me/obligations",
      headers: as(alice),
    });
    // The sweep rewrites pending rows (new ids); the thread is the stable key.
    const still = (again.json().obligations as Array<Record<string, unknown>>).find(
      (o) => o["thread_id"] === kept["thread_id"],
    )!;
    expect(still["draft"]).toMatchObject({ gmail_draft_id: "draft-1" });
    // The week's numbers count it.
    expect(again.json().drafts_this_week).toMatchObject({ drafted: 1, sent: 0 });
  });

  it("when Gmail refuses the draft, the obligation STAYS pending — never 'drafted' pointing at nothing", async () => {
    // THE HONEST HALF of "marked after Gmail confirms". Without this branch
    // tested, the claim is a comment.
    //
    // Earlier tests drafted or snoozed everything; put the drafted one back so
    // there is a pending item to fail against.
    await withUser(client.sql, { organizationId: orgId, userId: alice }, async (tx) => {
      await tx`UPDATE obligations SET outcome = 'pending' WHERE outcome IN ('drafted', 'snoozed')`;
      await tx`DELETE FROM drafts`;
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
    // And it wrote the drafts for what it judged owed, before anyone asked.
    expect(res.json().predraft).toMatchObject({ drafted: 2, skipped_by_rule: 0, failed: 0 });
    expect(
      gmailRequests.filter((r) => r.method === "POST" && r.url.endsWith("/drafts")),
    ).toHaveLength(2);
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

describe("the intent store over HTTP", () => {
  it("what Alice says is kept in her words, scoped, enforced, and visible only to her", async () => {
    const said = await app.inject({
      method: "POST",
      url: "/v1/me/intents",
      headers: as(alice),
      payload: { text: "Don't chase Bob, procurement is slow." },
    });
    expect(said.statusCode).toBe(200);
    expect(said.json().intent).toMatchObject({
      text: "Don't chase Bob, procurement is slow.",
      is_rule: true,
      // "Bob" names exactly one of her contacts, so the rule is scoped to him.
      scope: { kind: "contact", value: "bob@client.com" },
    });
    const list = await app.inject({ method: "GET", url: "/v1/me/intents", headers: as(alice) });
    expect(list.json().intents).toHaveLength(1);
    // Stored as ciphertext.
    const raw = await withUser(
      client.sql,
      { organizationId: orgId, userId: alice },
      (tx) => tx`SELECT text_ciphertext::text AS t FROM intents`,
    );
    expect(String(raw[0]!["t"])).not.toContain("procurement");
    // Bob sees nothing and cannot retire it.
    const bobs = await app.inject({ method: "GET", url: "/v1/me/intents", headers: as(bob) });
    expect(bobs.json().intents).toEqual([]);
    const id = said.json().intent.id as string;
    expect(
      (await app.inject({ method: "POST", url: `/v1/me/intents/${id}/retire`, headers: as(bob) }))
        .statusCode,
    ).toBe(404);
    expect(
      (await app.inject({ method: "POST", url: `/v1/me/intents/${id}/retire`, headers: as(alice) }))
        .statusCode,
    ).toBe(200);
    expect(
      (await app.inject({ method: "GET", url: "/v1/me/intents", headers: as(alice) })).json()
        .intents,
    ).toEqual([]);
  });

  it("a dismissal with a reason is written down as something the agent noticed", async () => {
    await withUser(
      client.sql,
      { organizationId: orgId, userId: alice },
      (tx) => tx`UPDATE obligations SET outcome = 'pending', snoozed_until = NULL`,
    );
    const list = await app.inject({ method: "GET", url: "/v1/me/obligations", headers: as(alice) });
    const first = (list.json().obligations as Array<Record<string, unknown>>)[0]!;
    const res = await app.inject({
      method: "POST",
      url: `/v1/me/obligations/${first["id"]}/outcome`,
      headers: as(alice),
      payload: { outcome: "dismissed", note: "they already signed" },
    });
    expect(res.statusCode).toBe(200);
    const intents = (
      await app.inject({ method: "GET", url: "/v1/me/intents", headers: as(alice) })
    ).json().intents as Array<Record<string, unknown>>;
    // Earlier tests dismissed things too; the newest entry is this one.
    expect(intents[0]).toMatchObject({ source: "observed", is_rule: false });
    expect(String(intents[0]!["text"])).toContain("they already signed");
    expect(String(intents[0]!["text"])).toContain(String(first["subject"]));
    expect(list.json().skipped).toEqual([]);
  });

  it("rejects an empty or oversized statement", async () => {
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/v1/me/intents",
          headers: as(alice),
          payload: { text: "" },
        })
      ).statusCode,
    ).toBe(400);
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/v1/me/intents",
          headers: as(alice),
          payload: { text: "x".repeat(301) },
        })
      ).statusCode,
    ).toBe(400);
  });
});

describe("the agent acts over HTTP: logging to Salesforce", () => {
  let actionId = "";
  let diffSha = "";

  it("'Log to Salesforce' on a thread the person wrote on proposes the write; nothing is written yet", async () => {
    await withUser(
      client.sql,
      { organizationId: orgId, userId: alice },
      (tx) => tx`UPDATE obligations SET outcome = 'pending', snoozed_until = NULL`,
    );
    const list = await app.inject({ method: "GET", url: "/v1/me/obligations", headers: as(alice) });
    const proposal = (list.json().obligations as Array<Record<string, unknown>>).find(
      (o) => o["subject"] === "Proposal",
    )!;
    const res = await app.inject({
      method: "POST",
      url: `/v1/me/obligations/${proposal["id"]}/log`,
      headers: as(alice),
    });
    expect(res.statusCode).toBe(200);
    actionId = res.json().action.id;
    diffSha = res.json().action.diff_sha256;
    expect(sfTasks.size).toBe(0);
    const actions = await app.inject({ method: "GET", url: "/v1/me/actions", headers: as(alice) });
    expect(actions.json().actions[0]).toMatchObject({
      id: actionId,
      status: "proposed",
      summary: "Log to Salesforce: Email: Proposal",
    });
    // A thread where the other side wrote last has nothing of hers to log.
    const pricing = (list.json().obligations as Array<Record<string, unknown>>).find(
      (o) => o["subject"] === "Enterprise pricing",
    )!;
    expect(
      (
        await app.inject({
          method: "POST",
          url: `/v1/me/obligations/${pricing["id"]}/log`,
          headers: as(alice),
        })
      ).statusCode,
    ).toBe(409);
    // Bob sees no actions and cannot touch hers.
    expect(
      (await app.inject({ method: "GET", url: "/v1/me/actions", headers: as(bob) })).json().actions,
    ).toEqual([]);
    expect(
      (
        await app.inject({
          method: "POST",
          url: `/v1/me/actions/${actionId}/approve`,
          headers: as(bob),
          payload: { diff_sha256: diffSha },
        })
      ).statusCode,
    ).toBe(404);
  });

  it("approval with the wrong hash is refused as stale; with the right one the write lands, verified, with the org token", async () => {
    const stale = await app.inject({
      method: "POST",
      url: `/v1/me/actions/${actionId}/approve`,
      headers: as(alice),
      payload: { diff_sha256: "f".repeat(64) },
    });
    expect(stale.statusCode).toBe(409);
    expect(stale.json().reason).toBe("stale");
    expect(sfTasks.size).toBe(0);
    // Propose again (the stale one is spent).
    const list = await app.inject({ method: "GET", url: "/v1/me/obligations", headers: as(alice) });
    const proposal = (list.json().obligations as Array<Record<string, unknown>>).find(
      (o) => o["subject"] === "Proposal",
    )!;
    const again = await app.inject({
      method: "POST",
      url: `/v1/me/obligations/${proposal["id"]}/log`,
      headers: as(alice),
    });
    actionId = again.json().action.id;
    diffSha = again.json().action.diff_sha256;
    crmRequests.length = 0;
    const ok = await app.inject({
      method: "POST",
      url: `/v1/me/actions/${actionId}/approve`,
      headers: as(alice),
      payload: { diff_sha256: diffSha },
    });
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toMatchObject({ status: "verified", verified: true, external_id: "00T1" });
    expect(sfTasks.get("00T1")).toMatchObject({
      WhoId: "003BOB",
      WhatId: "006DEAL",
      Status: "Completed",
    });
    expect(crmRequests.every((r) => r.headers["authorization"] === "Bearer sf-org-token")).toBe(
      true,
    );
    // Read back through a GET on the task, not the create's answer.
    expect(
      crmRequests.some((r) => r.method === "GET" && /\/sobjects\/Task\/00T1/.test(r.url)),
    ).toBe(true);
  });

  it("undo deletes it; 'always' becomes a standing instruction the person can see", async () => {
    const undo = await app.inject({
      method: "POST",
      url: `/v1/me/actions/${actionId}/revert`,
      headers: as(alice),
    });
    expect(undo.statusCode).toBe(200);
    expect(undo.json().status).toBe("reverted");
    expect(sfTasks.has("00T1")).toBe(false);
    const always = await app.inject({
      method: "POST",
      url: `/v1/me/actions/${actionId}/always`,
      headers: as(alice),
    });
    expect(always.statusCode).toBe(200);
    const intents = (
      await app.inject({ method: "GET", url: "/v1/me/intents", headers: as(alice) })
    ).json().intents as Array<Record<string, unknown>>;
    expect(intents[0]).toMatchObject({
      is_rule: true,
      text: "Always log the emails I send to Salesforce, without asking.",
    });
  });
});

describe("the agent acts over HTTP: what the thread says about the deal", () => {
  it("'Update Salesforce' on a card proposes the fields the thread states, with the sentences, for approval", async () => {
    await withUser(
      client.sql,
      { organizationId: orgId, userId: alice },
      (tx) => tx`UPDATE obligations SET outcome = 'pending', snoozed_until = NULL`,
    );
    await withUser(
      client.sql,
      { organizationId: orgId, userId: alice },
      (tx) => tx`UPDATE contacts SET has_open_deal = true WHERE external_id = 'bob@client.com'`,
    );
    // Bob's thread now says what happens next.
    MAILBOX["waiting"] = gmailThread(
      "waiting",
      "bob@client.com",
      "alice@co.example",
      ago(5),
      "Proposal",
      "Next step: send the signed order form. Let's close by end of quarter.",
    );
    await app.inject({ method: "POST", url: "/v1/me/sync", headers: as(alice) });
    const list = await app.inject({
      method: "GET",
      url: "/v1/me/obligations",
      headers: as(alice),
    });
    const proposal = (list.json().obligations as Array<Record<string, unknown>>).find(
      (o) => o["subject"] === "Proposal",
    )!;
    const res = await app.inject({
      method: "POST",
      url: `/v1/me/obligations/${proposal["id"]}/update-crm`,
      headers: as(alice),
    });
    expect(res.statusCode).toBe(200);
    const actions = (
      await app.inject({ method: "GET", url: "/v1/me/actions", headers: as(alice) })
    ).json().actions as Array<Record<string, unknown>>;
    const update = actions.find(
      (a) => a["kind"] === "salesforce.update_opportunity" && a["status"] === "proposed",
    )!;
    expect(update).toMatchObject({ can_promote: false });
    expect(String(update["summary"])).toContain('next step "send the signed order form"');
    expect(update["quotes"]).toEqual([
      "Next step: send the signed order form.",
      "Let's close by end of quarter.",
    ]);
    expect(update["changes"]).toEqual([
      { field: "next_step", from: null, to: "send the signed order form" },
      { field: "close_date", from: "2026-12-31", to: "2026-09-30" },
    ]);
    expect(update["record"]).toBe("Client Co renewal");
  });
});

describe("the event stream over HTTP", () => {
  it("a sync derives the person's events; they read their own and a colleague reads none", async () => {
    const sync = await app.inject({ method: "POST", url: "/v1/me/sync", headers: as(alice) });
    expect(sync.statusCode).toBe(200);
    expect(sync.json().events).toMatchObject({ refused: null });
    const mine = await app.inject({
      method: "GET",
      url: "/v1/me/events?limit=100",
      headers: as(alice),
    });
    expect(mine.statusCode).toBe(200);
    const events = mine.json().events as Array<Record<string, unknown>>;
    expect(events.length).toBeGreaterThan(0);
    for (const e of events) {
      expect(e["user_id"]).toBe(alice);
      expect(JSON.stringify(e)).not.toContain("@");
    }
    const theirs = await app.inject({ method: "GET", url: "/v1/me/events", headers: as(bob) });
    expect(theirs.json().events).toEqual([]);
  });

  it("with the stream switched off a sync derives nothing", async () => {
    const off = buildServer({
      env: { ...serverEnv, EVENT_STREAM: "off" },
      sql: client.sql,
      connectorTransport: tokenTransport,
      gmailTransport,
      crmTransport,
      now: () => NOW,
    });
    await off.ready();
    const sync = await off.inject({ method: "POST", url: "/v1/me/sync", headers: as(alice) });
    expect(sync.statusCode).toBe(200);
    expect(sync.json().events).toBeNull();
    await off.close();
  });
});

describe("routines over HTTP", () => {
  it("lists what discovery found for the person, takes their word on one, and shows a colleague none", async () => {
    const sync = await app.inject({ method: "POST", url: "/v1/me/sync", headers: as(alice) });
    expect(sync.statusCode).toBe(200);
    expect(sync.json().discovery).not.toBeNull();
    const list = await app.inject({ method: "GET", url: "/v1/me/routines", headers: as(alice) });
    expect(list.statusCode).toBe(200);
    const routines = list.json().routines as Array<Record<string, unknown>>;
    for (const r of routines) {
      expect(JSON.stringify(r)).not.toContain("@");
      expect(Array.isArray(r["steps"])).toBe(true);
    }
    if (routines.length > 0) {
      const id = routines[0]!["id"] as string;
      const bad = await app.inject({
        method: "POST",
        url: `/v1/me/routines/${id}/decide`,
        headers: as(alice),
        payload: { decision: "maybe" },
      });
      expect(bad.statusCode).toBe(400);
      const ok = await app.inject({
        method: "POST",
        url: `/v1/me/routines/${id}/decide`,
        headers: as(alice),
        payload: { decision: "dismissed" },
      });
      expect(ok.statusCode).toBe(200);
      expect(ok.json().routine.decision).toBe("dismissed");
      // Accepting is for a routine that cleared every bar; a forming one is refused.
      const forming = routines.find((r) => r["status"] === "candidate");
      if (forming) {
        const refused = await app.inject({
          method: "POST",
          url: `/v1/me/routines/${forming["id"]}/decide`,
          headers: as(alice),
          payload: { decision: "accepted" },
        });
        expect(refused.statusCode).toBe(409);
        expect(refused.json().reason).toBe("not_eligible");
      }
      const theirs = await app.inject({
        method: "POST",
        url: `/v1/me/routines/${id}/decide`,
        headers: as(bob),
        payload: { decision: "accepted" },
      });
      expect(theirs.statusCode).toBe(404);
    }
    const none = await app.inject({ method: "GET", url: "/v1/me/routines", headers: as(bob) });
    expect(none.json().routines).toEqual([]);
    // Start is for an accepted routine whose shadow runs agreed; anything else is refused.
    if (routines.length > 0) {
      const start = await app.inject({
        method: "POST",
        url: `/v1/me/routines/${routines[0]!["id"]}/start`,
        headers: as(alice),
      });
      expect(start.statusCode).toBe(409);
      expect(start.json().reason).toBe("not_accepted");
    }
    const unknown = await app.inject({
      method: "POST",
      url: `/v1/me/routines/${uuidv7()}/start`,
      headers: as(alice),
    });
    expect(unknown.statusCode).toBe(404);
  });
});

describe("demo mode: the whole product on a machine with no credentials", () => {
  const carol = uuidv7();
  let demoApp: FastifyInstance;
  beforeAll(async () => {
    await globalCreateUser(client.sql, {
      id: carol,
      workos_user_id: `wu_${carol}`,
      email: "carol@co.example",
      display_name: "Carol",
    });
    await addMembership(client.sql, { organizationId: orgId }, { user_id: carol, role: "member" });
    const world = createDemoWorld({ now: () => NOW });
    demoApp = buildServer({
      env: { ...serverEnv, CONNECTOR_MODE: "demo", AGENT_MODE: "assist" },
      sql: client.sql,
      connectorTransport: world.token,
      gmailTransport: world.transport,
      crmTransport: world.transport,
      now: () => NOW,
    });
    await demoApp.ready();
  });
  afterAll(async () => {
    await demoApp?.close();
  });

  it("'Connect Google' lands on our own callback with a demo code; the same exchange and storage run; the Inbox fills from the scripted mailbox", async () => {
    const start = await demoApp.inject({
      method: "POST",
      url: "/v1/me/connections/gmail/authorize",
      headers: as(carol),
    });
    expect(start.statusCode).toBe(200);
    const url = new URL(start.json().authorization_url as string);
    expect(url.pathname).toBe("/v1/me/connections/gmail/callback");
    expect(url.searchParams.get("code")).toBe("demo");
    const back = await demoApp.inject({ method: "GET", url: url.pathname + url.search });
    expect(back.statusCode).toBe(303);
    expect(back.headers.location).toContain("connected=1");

    const org = await demoApp.inject({
      method: "POST",
      url: "/v1/connectors/salesforce/authorize",
      headers: as(carol),
    });
    const orgUrl = new URL(org.json().authorization_url as string);
    const orgBack = await demoApp.inject({ method: "GET", url: orgUrl.pathname + orgUrl.search });
    expect(orgBack.statusCode).toBe(303);

    const sync = await demoApp.inject({ method: "POST", url: "/v1/me/sync", headers: as(carol) });
    expect(sync.statusCode).toBe(200);
    expect(sync.json()).toMatchObject({ ok: true, listed: 8 });
    expect(sync.json().agent.assessed).toBeGreaterThan(0);
    expect(sync.json().opportunity.proposed).toBeGreaterThanOrEqual(1);
    expect(sync.json().discovery.eligible).toBeGreaterThanOrEqual(1);

    const list = await demoApp.inject({
      method: "GET",
      url: "/v1/me/obligations",
      headers: as(carol),
    });
    const items = list.json().obligations as Array<Record<string, unknown>>;
    expect(items.length).toBeGreaterThanOrEqual(3);
    expect(items.some((o) => o["subject"] === "Re: Enterprise pricing" && o["draft"])).toBe(true);
    const actions = (
      await demoApp.inject({ method: "GET", url: "/v1/me/actions", headers: as(carol) })
    ).json().actions as Array<Record<string, unknown>>;
    expect(actions.some((a) => String(a["summary"]).includes("send over the MSA for legal"))).toBe(
      true,
    );
    const routines = (
      await demoApp.inject({ method: "GET", url: "/v1/me/routines", headers: as(carol) })
    ).json().routines as Array<Record<string, unknown>>;
    const found = routines.find((r) => r["status"] === "eligible")!;
    expect(found["title"]).toBe("You write to them, they reply, you reply, you meet, they reply");
  });

  it("with real connectors the authorize URL goes to the provider, not to us", async () => {
    const start = await app.inject({
      method: "POST",
      url: "/v1/me/connections/gmail/authorize",
      headers: as(alice),
    });
    const url = new URL(start.json().authorization_url as string);
    expect(url.hostname).not.toBe("localhost");
    expect(url.searchParams.get("code")).toBeNull();
  });
});

describe("what the agent inferred, over HTTP", () => {
  it("a proposed entry can be kept once; an active one cannot be 'kept'; the list says which is which", async () => {
    await withUser(
      client.sql,
      { organizationId: orgId, userId: alice },
      (tx) => tx`
      INSERT INTO intents (id, organization_id, owner_user_id, text_ciphertext, text_chars, source, status, scope_kind, scope_value, rule, origin)
      VALUES (${uuidv7()}, ${orgId}, ${alice}, ${encryptBody("Don't chase Bob.", master, { organizationId: orgId, userId: alice })}, 16, 'inferred', 'proposed', 'contact', 'bob@client.com',
              ${JSON.stringify({ kind: "no_chase", scope: { kind: "contact", value: "bob@client.com" } })}::jsonb,
              ${JSON.stringify({ evidence: "You set aside 2 follow-ups with Bob." })}::jsonb)
    `,
    );
    const list = await app.inject({ method: "GET", url: "/v1/me/intents", headers: as(alice) });
    const intents = list.json().intents as Array<Record<string, unknown>>;
    const guess = intents.find((i) => i["status"] === "proposed")!;
    expect(guess["evidence"]).toBe("You set aside 2 follow-ups with Bob.");
    const keep = await app.inject({
      method: "POST",
      url: `/v1/me/intents/${guess["id"]}/keep`,
      headers: as(alice),
    });
    expect(keep.statusCode).toBe(200);
    const again = await app.inject({
      method: "POST",
      url: `/v1/me/intents/${guess["id"]}/keep`,
      headers: as(alice),
    });
    expect(again.statusCode).toBe(404);
    const theirs = await app.inject({
      method: "POST",
      url: `/v1/me/intents/${guess["id"]}/keep`,
      headers: as(bob),
    });
    expect(theirs.statusCode).toBe(404);
  });
});
