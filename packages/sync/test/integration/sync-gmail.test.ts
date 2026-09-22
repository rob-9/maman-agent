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
import type {
  DealSource,
  HttpRequest,
  HttpResponse,
  ThreadContentReader,
} from "@maman/connector-adapters";
import type { AssessmentInput, ModelProvider } from "@maman/model-provider";
import { createUserVaultCredentialProvider } from "../../src/user-vault-credentials.js";
import { runGmailSyncJob } from "../../src/sync-gmail.js";
import { decryptBody, encryptBody, storedThreadContent } from "../../src/content.js";
import { voiceFor } from "../../src/voice.js";
import { meetingContext } from "../../src/meetings.js";
import { intentsFor, listIntentViews, skippedWithReasons, stateIntent } from "../../src/intents.js";
import { DeterministicModelProvider } from "@maman/model-provider";
import { deterministicContextComposer } from "@maman/voice-engine";
import { salesforceActivityWriter, type CredentialProvider } from "@maman/connector-adapters";
import { DEFAULT_ORG_POLICY, orgPolicySchema } from "@maman/policy-engine";
import { recordDraft as recordDraftRow, listActions, verifyAuditChain } from "@maman/db";
import {
  applyAction,
  approveAction,
  declineAction,
  listActionViews,
  promoteAction,
  proposeActivityLog,
  revertAction,
  sentFromMatchedDrafts,
} from "../../src/actions.js";
import { recordDraft, draftOutcomes } from "@maman/db";

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
    historyId: `h-${id}-${whenMs}`,
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

/** Alice's mailbox: one thread she owes a reply on, one she's waiting on, one fresh. */
const MAILBOX: Record<string, unknown> = {
  owed: gmailThread(
    "owed",
    "Sarah Chen <sarah@acme.com>",
    "alice@co.example",
    ago(4),
    "Enterprise pricing",
    "Thanks Alex. Can you confirm the price holds for 60 seats?",
  ),
  waiting: gmailThread("waiting", "alice@co.example", "bob@client.com", ago(9), "Proposal"),
  fresh: gmailThread("fresh", "alice@co.example", "dan@client.com", ago(1), "Intro"),
};

/** Alice's calendar, scripted. Set per test. */
let CALENDAR: { items: unknown[]; nextSyncToken?: string; status?: number } = { items: [] };
const calendarRequests: HttpRequest[] = [];

const transport = async (req: HttpRequest): Promise<HttpResponse> => {
  const url = new URL(req.url);
  if (url.pathname.includes("/calendar/")) {
    calendarRequests.push(req);
    if (CALENDAR.status) return { status: CALENDAR.status, headers: {}, body: {} };
    return {
      status: 200,
      headers: {},
      body: {
        items: CALENDAR.items,
        ...(CALENDAR.nextSyncToken ? { nextSyncToken: CALENDAR.nextSyncToken } : {}),
      },
    };
  }
  if (url.pathname.endsWith("/profile")) {
    return { status: 200, headers: {}, body: { emailAddress: "alice@co.example" } };
  }
  if (url.pathname.endsWith("/threads")) {
    return {
      status: 200,
      headers: {},
      body: {
        threads: Object.keys(MAILBOX).map((id) => ({
          id,
          historyId: (MAILBOX[id] as { historyId: string }).historyId,
        })),
      },
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
              ARRAY['https://www.googleapis.com/auth/gmail.readonly', 'https://www.googleapis.com/auth/calendar.readonly'], 'active')
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
  contentKey: master,
});

