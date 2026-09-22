import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { randomBytes } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { uuidv7 } from "@maman/contracts";
import {
  addMembership,
  createDbClient,
  globalCreateOrganization,
  globalCreateUser,
  listPendingObligations,
  loadMigrations,
  migrateUp,
  withUser,
  type DbClient,
} from "@maman/db";
import { envelopeEncrypt, packEnvelope } from "@maman/connector-auth";
import type { DealSource, HttpRequest, HttpResponse } from "@maman/connector-adapters";
import { createUserVaultCredentialProvider } from "../../src/user-vault-credentials.js";
import { runGmailSyncJob } from "../../src/sync-gmail.js";

/**
 * THE SLICE, END TO END, ON A REAL DATABASE.
 *
 * A scripted Gmail, a real vault (envelope-encrypted, user-bound AAD), the
 * real repository under real RLS, the real detector. Nothing mocked that
 * carries a correctness property. The only fake is the network.
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
const master = randomBytes(32);
const orgId = uuidv7();
const alice = uuidv7();
const bob = uuidv7();
const NOW = new Date("2026-09-21T12:00:00.000Z");
const ago = (days: number) => String(NOW.getTime() - days * 86_400_000);

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

/** Alice's mailbox: one thread she owes a reply on, one she's waiting on, one fresh. */
const MAILBOX: Record<string, unknown> = {
  owed: gmailThread(
    "owed",
    "Sarah Chen <sarah@acme.com>",
    "alice@co.example",
    ago(4),
    "Enterprise pricing",
  ),
  waiting: gmailThread("waiting", "alice@co.example", "bob@client.com", ago(9), "Proposal"),
  fresh: gmailThread("fresh", "alice@co.example", "dan@client.com", ago(1), "Intro"),
};

const transport = async (req: HttpRequest): Promise<HttpResponse> => {
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

async function seedUser(id: string, email: string) {
  await globalCreateUser(client.sql, {
    id,
    workos_user_id: `wu_${id}`,
    email,
    display_name: email,
  });
  await addMembership(client.sql, { organizationId: orgId }, { user_id: id, role: "member" });
}

async function linkGmail(userId: string, label: string) {
  const packed = packEnvelope(
    envelopeEncrypt({ access_token: "tok", refresh_token: "ref" }, master, {
      organization_id: orgId,
      user_id: userId,
      provider: "gmail",
    }),
  );
  const connId = uuidv7();
  await withUser(client.sql, { organizationId: orgId, userId }, async (tx) => {
    await tx`
      INSERT INTO user_connections
        (id, organization_id, owner_user_id, provider, external_account_label,
         encrypted_credentials, scopes, status)
      VALUES (${connId}, ${orgId}, ${userId}, 'gmail', ${label}, ${packed},
              ARRAY['gmail.metadata'], 'active')
    `;
  });
  return connId;
}

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
  await seedUser(alice, "alice@co.example");
  await seedUser(bob, "bob@co.example");
  await linkGmail(alice, "alice@co.example");
}, 240_000);

afterAll(async () => {
  await client?.close();
  await container?.stop();
});

const deps = () => ({
  sql: client.sql,
  credentials: createUserVaultCredentialProvider({
    sql: client.sql,
    masterKey: master,
    transport: async () => ({ status: 500, body: {} }),
    clientCredentials: () => ({ client_id: "x" }),
  }),
  transport,
  now: () => NOW,
});