describe("Gmail sync job — the L1 slice on a real database", () => {
  it("syncs a mailbox and produces a ranked, explained obligation list", async () => {
    const result = await runGmailSyncJob(deps(), { organizationId: orgId, userId: alice });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.listed).toBe(3);
    expect(result.threads_upserted).toBe(3);
    expect(result.contacts_upserted).toBe(3);
    expect(result.messages_upserted).toBe(3);
    expect(result.unchanged).toBe(0);
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

  it("is idempotent — a second sync changes nothing, and fetches nothing that did not move", async () => {
    const fetched: string[] = [];
    const spying = async (req: HttpRequest) => {
      if (/\/threads\/[^?]+\?/.test(req.url)) fetched.push(req.url);
      return transport(req);
    };
    const again = await runGmailSyncJob(
      { ...deps(), transport: spying },
      { organizationId: orgId, userId: alice },
    );
    expect(again.ok && again.obligations_written).toBe(2);
    expect(again.ok && again.unchanged).toBe(3);
    expect(fetched).toEqual([]);
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

describe("the agent pass", () => {
  const ctx = { organizationId: orgId, userId: alice };
  const BODIES: Record<string, string> = {
    owed: "Can you confirm the price holds for 60 seats?",
    waiting: "Sending the proposal over.",
  };
  const seen: AssessmentInput[] = [];
  let mode: "judge" | "down" = "judge";
  let refuse = new Set<string>();
  const provider: ModelProvider = {
    id: "demo",
    nameRecommendation: async () => ({ ok: false, error: "unavailable" }),
    draftAgentPlan: async () => ({ ok: false, error: "unavailable" }),
    composeDraft: async () => ({ ok: false, error: "unavailable" }),
    async assessObligation(input) {
      seen.push(input);
      if (mode === "down") return { ok: false, error: "unavailable" };
      const owed = !refuse.has(input.subject);
      return {
        ok: true,
        value: {
          owed,
          ask: owed ? "a price confirmation" : "",
          summary: owed ? "They want the price confirmed." : "Closed out.",
          urgency: owed ? "high" : "low",
          confidence: 0.9,
        },
        usage: { input_tokens: 1, output_tokens: 1, model_alias: "fake" },
      };
    },
  };
  const reads: string[] = [];
  const content: ThreadContentReader = {
    async read(_key, id, selfAddresses) {
      reads.push(id);
      expect(selfAddresses).toEqual(["alice@co.example"]);
      return {
        external_id: id,
        messages: [
          { from: "x", direction: "inbound", sent_at: NOW.toISOString(), text: BODIES[id] ?? "" },
        ],
      };
    },
  };
  const withAgent = (max?: number) => ({
    ...deps(),
    agent: { provider, content, ...(max ? { max_candidates: max } : {}) },
  });

  it("reads each candidate from the STORE (Gmail is not asked), with the facts, the text and the relationship", async () => {
    refuse = new Set(["Enterprise pricing"]);
    const result = await runGmailSyncJob(withAgent(), ctx);
    expect(result.ok && result.agent).toEqual({
      considered: 2,
      assessed: 2,
      reused: 0,
      failed: 0,
      model_alias: "fake",
    });
    // Content came from the encrypted store; the Gmail fallback was never used.
    expect(reads).toEqual([]);
    const pricing = seen.find((i) => i.subject === "Enterprise pricing")!;
    expect(pricing).toMatchObject({ kind: "awaiting_you", days_elapsed: 4, has_open_deal: null });
    expect(pricing.messages[0]!.text).toBe(
      "Thanks Alex. Can you confirm the price holds for 60 seats?",
    );
    expect(pricing.history).toEqual([]);
    const proposal = seen.find((i) => i.subject === "Proposal")!;
    expect(proposal).toMatchObject({
      kind: "awaiting_them",
      has_open_deal: true,
      open_deal_value: 40_000,
      account_name: "Client Co",
    });
    // Stored, but only as ciphertext: the plaintext is in no table.
    for (const table of ["threads", "contacts", "obligations", "thread_assessments", "messages"]) {
      const rows = await withUser(
        client.sql,
        ctx,
        (tx) => tx`SELECT to_jsonb(t)::text AS j FROM ${tx(table)} t`,
      );
      for (const r of rows) expect(String(r["j"])).not.toContain("60 seats");
    }
    // ...and it opens only for Alice.
    const stored = await withUser(
      client.sql,
      ctx,
      (tx) =>
        tx`SELECT m.body_ciphertext FROM messages m JOIN threads t ON t.id = m.thread_id WHERE t.external_id = 'owed'`,
    );
    const ct = stored[0]!["body_ciphertext"] as Uint8Array;
    expect(decryptBody(ct, master, ctx)).toContain("60 seats");
    expect(() => decryptBody(ct, master, { organizationId: orgId, userId: bob })).toThrow();
  });

  it("the store serves a thread's conversation in the agent's shape, and nothing for a colleague", async () => {
    const t = await withUser(
      client.sql,
      ctx,
      (tx) => tx`SELECT id FROM threads WHERE external_id = 'owed'`,
    );
    const tid = t[0]!["id"] as string;
    const content = await storedThreadContent({ sql: client.sql, contentKey: master }, ctx, tid);
    expect(content?.messages).toEqual([
      {
        from: "Sarah Chen",
        direction: "inbound",
        sent_at: new Date(Number(ago(4))).toISOString(),
        text: "Thanks Alex. Can you confirm the price holds for 60 seats?",
      },
    ]);
    expect(
      await storedThreadContent(
        { sql: client.sql, contentKey: master },
        { organizationId: orgId, userId: bob },
        tid,
      ),
    ).toBeNull();
  });

  it("with the agent on, a not-owed item is hidden; with it off, the list is untouched", async () => {
    const on = await listPendingObligations(client.sql, ctx, 50, { agent: true });
    expect(on.map((o) => o.subject)).toEqual(["Proposal"]);
    expect(on[0]!.assessment).toMatchObject({
      owed: true,
      urgency: "high",
      ask: "a price confirmation",
    });
    const off = await listPendingObligations(client.sql, ctx, 50);
    expect(off.map((o) => o.subject)).toEqual(["Enterprise pricing", "Proposal"]);
  });

  it("an unchanged thread is not judged again", async () => {
    seen.length = 0;
    reads.length = 0;
    const result = await runGmailSyncJob(withAgent(), ctx);
    expect(result.ok && result.agent).toMatchObject({
      considered: 2,
      assessed: 0,
      reused: 2,
      failed: 0,
    });
    expect(reads).toEqual([]);
  });

  it("a thread that moved is judged again, and only that one", async () => {
    // Bob answered 6 days ago: the thread moved and is still stalled, now on Alice.
    MAILBOX["waiting"] = gmailThread(
      "waiting",
      "alice@co.example",
      "bob@client.com",
      ago(9),
      "Proposal",
    );
    (MAILBOX["waiting"] as { historyId: string }).historyId = "h-waiting-moved";
    (MAILBOX["waiting"] as { messages: unknown[] }).messages.push({
      id: "waiting-m2",
      internalDate: ago(6),
      payload: {
        headers: [
          { name: "From", value: "bob@client.com" },
          { name: "To", value: "alice@co.example" },
          { name: "Subject", value: "Proposal" },
        ],
      },
    });
    seen.length = 0;
    const result = await runGmailSyncJob(withAgent(), ctx);
    expect(result.ok && result.agent).toMatchObject({ assessed: 1, reused: 1, failed: 0 });
    expect(seen.map((i) => i.subject)).toEqual(["Proposal"]);
    expect(seen[0]).toMatchObject({ kind: "awaiting_you", days_elapsed: 6 });
  });

  it("when the model is down the items keep their arithmetic place, and the pass never throws", async () => {
    await withUser(client.sql, ctx, (tx) => tx`DELETE FROM thread_assessments`);
    mode = "down";
    try {
      const result = await runGmailSyncJob(withAgent(), ctx);
      expect(result.ok).toBe(true);
      expect(result.ok && result.agent).toMatchObject({ considered: 2, assessed: 0, failed: 2 });
      const on = await listPendingObligations(client.sql, ctx, 50, { agent: true });
      // Nothing judged, nothing hidden: the deterministic list, in its order.
      expect(on.map((o) => [o.subject, o.assessment])).toEqual([
        ["Proposal", null],
        ["Enterprise pricing", null],
      ]);
    } finally {
      mode = "judge";
    }
  });

  it("is bounded to the top candidates", async () => {
    refuse = new Set();
    await withUser(client.sql, ctx, (tx) => tx`DELETE FROM thread_assessments`);
    const result = await runGmailSyncJob(withAgent(1), ctx);
    expect(result.ok && result.agent).toMatchObject({ considered: 1, assessed: 1 });
  });
});

describe("voice, and what the person actually sent", () => {
  const ctx = { organizationId: orgId, userId: alice };

  it("retrieves the person's own writing for a contact from the store", async () => {
    // Alice's outbound "Proposal" message to Bob has a body now.
    MAILBOX["waiting"] = gmailThread(
      "waiting",
      "alice@co.example",
      "bob@client.com",
      ago(9),
      "Proposal",
      "Hi Bob, sending the proposal over. Let me know what you think by Thursday and I will hold the pricing.\n\nCheers,\nAlice",
    );
    await runGmailSyncJob(deps(), ctx);
    const inputs = await withUser(
      client.sql,
      ctx,
      (tx) => tx`SELECT c.id FROM contacts c WHERE c.external_id = 'bob@client.com'`,
    );
    const voice = await voiceFor(
      { sql: client.sql, contentKey: master },
      ctx,
      inputs[0]!["id"] as string,
    );
    expect(voice.to_this_contact[0]).toContain("Hi Bob, sending the proposal over.");
    expect(voice.recent[0]).toContain("Cheers,\nAlice");
    expect(voice.similar_situations).toEqual([]);
  });

  it("matches a draft to the message the person then sent, and records how close it was", async () => {
    const pending = await listPendingObligations(client.sql, ctx, 50);
    const proposal = pending.find((o) => o.subject === "Proposal")!;
    const draftBody =
      "Hi Bob,\n\nFollowing up on the proposal. Does Thursday still work?\n\nCheers,\nAlice\n";
    await recordDraft(client.sql, ctx, {
      obligation_id: proposal.id,
      thread_id: proposal.thread_id,
      gmail_draft_id: "gd-x",
      subject: "Re: Proposal",
      body_ciphertext: encryptBody(draftBody, master, ctx),
      body_chars: draftBody.length,
      composer: "model",
    });
    // Alice sends it, lightly edited; the next sync sees it on the thread.
    (MAILBOX["waiting"] as { historyId: string }).historyId = "h-waiting-sent";
    (MAILBOX["waiting"] as { messages: unknown[] }).messages.push({
      id: "waiting-sent",
      internalDate: String(Date.now() + 60_000),
      payload: {
        headers: [
          { name: "From", value: "alice@co.example" },
          { name: "To", value: "bob@client.com" },
          { name: "Subject", value: "Re: Proposal" },
        ],
        mimeType: "text/plain",
        body: {
          data: Buffer.from(
            "Hi Bob,\n\nFollowing up on the proposal. Does Thursday or Friday work?\n\nCheers,\nAlice\n",
          ).toString("base64url"),
        },
      },
    });
    const result = await runGmailSyncJob(deps(), ctx);
    expect(result.ok && result.drafts_matched).toBe(1);
    const outcomes = await draftOutcomes(client.sql, ctx);
    expect(outcomes.sent).toBe(1);
    expect(outcomes.mean_edit_ratio!).toBeGreaterThan(0.85);
  });
});

describe("the calendar step", () => {
  const ctx = { organizationId: orgId, userId: alice };
  const event = (id: string, when: string, title: string, description?: string) => ({
    id,
    status: "confirmed",
    summary: title,
    ...(description ? { description } : {}),
    start: { dateTime: when },
    end: { dateTime: when },
    attendees: [
      { email: "alice@co.example", self: true, responseStatus: "accepted" },
      { email: "bob@client.com", displayName: "Bob" },
      { email: "sarah@acme.com", displayName: "Sarah Chen" },
    ],
  });

  it("stores meetings with the description encrypted, stamps the contact, and keeps the sync token", async () => {
    CALENDAR = {
      items: [
        event(
          "m-past",
          new Date(Number(ago(2))).toISOString(),
          "Proposal walkthrough",
          "Agenda: 60 seats, term, start date",
        ),
        event("m-next", new Date(Number(ago(-3))).toISOString(), "Kickoff"),
      ],
      nextSyncToken: "cal-tok-1",
    };
    calendarRequests.length = 0;
    const result = await runGmailSyncJob(deps(), ctx);
    expect(result.ok && result.calendar).toEqual({
      ok: true,
      listed: 2,
      meetings_upserted: 2,
      cancelled: 0,
      contacts_stamped: 2,
      resynced: false,
    });
    expect(calendarRequests).toHaveLength(1);
    expect(new URL(calendarRequests[0]!.url).searchParams.get("syncToken")).toBeNull();
    const bob = await withUser(
      client.sql,
      ctx,
      (tx) =>
        tx`SELECT last_meeting_title, next_meeting_title FROM contacts WHERE external_id = 'bob@client.com'`,
    );
    expect(bob[0]).toEqual({
      last_meeting_title: "Proposal walkthrough",
      next_meeting_title: "Kickoff",
    });
    const raw = await withUser(
      client.sql,
      ctx,
      (tx) => tx`SELECT to_jsonb(m)::text AS j FROM meetings m`,
    );
    for (const r of raw) expect(String(r["j"])).not.toContain("60 seats, term");
    // A booked meeting with Bob: the chase on "Proposal" is no longer an obligation.
    const list = await listPendingObligations(client.sql, ctx, 50);
    expect(list.map((o) => o.subject)).not.toContain("Proposal");
  });

  it("the next sync sends the token and gets only changes; a stale token is a full window again", async () => {
    CALENDAR = { items: [], nextSyncToken: "cal-tok-2" };
    calendarRequests.length = 0;
    await runGmailSyncJob(deps(), ctx);
    expect(new URL(calendarRequests[0]!.url).searchParams.get("syncToken")).toBe("cal-tok-1");
    CALENDAR = { items: [], status: 410 };
    calendarRequests.length = 0;
    const result = await runGmailSyncJob(deps(), ctx);
    expect(result.ok && result.calendar).toMatchObject({ ok: false, reason: "sync_failed" });
    // A calendar that fails does not take the mailbox down.
    expect(result.ok).toBe(true);
  });

  it("the meeting reaches the agent: the judgment and the draft know what you met about", async () => {
    CALENDAR = { items: [], nextSyncToken: "cal-tok-3" };
    // Bob's next meeting is now in the past: the chase is back, judged with the meeting in view.
    await withUser(
      client.sql,
      ctx,
      (tx) =>
        tx`UPDATE meetings SET starts_at = ${new Date(Number(ago(1))).toISOString()}, ends_at = ${new Date(Number(ago(1))).toISOString()} WHERE external_id = 'm-next'`,
    );
    const seen: AssessmentInput[] = [];
    const provider: ModelProvider = {
      id: "demo",
      nameRecommendation: async () => ({ ok: false, error: "unavailable" }),
      draftAgentPlan: async () => ({ ok: false, error: "unavailable" }),
      composeDraft: async () => ({ ok: false, error: "unavailable" }),
      async assessObligation(input) {
        seen.push(input);
        return {
          ok: true,
          value: { owed: true, ask: "", summary: "s", urgency: "normal", confidence: 0.5 },
          usage: { input_tokens: 0, output_tokens: 0, model_alias: "fake" },
        };
      },
    };
    await withUser(client.sql, ctx, (tx) => tx`DELETE FROM thread_assessments`);
    await runGmailSyncJob({ ...deps(), agent: { provider } }, ctx);
    // Sarah was on both meetings too; her thread is the live candidate here.
    const pricing = seen.find((i) => i.subject === "Enterprise pricing")!;
    expect(pricing.last_meeting).toMatchObject({ title: "Kickoff" });
    expect(pricing.next_meeting).toBeUndefined();
    const ctxMeetings = await meetingContext(
      { sql: client.sql, contentKey: master },
      ctx,
      "bob@client.com",
      NOW,
    );
    expect(ctxMeetings.last_meeting?.notes).toBeUndefined();
    const walkthrough = await meetingContext(
      { sql: client.sql, contentKey: master },
      ctx,
      "bob@client.com",
      new Date(Number(ago(1)) + 1000),
    );
    expect(walkthrough.last_meeting?.title).toBe("Kickoff");
  });
});

describe("the intent store in the sweep", () => {
  const ctx = { organizationId: orgId, userId: alice };
  const ideps = () => ({ sql: client.sql, contentKey: master });

  it("a stated rule sets a chase aside, says why in the person's words, and a reply owed is untouched", async () => {
    // A fresh quiet thread to Dan, chased twice, no answer.
    MAILBOX["chase"] = gmailThread(
      "chase",
      "alice@co.example",
      "dan@client.com",
      ago(12),
      "Renewal",
    );
    (MAILBOX["chase"] as { messages: unknown[] }).messages.push({
      id: "chase-m2",
      internalDate: ago(8),
      payload: {
        headers: [
          { name: "From", value: "alice@co.example" },
          { name: "To", value: "dan@client.com" },
          { name: "Subject", value: "Renewal" },
        ],
      },
    });
    CALENDAR = { items: [], nextSyncToken: "cal-tok-9" };
    const before = await runGmailSyncJob(deps(), ctx);
    expect(before.ok && before.obligations_skipped).toBe(0);
    const chase = await withUser(
      client.sql,
      ctx,
      (tx) => tx`SELECT chase_count FROM threads WHERE external_id = 'chase'`,
    );
    expect(chase[0]!["chase_count"]).toBe(2);

    const said = await stateIntent(
      ideps(),
      ctx,
      "Don't chase Dan, he'll come back when the budget clears.",
    );
    expect(said).toMatchObject({
      is_rule: true,
      scope: { kind: "contact", value: "dan@client.com" },
      source: "stated",
    });
    const after = await runGmailSyncJob(deps(), ctx);
    expect(after.ok && after.obligations_skipped).toBe(1);
    const skipped = await skippedWithReasons(ideps(), ctx);
    expect(skipped.map((s) => [s.subject, s.intent_text])).toEqual([
      ["Renewal", "Don't chase Dan, he'll come back when the budget clears."],
    ]);
    // Sarah's question is still owed: a rule about chasing never hides a reply.
    expect((await listPendingObligations(client.sql, ctx)).map((o) => o.subject)).toContain(
      "Enterprise pricing",
    );
    // Retire it: the next sweep brings the chase back.
    const views = await listIntentViews(ideps(), ctx);
    const { forgetIntent } = await import("../../src/intents.js");
    expect(await forgetIntent(ideps(), ctx, views[0]!.id)).toBe(true);
    const back = await runGmailSyncJob(deps(), ctx);
    expect(back.ok && back.obligations_skipped).toBe(0);
    expect((await listPendingObligations(client.sql, ctx)).map((o) => o.subject)).toContain(
      "Renewal",
    );
  });

  it("'never more than twice' counts the chases already made", async () => {
    await stateIntent(ideps(), ctx, "Never follow up more than twice.");
    const r = await runGmailSyncJob(deps(), ctx);
    expect(r.ok && r.obligations_skipped).toBe(1);
    expect((await skippedWithReasons(ideps(), ctx)).map((s) => s.subject)).toEqual(["Renewal"]);
    for (const v of await listIntentViews(ideps(), ctx)) {
      const { forgetIntent } = await import("../../src/intents.js");
      await forgetIntent(ideps(), ctx, v.id);
    }
  });

  it("guidance reaches the model, most specific first, and only what bears on the contact", async () => {
    await stateIntent(ideps(), ctx, "Keep emails to Sarah short.");
    await stateIntent(ideps(), ctx, "Sign off as Cheers, A.");
    await stateIntent(ideps(), ctx, "Dan prefers a call over email.");
    const forSarah = await intentsFor(ideps(), ctx, {
      contact_address: "sarah@acme.com",
      account_name: null,
      kind: "awaiting_you",
    });
    expect(forSarah).toEqual(["Keep emails to Sarah short.", "Sign off as Cheers, A."]);
    const seen: AssessmentInput[] = [];
    const provider: ModelProvider = {
      id: "demo",
      nameRecommendation: async () => ({ ok: false, error: "unavailable" }),
      draftAgentPlan: async () => ({ ok: false, error: "unavailable" }),
      composeDraft: async () => ({ ok: false, error: "unavailable" }),
      async assessObligation(input) {
        seen.push(input);
        return {
          ok: true,
          value: { owed: true, ask: "", summary: "s", urgency: "normal", confidence: 0.5 },
          usage: { input_tokens: 0, output_tokens: 0, model_alias: "fake" },
        };
      },
    };
    await withUser(client.sql, ctx, (tx) => tx`DELETE FROM thread_assessments`);
    await runGmailSyncJob({ ...deps(), agent: { provider } }, ctx);
    const pricing = seen.find((i) => i.subject === "Enterprise pricing")!;
    expect(pricing.preferences).toEqual(["Keep emails to Sarah short.", "Sign off as Cheers, A."]);
  });
});

describe("drafts written before being asked", () => {
  const ctx = { organizationId: orgId, userId: alice };
  const ideps = () => ({ sql: client.sql, contentKey: master });
  const judge: ModelProvider = {
    id: "demo",
    nameRecommendation: async () => ({ ok: false, error: "unavailable" }),
    draftAgentPlan: async () => ({ ok: false, error: "unavailable" }),
    composeDraft: async () => ({ ok: false, error: "unavailable" }),
    async assessObligation(input) {
      // Sarah's question is owed; nothing else is.
      const owed = input.subject === "Enterprise pricing";
      return {
        ok: true,
        value: {
          owed,
          ask: owed ? "pricing for 60 seats" : "",
          summary: "s",
          urgency: "normal",
          confidence: 0.6,
        },
        usage: { input_tokens: 0, output_tokens: 0, model_alias: "fake" },
      };
    },
  };
  const composer = deterministicContextComposer(new DeterministicModelProvider());
  const posts: HttpRequest[] = [];
  const draftingTransport = async (req: HttpRequest): Promise<HttpResponse> => {
    if (req.method === "POST" && req.url.endsWith("/drafts")) {
      posts.push(req);
      return {
        status: 200,
        headers: {},
        body: { id: `d-${posts.length}`, message: { id: `m-${posts.length}` } },
      };
    }
    return transport(req);
  };
  const withPredraft = (max = 3) => ({
    ...deps(),
    transport: draftingTransport,
    agent: { provider: judge },
    predraft: { composer, max },
  });

  it("drafts only what the agent judged owed, once per thread, and attaches it to the item", async () => {
    for (const v of await listIntentViews(ideps(), ctx)) {
      const { forgetIntent } = await import("../../src/intents.js");
      await forgetIntent(ideps(), ctx, v.id);
    }
    await withUser(client.sql, ctx, (tx) => tx`DELETE FROM thread_assessments`);
    await withUser(client.sql, ctx, (tx) => tx`DELETE FROM drafts`);
    CALENDAR = { items: [], nextSyncToken: "cal-tok-pd" };
    const first = await runGmailSyncJob(withPredraft(), ctx);
    expect(first.ok && first.predraft).toEqual({
      considered: 1,
      drafted: 1,
      skipped_by_rule: 0,
      failed: 0,
    });
    expect(posts).toHaveLength(1);
    const list = await listPendingObligations(client.sql, ctx, 50, { agent: true });
    const pricing = list.find((o) => o.subject === "Enterprise pricing")!;
    expect(pricing.draft).toMatchObject({
      mode: "auto",
      gmail_draft_id: "d-1",
      gmail_message_id: "m-1",
    });
    // The draft answers the actual ask, in the sender's name, filed on the thread.
    const raw = JSON.parse(posts[0]!.body!) as { message: { raw: string; threadId: string } };
    expect(raw.message.threadId).toBe("owed");
    expect(Buffer.from(raw.message.raw, "base64url").toString("utf8")).toContain(
      "pricing for 60 seats",
    );
    // The next sweep writes nothing new: the draft is still waiting.
    const second = await runGmailSyncJob(withPredraft(), ctx);
    expect(second.ok && second.predraft).toEqual({
      considered: 0,
      drafted: 0,
      skipped_by_rule: 0,
      failed: 0,
    });
    expect(posts).toHaveLength(1);
  });

  it("'don't draft for me' holds the sweep back; a click still works; a cap of 0 disables it", async () => {
    await withUser(client.sql, ctx, (tx) => tx`DELETE FROM drafts`);
    await withUser(client.sql, ctx, (tx) => tx`DELETE FROM thread_assessments`);
    const said = await stateIntent(ideps(), ctx, "Don't write drafts for me unless I ask.");
    expect(said.is_rule).toBe(true);
    const r = await runGmailSyncJob(withPredraft(), ctx);
    expect(r.ok && r.predraft).toEqual({
      considered: 1,
      drafted: 0,
      skipped_by_rule: 1,
      failed: 0,
    });
    expect(posts).toHaveLength(1);
    const { forgetIntent } = await import("../../src/intents.js");
    await forgetIntent(ideps(), ctx, said.id);
    const off = await runGmailSyncJob(withPredraft(0), ctx);
    expect(off.ok && off.predraft).toEqual({
      considered: 0,
      drafted: 0,
      skipped_by_rule: 0,
      failed: 0,
    });
    expect(posts).toHaveLength(1);
  });

  it("an item the agent could not judge is left alone: the arithmetic keeps it on the list, nobody drafts it", async () => {
    await withUser(client.sql, ctx, (tx) => tx`DELETE FROM drafts`);
    await withUser(client.sql, ctx, (tx) => tx`DELETE FROM thread_assessments`);
    const partial: ModelProvider = {
      ...judge,
      async assessObligation(input) {
        if (input.subject === "Renewal") return { ok: false, error: "unavailable" };
        return judge.assessObligation(input);
      },
    };
    posts.length = 0;
    const r = await runGmailSyncJob({ ...withPredraft(), agent: { provider: partial } }, ctx);
    expect(r.ok && r.agent?.failed).toBe(1);
    // Renewal is still on the list, unjudged; the sweep drafted only what was judged owed.
    const list = await listPendingObligations(client.sql, ctx, 50, { agent: true });
    expect(list.map((o) => o.subject)).toContain("Renewal");
    expect(r.ok && r.predraft).toEqual({
      considered: 1,
      drafted: 1,
      skipped_by_rule: 0,
      failed: 0,
    });
    const threads = posts.map(
      (p) => (JSON.parse(p.body!) as { message: { threadId: string } }).message.threadId,
    );
    expect(threads).toEqual(["owed"]);
  });

  it("a Gmail refusal is counted, not raised, and the item stays as it was", async () => {
    await withUser(client.sql, ctx, (tx) => tx`DELETE FROM drafts`);
    await withUser(client.sql, ctx, (tx) => tx`DELETE FROM thread_assessments`);
    const refusing = async (req: HttpRequest): Promise<HttpResponse> =>
      req.method === "POST"
        ? { status: 500, headers: {}, body: { error: { message: "quota" } } }
        : transport(req);
    const r = await runGmailSyncJob({ ...withPredraft(), transport: refusing }, ctx);
    expect(r.ok).toBe(true);
    expect(r.ok && r.predraft).toEqual({
      considered: 1,
      drafted: 0,
      skipped_by_rule: 0,
      failed: 1,
    });
    const pricing = (await listPendingObligations(client.sql, ctx, 50)).find(
      (o) => o.subject === "Enterprise pricing",
    )!;
    expect(pricing.draft).toBeNull();
  });
});

describe("the agent acts: logging a sent email to Salesforce", () => {
  const ctx = { organizationId: orgId, userId: alice };
  /** A scripted Salesforce org: contacts, one open opportunity, a task store. */
  const sf = {
    tasks: new Map<string, Record<string, unknown>>(),
    created: 0,
    createStatus: 201,
    readBackWho: null as string | null,
  };
  const sfTransport = async (req: HttpRequest): Promise<HttpResponse> => {
    const url = new URL(req.url);
    const q = url.searchParams.get("q") ?? "";
    if (q.includes("FROM Contact")) {
      return q.includes("bob@client.com")
        ? { status: 200, headers: {}, body: { records: [{ Id: "003BOB", AccountId: "001CL" }] } }
        : { status: 200, headers: {}, body: { records: [] } };
    }
    if (q.includes("FROM OpportunityContactRole"))
      return { status: 200, headers: {}, body: { records: [{ OpportunityId: "006DEAL" }] } };
    if (q.includes("Description LIKE")) {
      const m = /'%(\[maman:[^%]+\])%'/.exec(q)?.[1] ?? "";
      const hit = [...sf.tasks.values()].find((t) => String(t["Description"]).includes(m));
      return { status: 200, headers: {}, body: { records: hit ? [hit] : [] } };
    }
    if (req.method === "POST" && url.pathname.endsWith("/sobjects/Task")) {
      sf.created += 1;
      if (sf.createStatus !== 201)
        return { status: sf.createStatus, headers: {}, body: [{ errorCode: "X", message: "no" }] };
      const id = `00T${sf.created}`;
      const body = JSON.parse(req.body!) as Record<string, unknown>;
      sf.tasks.set(id, { Id: id, ...body, ...(sf.readBackWho ? { WhoId: sf.readBackWho } : {}) });
      return { status: 201, headers: {}, body: { id, success: true } };
    }
    const taskMatch = /\/sobjects\/Task\/([^?]+)/.exec(url.pathname);
    if (taskMatch && req.method === "GET") {
      const t = sf.tasks.get(decodeURIComponent(taskMatch[1]!));
      return t ? { status: 200, headers: {}, body: t } : { status: 404, headers: {}, body: {} };
    }
    if (taskMatch && req.method === "DELETE") {
      sf.tasks.delete(decodeURIComponent(taskMatch[1]!));
      return { status: 204, headers: {}, body: "" };
    }
    return { status: 404, headers: {}, body: {} };
  };
  const orgCreds: CredentialProvider = {
    load: async () => ({ access_token: "sf-tok", instance_url: "https://na1.example.com" }),
    refresh: async () => ({ access_token: "sf-tok", instance_url: "https://na1.example.com" }),
  };
  let policy = DEFAULT_ORG_POLICY;
  const adeps = () => ({
    sql: client.sql,
    contentKey: master,
    writer: salesforceActivityWriter({ credentials: orgCreds, transport: sfTransport }),
    orgPolicy: async () => policy,
    now: () => NOW,
  });
  const sentBob = {
    thread_id: "",
    contact_id: "",
    contact_email: "bob@client.com",
    contact_display_name: "Bob",
    contact_account_name: "Client Co" as string | null,
    subject: "Proposal",
    message_external_id: "waiting-sent",
    sent_at: NOW.toISOString(),
  };

  it("proposes from what was sent, with the exact diff and its hash, never twice for one message", async () => {
    const t = await withUser(
      client.sql,
      ctx,
      (tx) => tx`SELECT t.id, t.contact_id FROM threads t WHERE t.external_id = 'waiting'`,
    );
    sentBob.thread_id = t[0]!["id"] as string;
    sentBob.contact_id = t[0]!["contact_id"] as string;
    const proposed = await proposeActivityLog(adeps(), ctx, sentBob);
    expect("ok" in proposed).toBe(false);
    if ("ok" in proposed) return;
    expect(proposed.status).toBe("proposed");
    expect(proposed.diff).toMatchObject({
      kind: "salesforce.log_activity",
      contact_email: "bob@client.com",
      subject: "Email: Proposal",
      activity_date: NOW.toISOString().slice(0, 10),
    });
    expect(proposed.diff_sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(await proposeActivityLog(adeps(), ctx, sentBob)).toEqual({
      ok: false,
      reason: "exists",
    });
    // The body of the email is not in the diff: the CRM is shared.
    expect(JSON.stringify(proposed.diff)).not.toContain("Thursday");
  });

  it("an approval that does not match the diff is stale and nothing is written", async () => {
    const [p] = await listActions(client.sql, ctx);
    const r = await approveAction(adeps(), ctx, p!.id, "0".repeat(64));
    expect(r).toEqual({ ok: false, reason: "stale" });
    expect(sf.created).toBe(0);
    expect((await listActions(client.sql, ctx))[0]!.status).toBe("stale");
  });

  it("approve → apply exactly once → verified by an independent read; the row is the receipt; the audit chain holds", async () => {
    const proposed = await proposeActivityLog(adeps(), ctx, sentBob);
    if ("ok" in proposed) throw new Error("expected a proposal");
    const approved = await approveAction(adeps(), ctx, proposed.id, proposed.diff_sha256);
    expect(approved.ok).toBe(true);
    const applied = await applyAction(adeps(), ctx, proposed.id);
    expect(applied.ok).toBe(true);
    if (!applied.ok) return;
    expect(applied.action).toMatchObject({
      status: "verified",
      external_id: "00T1",
      approved_by: "user",
    });
    expect(applied.action.verification).toMatchObject({
      verified: true,
      who_id: "003BOB",
      what_id: "006DEAL",
    });
    expect(sf.created).toBe(1);
    const task = sf.tasks.get("00T1")!;
    expect(task["WhoId"]).toBe("003BOB");
    expect(task["WhatId"]).toBe("006DEAL");
    expect(String(task["Description"])).toContain(`[maman:${proposed.id}]`);
    // Applying again does nothing: not approved any more.
    expect((await applyAction(adeps(), ctx, proposed.id)).ok).toBe(false);
    expect(sf.created).toBe(1);
    const chain = await verifyAuditChain(client.sql, { organizationId: orgId });
    expect(chain.valid).toBe(true);
    const views = await listActionViews(adeps(), ctx);
    expect(views.find((v) => v.id === proposed.id)).toMatchObject({
      verified: true,
      can_revert: true,
      summary: "Log to Salesforce: Email: Proposal",
    });
  });

  it("a retry after an unknown result finds the task by marker and does not write a second one", async () => {
    const [latest] = await listActions(client.sql, ctx);
    // Pretend the apply never recorded: put the action back to approved.
    await withUser(
      client.sql,
      ctx,
      (tx) =>
        tx`UPDATE actions SET status = 'approved', external_id = NULL, verification = NULL WHERE id = ${latest!.id}`,
    );
    const again = await applyAction(adeps(), ctx, latest!.id);
    expect(again.ok).toBe(true);
    expect(sf.created).toBe(1);
    expect(again.ok && again.action.external_id).toBe("00T1");
  });

  it("a read-back that disagrees is a failure, whatever the create call said", async () => {
    sf.readBackWho = "003WRONG";
    const proposed = await proposeActivityLog(adeps(), ctx, {
      ...sentBob,
      message_external_id: "waiting-sent-2",
    });
    if ("ok" in proposed) throw new Error("expected a proposal");
    await approveAction(adeps(), ctx, proposed.id, proposed.diff_sha256);
    const applied = await applyAction(adeps(), ctx, proposed.id);
    sf.readBackWho = null;
    expect(applied).toMatchObject({ ok: false, reason: "unverified" });
    expect(applied.action).toMatchObject({ status: "failed" });
    expect(String(applied.action?.error)).toContain("WhoId");
  });

  it("undo deletes the task and reads back that it is gone", async () => {
    const verified = (await listActions(client.sql, ctx)).find((a) => a.status === "verified")!;
    const r = await revertAction(adeps(), ctx, verified.id);
    expect(r.ok).toBe(true);
    expect(sf.tasks.has("00T1")).toBe(false);
    expect(r.ok && r.action.status).toBe("reverted");
  });

  it("a contact Salesforce does not know is a failure with a reason, not a write to the wrong record", async () => {
    const proposed = await proposeActivityLog(adeps(), ctx, {
      ...sentBob,
      contact_email: "stranger@else.com",
      message_external_id: "waiting-sent-3",
    });
    if ("ok" in proposed) throw new Error("expected a proposal");
    await approveAction(adeps(), ctx, proposed.id, proposed.diff_sha256);
    const applied = await applyAction(adeps(), ctx, proposed.id);
    expect(applied).toMatchObject({ ok: false, reason: "provider" });
    expect(applied.action?.error).toBe("contact not in Salesforce");
  });

  it("'Always': a promotion the person made, applied by the sweep without asking; the org can forbid it", async () => {
    const proposed = await proposeActivityLog(adeps(), ctx, {
      ...sentBob,
      message_external_id: "waiting-sent-4",
    });
    if ("ok" in proposed) throw new Error("expected a proposal");
    const promoted = await promoteAction(adeps(), ctx, proposed.id);
    expect(promoted.ok).toBe(true);
    await declineAction(adeps(), ctx, proposed.id);
    // A draft matched to a sent message: the sweep proposes and, promoted, applies.
    const { autoActions } = await import("../../src/actions.js");
    const before = sf.created;
    const r = await autoActions(adeps(), ctx, [
      { ...sentBob, message_external_id: "waiting-sent-5" },
    ]);
    expect(r).toEqual({ proposed: 1, auto_applied: 1, auto_failed: 0 });
    expect(sf.created).toBe(before + 1);
    const auto = (await listActions(client.sql, ctx)).find(
      (a) => a.message_external_id === "waiting-sent-5",
    )!;
    expect(auto).toMatchObject({ status: "verified", approved_by: "promotion" });
    // The organization disables the capability: proposals stop, and nothing runs.
    policy = orgPolicySchema.parse({
      ...DEFAULT_ORG_POLICY,
      disabled_capabilities: ["salesforce.log_activity"],
    });
    const blocked = await autoActions(adeps(), ctx, [
      { ...sentBob, message_external_id: "waiting-sent-6" },
    ]);
    expect(blocked).toEqual({ proposed: 0, auto_applied: 0, auto_failed: 0 });
    policy = DEFAULT_ORG_POLICY;
  });

  it("in the sweep: a draft the person sent becomes a proposal, and a colleague sees none of it", async () => {
    // A fresh draft on the Proposal thread, then Alice "sends" it.
    const t = await withUser(
      client.sql,
      ctx,
      (tx) => tx`SELECT id FROM threads WHERE external_id = 'waiting'`,
    );
    const tid = t[0]!["id"] as string;
    const pending = await listPendingObligations(client.sql, ctx, 50);
    const proposal = pending.find((o) => o.thread_id === tid);
    await recordDraftRow(client.sql, ctx, {
      obligation_id: proposal?.id ?? (null as unknown as string),
      thread_id: tid,
      gmail_draft_id: "gd-act",
      subject: "Re: Proposal",
      body_ciphertext: encryptBody("Hi Bob, checking in.", master, ctx),
      body_chars: 20,
      composer: "model",
    });
    // The earlier "sent" fixture sits a minute in the future and the sync
    // would write it again; move it into the past in the mailbox itself so
    // the message below is the first one after this draft.
    const earlier = (
      MAILBOX["waiting"] as { messages: Array<{ id: string; internalDate: string }> }
    ).messages.find((m) => m.id === "waiting-sent");
    if (earlier) earlier.internalDate = ago(1);
    (MAILBOX["waiting"] as { historyId: string }).historyId = "h-waiting-act";
    (MAILBOX["waiting"] as { messages: unknown[] }).messages.push({
      id: "waiting-sent-7",
      internalDate: String(Date.now() + 120_000),
      payload: {
        headers: [
          { name: "From", value: "alice@co.example" },
          { name: "To", value: "bob@client.com" },
          { name: "Subject", value: "Re: Proposal" },
        ],
        mimeType: "text/plain",
        body: { data: Buffer.from("Hi Bob, checking in!").toString("base64url") },
      },
    });
    const r = await runGmailSyncJob(
      { ...deps(), actions: { writer: adeps().writer, orgPolicy: async () => policy } },
      ctx,
    );
    expect(r.ok && r.drafts_matched).toBe(1);
    expect(r.ok && r.actions).toMatchObject({ proposed: 1 });
    const matched = await sentFromMatchedDrafts({ sql: client.sql }, ctx, [
      { thread_id: tid, sent_external_id: "waiting-sent-7", sent_at: NOW.toISOString() },
    ]);
    // The reply carried "Re: Proposal", and the thread's subject follows its last message.
    expect(matched[0]).toMatchObject({ contact_email: "bob@client.com", subject: "Re: Proposal" });
    expect(await listActions(client.sql, { organizationId: orgId, userId: bob })).toEqual([]);
  });
});