describe("Gmail sync job — the L1 slice on a real database", () => {
  it("syncs a mailbox and produces a ranked, explained obligation list", async () => {
    const result = await runGmailSyncJob(deps(), { organizationId: orgId, userId: alice });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.listed).toBe(3);
    expect(result.threads_upserted).toBe(3);
    expect(result.contacts_upserted).toBe(3);
    // "fresh" is 1 day old on an outbound thread — below the 5-day threshold.
    expect(result.obligations_written).toBe(2);

    const list = await listPendingObligations(client.sql, { organizationId: orgId, userId: alice });
    expect(list.map((o) => [o.subject, o.kind])).toEqual([
      ["Enterprise pricing", "awaiting_you"], // they wrote; Alice owes a reply — ranks first
      ["Proposal", "awaiting_them"],
    ]);
    expect(list[0]!.contact_display_name).toBe("Sarah Chen");
    // The reason carries the facts, and deal state is UNKNOWN — no CRM yet.
    expect(list[0]!.reason).toMatchObject({
      days_elapsed: 4,
      threshold_days: 2,
      has_open_deal: null,
    });
  });

  it("is idempotent — a second sync changes nothing", async () => {
    const again = await runGmailSyncJob(deps(), { organizationId: orgId, userId: alice });
    expect(again.ok && again.obligations_written).toBe(2);
    const list = await listPendingObligations(client.sql, { organizationId: orgId, userId: alice });
    expect(list).toHaveLength(2);
  });

  it("a colleague with no connection gets a clear answer and sees nothing of Alice's", async () => {
    const result = await runGmailSyncJob(deps(), { organizationId: orgId, userId: bob });
    expect(result).toEqual({ ok: false, reason: "no_connection" });
    expect(
      await listPendingObligations(client.sql, { organizationId: orgId, userId: bob }),
    ).toEqual([]);
  });

  it("a colleague CANNOT use Alice's token even if her row is copied to him", async () => {
    // The user-bound AAD, observed end to end. Bob gets Alice's ciphertext
    // under his own user id; the vault must refuse, and no Gmail call happens.
    const aliceRow = await withUser(
      client.sql,
      { organizationId: orgId, userId: alice },
      (tx) => tx`SELECT encrypted_credentials FROM user_connections LIMIT 1`,
    );
    await withUser(client.sql, { organizationId: orgId, userId: bob }, async (tx) => {
      await tx`
        INSERT INTO user_connections
          (id, organization_id, owner_user_id, provider, external_account_label,
           encrypted_credentials, scopes, status)
        VALUES (${uuidv7()}, ${orgId}, ${bob}, 'gmail', 'stolen',
                ${aliceRow[0]!["encrypted_credentials"] as Uint8Array}, ARRAY['x'], 'active')
      `;
    });
    const calls: string[] = [];
    const spyingTransport = async (req: HttpRequest) => {
      calls.push(req.url);
      return transport(req);
    };
    const result = await runGmailSyncJob(
      { ...deps(), transport: spyingTransport },
      { organizationId: orgId, userId: bob },
    );
    expect(result.ok).toBe(false);
    expect(result.ok || result.reason).toBe("sync_failed");
    expect(calls).toHaveLength(0);
    // And the failure is recorded on HIS connection, for the UI.
    const his = await withUser(
      client.sql,
      { organizationId: orgId, userId: bob },
      (tx) =>
        tx`SELECT status, last_error FROM user_connections WHERE external_account_label = 'stolen'`,
    );
    expect(his[0]!["status"]).toBe("error");
    expect(his[0]!["last_error"]).toBeTruthy();
  });

  it("records a successful sync on the connection", async () => {
    const rows = await withUser(
      client.sql,
      { organizationId: orgId, userId: alice },
      (tx) => tx`SELECT last_synced_at, last_error FROM user_connections`,
    );
    expect(rows[0]!["last_synced_at"]).not.toBeNull();
    expect(rows[0]!["last_error"]).toBeNull();
  });
});

describe("with a CRM connected — the deal step", () => {
  const asked: string[][] = [];
  const crm = (behaviour: "answer" | "down"): DealSource => ({
    provider: "fake_crm",
    async lookup(_ctx, addresses) {
      asked.push([...addresses]);
      if (behaviour === "down") throw new Error("CRM 503");
      return {
        asked: addresses,
        signals: [
          {
            address: "bob@client.com",
            has_open_deal: true,
            open_deal_value: 40_000,
            account_name: "Client Co",
          },
          // Not one of Alice's contacts: must be ignored, never create a row.
          { address: "mallory@evil.example", has_open_deal: true, open_deal_value: 1 },
        ],
      };
    },
  });
  const ctx = { organizationId: orgId, userId: alice };

  it("asks about exactly this person's contacts and ranks the confirmed deal higher", async () => {
    const result = await runGmailSyncJob({ ...deps(), deals: async () => crm("answer") }, ctx);
    expect(result.ok && result.deals).toEqual({
      ok: true,
      provider: "fake_crm",
      asked: 3,
      open: 1,
      closed: 0,
      unknown: 2,
    });
    expect(asked.at(-1)).toEqual(["bob@client.com", "dan@client.com", "sarah@acme.com"]);

    const list = await listPendingObligations(client.sql, ctx);
    // Sarah (unknown to the CRM) is still there — unknown is not closed.
    expect(list.map((o) => o.subject)).toEqual(["Enterprise pricing", "Proposal"]);
    const proposal = list.find((o) => o.subject === "Proposal")!;
    expect(proposal.reason).toMatchObject({ has_open_deal: true, open_deal_value: 40_000 });
    expect(proposal.contact_account_name).toBe("Client Co");
    // The stranger the CRM mentioned did not become a contact.
    const rows = await withUser(
      client.sql,
      ctx,
      (tx) => tx`SELECT count(*)::int AS n FROM contacts`,
    );
    expect(rows[0]!["n"]).toBe(3);
  });

  it("a CRM that is down does not take the mailbox down: the sync completes on the last known state", async () => {
    const result = await runGmailSyncJob({ ...deps(), deals: async () => crm("down") }, ctx);
    expect(result.ok).toBe(true);
    expect(result.ok && result.deals).toEqual({
      ok: false,
      provider: "fake_crm",
      error: "CRM 503",
    });
    const proposal = (await listPendingObligations(client.sql, ctx)).find(
      (o) => o.subject === "Proposal",
    )!;
    expect(proposal.reason).toMatchObject({ has_open_deal: true, open_deal_value: 40_000 });
  });

  it("without a CRM the step says so and nothing is rewritten", async () => {
    const result = await runGmailSyncJob(deps(), ctx);
    expect(result.ok && result.deals).toEqual({ ok: false, provider: null, reason: "no_crm" });
    const proposal = (await listPendingObligations(client.sql, ctx)).find(
      (o) => o.subject === "Proposal",
    )!;
    expect(proposal.reason).toMatchObject({ has_open_deal: true, open_deal_value: 40_000 });
  });
});
