import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { uuidv7 } from "@maman/contracts";
import { addMembership, globalCreateOrganization, globalCreateUser } from "../../src/index.js";
import { withUser } from "../../src/tenant.js";
import {
  applyDealAnswer,
  listContactAddresses,
  listPendingObligations,
  loadDetectionInputs,
  replacePendingObligations,
  setObligationOutcome,
  upsertSyncedThreads,
  upsertThreadAssessment,
  getThreadMessages,
  listContactThreads,
  listRecentOutboundMessages,
  listThreadHistoryIds,
  listOutboundFollowUps,
  listOutboundMessagesForContact,
  recordDraft,
  listUnmatchedDrafts,
  matchDraftToSent,
  draftOutcomes,
  upsertSyncedMeetings,
  refreshContactMeetingStamps,
  listContactMeetings,
  getCalendarSyncToken,
  setCalendarSyncToken,
  createIntent,
  listIntents,
  retireIntent,
  listSkippedObligations,
  loadEventFacts,
  recordWorkflowEvents,
  listWorkflowEvents,
  latestWorkflowEventWrite,
  countWorkflowEvents,
  upsertRoutineCandidates,
  listRoutineCandidates,
  dismissRoutine,
  recentlyDismissedRoutines,
  setRoutineAgent,
  createRoutineRun,
  completeRoutineRun,
  listRoutineRuns,
  type SyncedThread,
} from "../../src/workspace.js";
import { startTestDb, type TestDb } from "./setup.js";

let db: TestDb;
const orgId = uuidv7();
const userId = uuidv7();
const connId = uuidv7();
const ctx = { organizationId: orgId, userId };

const T = (over: Partial<SyncedThread> = {}): SyncedThread => ({
  external_id: "gm-1",
  subject: "Pricing",
  last_message_at: "2026-09-10T09:00:00.000Z",
  last_direction: "outbound",
  message_count: 2,
  contact: { address: "bob@client.com" },
  ...over,
});

beforeAll(async () => {
  db = await startTestDb();
  const { sql } = db.client;
  await globalCreateOrganization(sql, {
    id: orgId,
    workos_organization_id: `wk_${orgId}`,
    name: "Co",
    status: "active",
    default_timezone: "UTC",
  });
  await globalCreateUser(sql, {
    id: userId,
    workos_user_id: `wu_${userId}`,
    email: "me@co.example",
    display_name: "Me",
  });
  await addMembership(sql, { organizationId: orgId }, { user_id: userId, role: "member" });
  await withUser(sql, ctx, async (tx) => {
    await tx`
      INSERT INTO user_connections
        (id, organization_id, owner_user_id, provider, external_account_label,
         encrypted_credentials, scopes, status)
      VALUES (${connId}, ${orgId}, ${userId}, 'gmail', 'me@gmail',
              ${Buffer.from("ct")}, ARRAY['read'], 'active')
    `;
  });
}, 240_000);

afterAll(async () => {
  await db?.stop();
});

describe("workspace repository", () => {
  it("upserts contacts and threads from a sync, idempotently", async () => {
    const first = await upsertSyncedThreads(db.client.sql, ctx, {
      connection_id: connId,
      threads: [T(), T({ external_id: "gm-2", contact: { address: "carol@client.com" } })],
    });
    expect(first).toEqual({ contacts: 2, threads: 2, messages: 0 });

    // Same input again: nothing duplicated.
    await upsertSyncedThreads(db.client.sql, ctx, {
      connection_id: connId,
      threads: [T(), T({ external_id: "gm-2", contact: { address: "carol@client.com" } })],
    });
    const inputs = await loadDetectionInputs(db.client.sql, ctx);
    expect(inputs.threads).toHaveLength(2);
    expect(inputs.contacts).toHaveLength(2);
  });

  it("a contact synced from mail alone has UNKNOWN deal state, not closed", async () => {
    // The 0009 fix, observed end to end. `false` here would make the detector
    // suppress every obligation for a Gmail-only user.
    const inputs = await loadDetectionInputs(db.client.sql, ctx);
    for (const c of inputs.contacts) expect(c.has_open_deal).toBeNull();
  });

  it("updates a thread in place when it moves on", async () => {
    await upsertSyncedThreads(db.client.sql, ctx, {
      connection_id: connId,
      threads: [
        T({
          last_message_at: "2026-09-12T09:00:00.000Z",
          last_direction: "inbound",
          message_count: 3,
        }),
      ],
    });
    const { threads } = await loadDetectionInputs(db.client.sql, ctx);
    const t = threads.find((x) => x.subject === "Pricing")!;
    expect(t.last_direction).toBe("inbound");
    expect(t.message_count).toBe(3);
    expect(t.last_message_at).toBe("2026-09-12T09:00:00.000Z");
  });

  it("a real display name replaces a bare address, and a bare address never replaces a name", async () => {
    await upsertSyncedThreads(db.client.sql, ctx, {
      connection_id: connId,
      threads: [T({ contact: { address: "bob@client.com", display_name: "Bob Jones" } })],
    });
    let { contacts } = await loadDetectionInputs(db.client.sql, ctx);
    expect(contacts.find((c) => c.display_name === "Bob Jones")).toBeDefined();

    await upsertSyncedThreads(db.client.sql, ctx, {
      connection_id: connId,
      threads: [T({ contact: { address: "bob@client.com" } })],
    });
    ({ contacts } = await loadDetectionInputs(db.client.sql, ctx));
    expect(contacts.find((c) => c.display_name === "Bob Jones")).toBeDefined();
    expect(contacts.find((c) => c.display_name === "bob@client.com")).toBeUndefined();
  });

  it("replaces pending obligations but keeps ones the user already decided about", async () => {
    const { threads, contacts } = await loadDetectionInputs(db.client.sql, ctx);
    // Pick by identity, not position: the Bob thread is the one whose contact
    // has a real display name, which the last assertion depends on.
    const bobId = contacts.find((c) => c.display_name === "Bob Jones")!.contact_id;
    const t1 = threads.find((x) => x.contact_id === bobId)!;
    const t2 = threads.find((x) => x.contact_id !== bobId)!;
    const mk = (thread_id: string, rank: number) => ({
      thread_id,
      contact_id: contacts.find(
        (c) => c.contact_id === threads.find((t) => t.thread_id === thread_id)!.contact_id,
      )!.contact_id,
      kind: "awaiting_them" as const,
      rank,
      reason: { why: "test" },
    });

    const r1 = await replacePendingObligations(
      db.client.sql,
      ctx,
      [mk(t1!.thread_id, 40), mk(t2!.thread_id, 30)],
      new Date(),
    );
    expect(r1).toEqual({ written: 2, kept_decided: 0, skipped: 0 });

    // The user snoozes one.
    await withUser(db.client.sql, ctx, async (tx) => {
      await tx`UPDATE obligations SET outcome = 'snoozed' WHERE thread_id = ${t2!.thread_id}`;
    });

    // Next sweep detects both again.
    const r2 = await replacePendingObligations(
      db.client.sql,
      ctx,
      [mk(t1!.thread_id, 45), mk(t2!.thread_id, 35)],
      new Date(),
    );
    // The snoozed one is NOT re-surfaced — a reminder, not a nag.
    expect(r2).toEqual({ written: 1, kept_decided: 1, skipped: 0 });

    const pending = await listPendingObligations(db.client.sql, ctx);
    expect(pending.map((p) => p.thread_id)).toEqual([t1!.thread_id]);
    expect(pending[0]!.rank).toBe(45);
    expect(pending[0]!.contact_display_name).toBe("Bob Jones");
  });

  it("a decision holds while the thread stands still, and lifts once it moves", async () => {
    await upsertSyncedThreads(db.client.sql, ctx, {
      connection_id: connId,
      threads: [
        T({
          external_id: "gm-moves",
          subject: "Moves",
          last_message_at: "2026-09-10T09:00:00.000Z",
        }),
      ],
    });
    const inputs = await loadDetectionInputs(db.client.sql, ctx);
    const thread = inputs.threads.find((t) => t.subject === "Moves")!;
    const detected = {
      thread_id: thread.thread_id,
      contact_id: thread.contact_id,
      kind: "awaiting_them" as const,
      rank: 40,
      reason: {
        kind: "awaiting_them",
        days_elapsed: 6,
        threshold_days: 5,
        last_direction: "outbound",
        message_count: 2,
        has_open_deal: null,
      },
    };
    await replacePendingObligations(
      db.client.sql,
      ctx,
      [detected],
      new Date("2026-09-16T09:00:00.000Z"),
    );
    const pending = (await listPendingObligations(db.client.sql, ctx)).find(
      (o) => o.thread_id === thread.thread_id,
    )!;
    expect(await setObligationOutcome(db.client.sql, ctx, pending.id, "dismissed")).toBe(true);
    // The fixture's clock: the decision was made on the 16th.
    await withUser(db.client.sql, ctx, async (tx) => {
      await tx`UPDATE obligations SET updated_at = '2026-09-16T10:00:00Z' WHERE id = ${pending.id}`;
    });
    // Same thread, next sweep: still dismissed, not raised again.
    const kept = await replacePendingObligations(
      db.client.sql,
      ctx,
      [detected],
      new Date("2026-09-17T09:00:00.000Z"),
    );
    expect(kept.kept_decided).toBe(1);
    expect(
      (await listPendingObligations(db.client.sql, ctx)).some(
        (o) => o.thread_id === thread.thread_id,
      ),
    ).toBe(false);
    // The thread moves: they wrote again. The decision was about the old thread.
    await upsertSyncedThreads(db.client.sql, ctx, {
      connection_id: connId,
      threads: [
        T({
          external_id: "gm-moves",
          subject: "Moves",
          last_message_at: "2026-09-18T09:00:00.000Z",
          last_direction: "inbound",
          message_count: 3,
        }),
      ],
    });
    const raised = await replacePendingObligations(
      db.client.sql,
      ctx,
      [{ ...detected, kind: "awaiting_you" as const }],
      new Date("2026-09-19T09:00:00.000Z"),
    );
    expect(raised.written).toBe(1);
    expect(
      (await listPendingObligations(db.client.sql, ctx)).find(
        (o) => o.thread_id === thread.thread_id,
      )?.kind,
    ).toBe("awaiting_you");
  });

  it("lists most urgent first with the thread and contact joined in", async () => {
    const { threads } = await loadDetectionInputs(db.client.sql, ctx);
    // Reset to two pending with distinct ranks.
    await withUser(db.client.sql, ctx, async (tx) => {
      await tx`DELETE FROM obligations`;
    });
    const rows = threads.map((t, i) => ({
      thread_id: t.thread_id,
      contact_id: t.contact_id,
      kind: "awaiting_them" as const,
      rank: 10 + i * 10,
      reason: {},
    }));
    await replacePendingObligations(db.client.sql, ctx, rows, new Date());
    const pending = await listPendingObligations(db.client.sql, ctx);
    expect(pending.map((p) => p.rank)).toEqual(rows.map((r) => r.rank).sort((a, b) => b - a));
    expect(pending[0]!.subject).toBeTruthy();
  });

  it("another user in the same org reads none of it", async () => {
    // Every function above runs under withUser; this is the assertion that
    // the workspace repository inherits the isolation rather than bypassing it.
    const other = uuidv7();
    await globalCreateUser(db.client.sql, {
      id: other,
      workos_user_id: `wu_${other}`,
      email: "other@co.example",
      display_name: "Other",
    });
    await addMembership(
      db.client.sql,
      { organizationId: orgId },
      { user_id: other, role: "member" },
    );
    const theirs = await loadDetectionInputs(db.client.sql, {
      organizationId: orgId,
      userId: other,
    });
    expect(theirs).toEqual({ threads: [], contacts: [] });
    expect(
      await listPendingObligations(db.client.sql, { organizationId: orgId, userId: other }),
    ).toEqual([]);
  });
});

describe("deal state from a CRM", () => {
  const stateOf = async (address: string, who = ctx) => {
    const c = (await loadDetectionInputs(db.client.sql, who)).contacts;
    const rows = await withUser(
      db.client.sql,
      who,
      (tx) => tx`SELECT id FROM contacts WHERE external_id = ${address}`,
    );
    const found = c.find((x) => x.contact_id === rows[0]?.["id"]);
    return found
      ? {
          has_open_deal: found.has_open_deal,
          open_deal_value: found.open_deal_value,
          account_name: found.account_name,
        }
      : undefined;
  };

  it("lists this person's contact addresses, sorted, as the question for a CRM", async () => {
    await upsertSyncedThreads(db.client.sql, ctx, {
      connection_id: connId,
      threads: [
        T({ external_id: "gm-ann", contact: { address: "ann@acme.com" } }),
        T({ external_id: "gm-zed", contact: { address: "zed@nowhere.com" } }),
      ],
    });
    const addresses = await listContactAddresses(db.client.sql, ctx);
    expect(addresses).toEqual([...addresses].sort());
    expect(addresses).toEqual(
      expect.arrayContaining(["ann@acme.com", "bob@client.com", "zed@nowhere.com"]),
    );
  });

  it("writes open, closed, and — for the asked-but-unmentioned — UNKNOWN, never closed", async () => {
    const result = await applyDealAnswer(db.client.sql, ctx, {
      asked: ["ann@acme.com", "bob@client.com", "zed@nowhere.com", "ghost@none.com"],
      signals: [
        {
          address: "ann@acme.com",
          has_open_deal: true,
          open_deal_value: 48_000,
          account_name: "Acme",
        },
        { address: "bob@client.com", has_open_deal: false },
      ],
    });
    expect(result).toEqual({ open: 1, closed: 1, unknown: 1, untouched: 1 });
    expect(await stateOf("ann@acme.com")).toEqual({
      has_open_deal: true,
      open_deal_value: 48_000,
      account_name: "Acme",
    });
    expect(await stateOf("bob@client.com")).toMatchObject({ has_open_deal: false });
    // zed is not in the CRM. That is not a closed relationship.
    expect(await stateOf("zed@nowhere.com")).toMatchObject({ has_open_deal: null });
  });

  it("leaves an address that was not asked alone, and ignores a signal for one", async () => {
    await upsertSyncedThreads(db.client.sql, ctx, {
      connection_id: connId,
      threads: [T({ external_id: "gm-quiet", contact: { address: "quiet@x.com" } })],
    });
    await applyDealAnswer(db.client.sql, ctx, {
      asked: ["ann@acme.com"],
      signals: [
        { address: "ann@acme.com", has_open_deal: true, open_deal_value: 10_000 },
        { address: "quiet@x.com", has_open_deal: true, open_deal_value: 1 },
      ],
    });
    expect(await stateOf("quiet@x.com")).toMatchObject({ has_open_deal: null });
    // The value is one observation with "open": replaced, not merged.
    expect(await stateOf("ann@acme.com")).toMatchObject({
      has_open_deal: true,
      open_deal_value: 10_000,
    });
  });

  it("an account name fills a blank and never overwrites; a deal that disappears goes back to unknown", async () => {
    await applyDealAnswer(db.client.sql, ctx, {
      asked: ["ann@acme.com", "zed@nowhere.com"],
      signals: [
        {
          address: "ann@acme.com",
          has_open_deal: true,
          open_deal_value: 10_000,
          account_name: "Other",
        },
        {
          address: "zed@nowhere.com",
          has_open_deal: true,
          open_deal_value: 5,
          account_name: "Zed Co",
        },
      ],
    });
    expect(await stateOf("ann@acme.com")).toMatchObject({ account_name: "Acme" });
    expect(await stateOf("zed@nowhere.com")).toMatchObject({
      account_name: "Zed Co",
      open_deal_value: 5,
    });
    await applyDealAnswer(db.client.sql, ctx, { asked: ["ann@acme.com"], signals: [] });
    expect(await stateOf("ann@acme.com")).toMatchObject({
      has_open_deal: null,
      open_deal_value: undefined,
      account_name: "Acme",
    });
  });

  it("a colleague's contact with the same address is not touched", async () => {
    const other = uuidv7();
    const otherConn = uuidv7();
    const theirs = { organizationId: orgId, userId: other };
    await globalCreateUser(db.client.sql, {
      id: other,
      workos_user_id: `wu_${other}`,
      email: "peer@co.example",
      display_name: "Peer",
    });
    await addMembership(
      db.client.sql,
      { organizationId: orgId },
      { user_id: other, role: "member" },
    );
    await withUser(db.client.sql, theirs, async (tx) => {
      await tx`
        INSERT INTO user_connections
          (id, organization_id, owner_user_id, provider, external_account_label,
           encrypted_credentials, scopes, status)
        VALUES (${otherConn}, ${orgId}, ${other}, 'gmail', 'peer@gmail',
                ${Buffer.from("ct")}, ARRAY['read'], 'active')
      `;
    });
    await upsertSyncedThreads(db.client.sql, theirs, {
      connection_id: otherConn,
      threads: [T({ external_id: "gm-peer", contact: { address: "ann@acme.com" } })],
    });
    await applyDealAnswer(db.client.sql, ctx, {
      asked: ["ann@acme.com"],
      signals: [{ address: "ann@acme.com", has_open_deal: true, open_deal_value: 99 }],
    });
    expect(await stateOf("ann@acme.com")).toMatchObject({
      has_open_deal: true,
      open_deal_value: 99,
    });
    expect(await stateOf("ann@acme.com", theirs)).toMatchObject({ has_open_deal: null });
    expect(await listContactAddresses(db.client.sql, theirs)).toEqual(["ann@acme.com"]);
  });
});

describe("the agent's judgment beside the arithmetic", () => {
  const sql = () => db.client.sql;
  const threadIdOf = async (external: string) =>
    (
      await withUser(sql(), ctx, (tx) => tx`SELECT id FROM threads WHERE external_id = ${external}`)
    )[0]!["id"] as string;
  const judged = (owed: boolean, urgency: "high" | "normal" | "low") => ({
    owed,
    ask: owed ? "the contract" : "",
    summary: owed ? "They are waiting on the contract." : "Nothing is owed.",
    urgency,
    confidence: 0.8,
  });
  let t1 = "",
    t2 = "",
    t3 = "",
    t4 = "";

  it("is stored per thread state and comes back on the list without changing the arithmetic order", async () => {
    await upsertSyncedThreads(sql(), ctx, {
      connection_id: connId,
      threads: [
        T({
          external_id: "ag-1",
          subject: "One",
          last_direction: "inbound",
          contact: { address: "one@x.com" },
          last_message_at: "2026-09-10T09:00:00.000Z",
        }),
        T({
          external_id: "ag-2",
          subject: "Two",
          last_direction: "inbound",
          contact: { address: "two@x.com" },
          last_message_at: "2026-09-11T09:00:00.000Z",
        }),
        T({
          external_id: "ag-4",
          subject: "Four",
          last_direction: "inbound",
          contact: { address: "four@x.com" },
          last_message_at: "2026-09-12T09:00:00.000Z",
        }),
        T({
          external_id: "ag-3",
          subject: "Three",
          last_direction: "outbound",
          contact: { address: "three@x.com" },
          last_message_at: "2026-09-05T09:00:00.000Z",
        }),
      ],
    });
    t1 = await threadIdOf("ag-1");
    t2 = await threadIdOf("ag-2");
    t4 = await threadIdOf("ag-4");
    t3 = await threadIdOf("ag-3");
    const inputs = await loadDetectionInputs(sql(), ctx);
    const contactOf = (tid: string) => inputs.threads.find((t) => t.thread_id === tid)!.contact_id;
    const reason = (days: number) => ({ days_elapsed: days, threshold_days: 2 });
    await replacePendingObligations(
      sql(),
      ctx,
      [
        {
          thread_id: t1,
          contact_id: contactOf(t1),
          kind: "awaiting_you",
          rank: 105,
          reason: reason(11),
        },
        {
          thread_id: t2,
          contact_id: contactOf(t2),
          kind: "awaiting_you",
          rank: 104,
          reason: reason(10),
        },
        {
          thread_id: t4,
          contact_id: contactOf(t4),
          kind: "awaiting_you",
          rank: 103,
          reason: reason(9),
        },
        {
          thread_id: t3,
          contact_id: contactOf(t3),
          kind: "awaiting_them",
          rank: 40,
          reason: reason(16),
        },
      ],
      new Date("2026-09-21T12:00:00.000Z"),
    );
    const at = (tid: string) => inputs.threads.find((t) => t.thread_id === tid)!.last_message_at;
    await upsertThreadAssessment(sql(), ctx, {
      thread_id: t1,
      assessed_last_message_at: at(t1),
      assessment: judged(false, "low"),
      model_alias: "demo",
    });
    await upsertThreadAssessment(sql(), ctx, {
      thread_id: t2,
      assessed_last_message_at: at(t2),
      assessment: judged(true, "normal"),
      model_alias: "demo",
    });
    await upsertThreadAssessment(sql(), ctx, {
      thread_id: t4,
      assessed_last_message_at: at(t4),
      assessment: judged(true, "high"),
      model_alias: "demo",
    });
    await upsertThreadAssessment(sql(), ctx, {
      thread_id: t3,
      assessed_last_message_at: at(t3),
      assessment: judged(true, "low"),
      model_alias: "demo",
    });

    const off = await listPendingObligations(sql(), ctx, 50);
    expect(off.map((o) => o.thread_id)).toEqual([t1, t2, t4, t3]);
    expect(off[0]!.assessment).toMatchObject({ owed: false });
    expect(off[1]!.assessment).toMatchObject({ owed: true, urgency: "normal" });
  });

  it("with the agent on: not-owed is hidden, urgency reorders within a band, never across one", async () => {
    const on = await listPendingObligations(sql(), ctx, 50, { agent: true });
    expect(on.map((o) => o.thread_id)).toEqual([t4, t2, t3]);
  });

  it("a judgment goes stale the moment the thread moves, and the item keeps its arithmetic place", async () => {
    await upsertSyncedThreads(sql(), ctx, {
      connection_id: connId,
      threads: [
        T({
          external_id: "ag-1",
          subject: "One",
          last_direction: "inbound",
          contact: { address: "one@x.com" },
          last_message_at: "2026-09-20T09:00:00.000Z",
          message_count: 3,
        }),
      ],
    });
    const on = await listPendingObligations(sql(), ctx, 50, { agent: true });
    // t1 was "not owed" for the OLD state; now unjudged, so it shows again.
    // Unjudged counts as normal urgency, so the judged-high t4 still leads it.
    expect(on.map((o) => o.thread_id)).toEqual([t4, t1, t2, t3]);
    expect(on[1]!.assessment).toBeNull();
    // Judging it again replaces the row, no duplicate.
    await upsertThreadAssessment(sql(), ctx, {
      thread_id: t1,
      assessed_last_message_at: "2026-09-20T09:00:00.000Z",
      assessment: judged(true, "high"),
      model_alias: "demo",
    });
    const rows = await withUser(
      sql(),
      ctx,
      (tx) => tx`SELECT count(*)::int AS n FROM thread_assessments WHERE thread_id = ${t1}`,
    );
    expect(rows[0]!["n"]).toBe(1);
    expect(
      (await listPendingObligations(sql(), ctx, 50, { agent: true }))[0]!.assessment,
    ).toMatchObject({ urgency: "high" });
  });

  it("a colleague reads none of it", async () => {
    const other = uuidv7();
    await globalCreateUser(sql(), {
      id: other,
      workos_user_id: `wu_${other}`,
      email: "peer2@co.example",
      display_name: "Peer",
    });
    await addMembership(sql(), { organizationId: orgId }, { user_id: other, role: "member" });
    const theirs = { organizationId: orgId, userId: other };
    expect(
      await withUser(sql(), theirs, (tx) => tx`SELECT count(*)::int AS n FROM thread_assessments`),
    ).toEqual([{ n: 0 }]);
  });
});

describe("stored messages", () => {
  const sql = () => db.client.sql;
  const ct = (s: string) => Buffer.from(`enc:${s}`);
  it("stores content beside the thread, replaces a message seen again, and reports history ids", async () => {
    const r = await upsertSyncedThreads(sql(), ctx, {
      connection_id: connId,
      threads: [
        T({
          external_id: "gm-msg",
          history_id: "h-1",
          contact: { address: "pat@x.com" },
          messages: [
            {
              external_id: "m1",
              from_address: "me@co.example",
              direction: "outbound",
              sent_at: "2026-09-10T09:00:00.000Z",
              body_ciphertext: ct("first, a long enough outbound message to count as writing"),
              body_chars: 120,
            },
            {
              external_id: "m2",
              from_address: "pat@x.com",
              from_display_name: "Pat",
              direction: "inbound",
              sent_at: "2026-09-11T09:00:00.000Z",
              body_ciphertext: ct("reply"),
              body_chars: 5,
            },
          ],
        }),
      ],
    });
    expect(r).toMatchObject({ threads: 1, messages: 2 });
    expect(await listThreadHistoryIds(sql(), ctx, connId)).toEqual(new Map([["gm-msg", "h-1"]]));
    const tid = (
      await withUser(sql(), ctx, (tx) => tx`SELECT id FROM threads WHERE external_id = 'gm-msg'`)
    )[0]!["id"] as string;
    const rows = await getThreadMessages(sql(), ctx, tid);
    expect(
      rows.map((m) => [
        m.external_id,
        m.direction,
        m.from_display_name,
        Buffer.from(m.body_ciphertext).toString(),
      ]),
    ).toEqual([
      ["m1", "outbound", null, "enc:first, a long enough outbound message to count as writing"],
      ["m2", "inbound", "Pat", "enc:reply"],
    ]);
    await upsertSyncedThreads(sql(), ctx, {
      connection_id: connId,
      threads: [
        T({
          external_id: "gm-msg",
          history_id: "h-2",
          contact: { address: "pat@x.com" },
          messages: [
            {
              external_id: "m2",
              from_address: "pat@x.com",
              direction: "inbound",
              sent_at: "2026-09-11T09:00:00.000Z",
              body_ciphertext: ct("reply, corrected"),
              body_chars: 16,
            },
          ],
        }),
      ],
    });
    const again = await getThreadMessages(sql(), ctx, tid);
    expect(again).toHaveLength(2);
    expect(Buffer.from(again[1]!.body_ciphertext).toString()).toBe("enc:reply, corrected");
    expect((await listThreadHistoryIds(sql(), ctx, connId)).get("gm-msg")).toBe("h-2");
  });

  it("the relationship so far excludes the thread being judged; the voice sample is outbound and substantial", async () => {
    await upsertSyncedThreads(sql(), ctx, {
      connection_id: connId,
      threads: [
        T({
          external_id: "gm-msg-2",
          subject: "Earlier",
          last_message_at: "2026-08-01T09:00:00.000Z",
          contact: { address: "pat@x.com" },
        }),
      ],
    });
    const inputs = await loadDetectionInputs(sql(), ctx);
    const current = inputs.threads.find(
      (t) =>
        t.subject === "Pricing" &&
        t.contact_id === inputs.threads.find((x) => x.subject === "Earlier")!.contact_id,
    )!;
    const history = await listContactThreads(sql(), ctx, current.contact_id, {
      exclude_thread_id: current.thread_id,
    });
    expect(history.map((h) => h.subject)).toEqual(["Earlier"]);
    const voice = await listRecentOutboundMessages(sql(), ctx, { min_chars: 80 });
    expect(voice.map((m) => m.external_id)).toEqual(["m1"]);
  });

  it("a colleague reads no messages, and the thread's messages go with the thread", async () => {
    const other = uuidv7();
    await globalCreateUser(sql(), {
      id: other,
      workos_user_id: `wu_${other}`,
      email: "peer3@co.example",
      display_name: "Peer",
    });
    await addMembership(sql(), { organizationId: orgId }, { user_id: other, role: "member" });
    expect(
      await withUser(
        sql(),
        { organizationId: orgId, userId: other },
        (tx) => tx`SELECT count(*)::int AS n FROM messages`,
      ),
    ).toEqual([{ n: 0 }]);
    await withUser(sql(), ctx, (tx) => tx`DELETE FROM threads WHERE external_id = 'gm-msg'`);
    expect(
      await withUser(
        sql(),
        ctx,
        (tx) => tx`SELECT count(*)::int AS n FROM messages WHERE external_id IN ('m1','m2')`,
      ),
    ).toEqual([{ n: 0 }]);
  });
});

describe("voice retrieval and the record of drafts", () => {
  const sql = () => db.client.sql;
  const ct = (s: string) => Buffer.from(`enc:${s}`);
  const msg = (
    external_id: string,
    direction: "inbound" | "outbound",
    sent_at: string,
    chars = 100,
  ) => ({
    external_id,
    from_address: direction === "outbound" ? "me@co.example" : "kim@x.com",
    direction,
    sent_at,
    body_ciphertext: ct(external_id),
    body_chars: chars,
  });
  let kimContact = "";
  let threadId = "";
  let obligationId = "";

  it("finds the person's messages to one contact, and their past follow-ups (a message after their own)", async () => {
    await upsertSyncedThreads(sql(), ctx, {
      connection_id: connId,
      threads: [
        T({
          external_id: "v-1",
          subject: "Kim thread",
          contact: { address: "kim@x.com" },
          last_message_at: "2026-09-04T09:00:00.000Z",
          messages: [
            msg("k1", "outbound", "2026-09-01T09:00:00.000Z"),
            msg("k2", "outbound", "2026-09-02T09:00:00.000Z"), // a chase: after my own
            msg("k3", "inbound", "2026-09-03T09:00:00.000Z"),
            msg("k4", "outbound", "2026-09-04T09:00:00.000Z"), // a reply, not a chase
            msg("k5", "outbound", "2026-09-04T10:00:00.000Z", 10), // too short to count as writing
          ],
        }),
      ],
    });
    const inputs = await loadDetectionInputs(sql(), ctx);
    const kim = inputs.threads.find((t) => t.subject === "Kim thread")!;
    kimContact = kim.contact_id;
    threadId = kim.thread_id;
    const toKim = await listOutboundMessagesForContact(sql(), ctx, kimContact, { limit: 3 });
    expect(toKim.map((m) => m.external_id)).toEqual(["k4", "k2", "k1"]);
    const chases = await listOutboundFollowUps(sql(), ctx, { limit: 5 });
    expect(chases.map((m) => m.external_id)).toEqual(["k2"]);
  });

  it("records a draft encrypted, matches it to the message the person then sent, and measures the edit", async () => {
    await replacePendingObligations(
      sql(),
      ctx,
      [
        {
          thread_id: threadId,
          contact_id: kimContact,
          kind: "awaiting_them",
          rank: 40,
          reason: { days_elapsed: 6 },
        },
      ],
      new Date("2026-09-10T12:00:00.000Z"),
    );
    obligationId = (await listPendingObligations(sql(), ctx)).find(
      (o) => o.thread_id === threadId,
    )!.id;
    const { id } = await recordDraft(sql(), ctx, {
      obligation_id: obligationId,
      thread_id: threadId,
      gmail_draft_id: "gd-1",
      subject: "Re: Kim thread",
      body_ciphertext: ct("draft body"),
      body_chars: 10,
      composer: "model",
      model_alias: "m",
    });
    expect((await listUnmatchedDrafts(sql(), ctx)).map((d) => d.id)).toEqual([id]);
    await matchDraftToSent(sql(), ctx, id, {
      external_id: "k9",
      sent_at: "2026-09-11T09:00:00.000Z",
      edit_ratio: 0.925,
    });
    expect(await listUnmatchedDrafts(sql(), ctx)).toEqual([]);
    expect(await draftOutcomes(sql(), ctx)).toEqual({
      drafted: 1,
      sent: 1,
      sent_as_written: 1,
      mean_edit_ratio: 0.925,
    });
    // Since a moment in the future: nothing. The week's numbers are a window.
    expect(await draftOutcomes(sql(), ctx, { since: new Date(Date.now() + 60_000) })).toEqual({
      drafted: 0,
      sent: 0,
      sent_as_written: 0,
      mean_edit_ratio: null,
    });
    const raw = await withUser(
      sql(),
      ctx,
      (tx) => tx`SELECT body_ciphertext::text AS b FROM drafts`,
    );
    expect(String(raw[0]!["b"])).not.toContain("draft body");
  });

  it("a colleague sees no drafts and no voice", async () => {
    const other = uuidv7();
    await globalCreateUser(sql(), {
      id: other,
      workos_user_id: `wu_${other}`,
      email: "peer4@co.example",
      display_name: "Peer",
    });
    await addMembership(sql(), { organizationId: orgId }, { user_id: other, role: "member" });
    const theirs = { organizationId: orgId, userId: other };
    expect(await listUnmatchedDrafts(sql(), theirs)).toEqual([]);
    expect(await listOutboundMessagesForContact(sql(), theirs, kimContact)).toEqual([]);
    expect(await listOutboundFollowUps(sql(), theirs)).toEqual([]);
  });
});

describe("meetings", () => {
  const sql = () => db.client.sql;
  const NOW = new Date("2026-09-21T12:00:00.000Z");
  const meeting = (external_id: string, starts_at: string, over: Record<string, unknown> = {}) => ({
    external_id,
    title: `Meeting ${external_id}`,
    description_ciphertext: Buffer.from(`enc:${external_id}`),
    description_chars: 5,
    starts_at,
    ends_at: starts_at,
    all_day: false,
    organizer_address: "me@co.example",
    attendees: [{ address: "ann@acme.com", display_name: "Ann" }],
    self_response: "accepted" as const,
    status: "confirmed" as const,
    ...over,
  });

  it("stores meetings, marks cancellations, and stamps each contact with the last and next meeting", async () => {
    const r = await upsertSyncedMeetings(sql(), ctx, {
      connection_id: connId,
      meetings: [
        meeting("past", "2026-09-17T15:00:00.000Z"),
        meeting("older", "2026-09-10T15:00:00.000Z"),
        meeting("soon", "2026-09-24T15:00:00.000Z"),
        meeting("later", "2026-09-30T15:00:00.000Z"),
        meeting("declined", "2026-09-22T15:00:00.000Z", { self_response: "declined" }),
        meeting("gone", "2026-09-23T15:00:00.000Z"),
      ],
    });
    expect(r).toEqual({ meetings: 6, cancelled: 0 });
    const c = await upsertSyncedMeetings(sql(), ctx, {
      connection_id: connId,
      meetings: [],
      cancelled: ["gone", "never-seen"],
    });
    expect(c).toEqual({ meetings: 0, cancelled: 1 });
    const stamped = await refreshContactMeetingStamps(sql(), ctx, NOW);
    expect(stamped.contacts).toBe(1);
    const rows = await withUser(
      sql(),
      ctx,
      (tx) =>
        tx`SELECT last_meeting_at, last_meeting_title, next_meeting_at, next_meeting_title FROM contacts WHERE external_id = 'ann@acme.com'`,
    );
    expect(rows[0]).toMatchObject({
      last_meeting_title: "Meeting past",
      next_meeting_title: "Meeting soon",
    });
    expect(new Date(rows[0]!["last_meeting_at"] as string).toISOString()).toBe(
      "2026-09-17T15:00:00.000Z",
    );
    expect(new Date(rows[0]!["next_meeting_at"] as string).toISOString()).toBe(
      "2026-09-24T15:00:00.000Z",
    );
    // Running it again with nothing changed touches no row.
    expect((await refreshContactMeetingStamps(sql(), ctx, NOW)).contacts).toBe(0);
  });

  it("lists the meetings with a contact, skipping declined and cancelled, and keeps the sync token per connection", async () => {
    const list = await listContactMeetings(sql(), ctx, "ann@acme.com");
    expect(list.map((m) => m.external_id)).toEqual(["later", "soon", "past", "older"]);
    expect(await getCalendarSyncToken(sql(), ctx, connId)).toBeNull();
    await setCalendarSyncToken(sql(), ctx, connId, "tok-1");
    expect(await getCalendarSyncToken(sql(), ctx, connId)).toBe("tok-1");
  });

  it("a colleague sees no meetings", async () => {
    const other = uuidv7();
    await globalCreateUser(sql(), {
      id: other,
      workos_user_id: `wu_${other}`,
      email: "peer5@co.example",
      display_name: "Peer",
    });
    await addMembership(sql(), { organizationId: orgId }, { user_id: other, role: "member" });
    expect(
      await listContactMeetings(sql(), { organizationId: orgId, userId: other }, "ann@acme.com"),
    ).toEqual([]);
  });
});

describe("the intent store and what it sets aside", () => {
  const sql = () => db.client.sql;
  let intentId = "";
  let threadId = "";
  let contactId = "";

  it("keeps entries as ciphertext with their scope and rule, and retires them", async () => {
    const { id } = await createIntent(sql(), ctx, {
      text_ciphertext: Buffer.from("enc:don't chase acme"),
      text_chars: 16,
      source: "stated",
      scope_kind: "account",
      scope_value: "Acme",
      rule: { kind: "no_chase", scope: { kind: "account", value: "Acme" } },
    });
    intentId = id;
    const active = await listIntents(sql(), ctx);
    expect(active.map((i) => [i.id, i.scope_kind, i.scope_value, i.source])).toEqual([
      [id, "account", "Acme", "stated"],
    ]);
    expect(active[0]!.rule).toEqual({
      kind: "no_chase",
      scope: { kind: "account", value: "Acme" },
    });
    const raw = await withUser(
      sql(),
      ctx,
      (tx) => tx`SELECT text_ciphertext::text AS t FROM intents`,
    );
    expect(String(raw[0]!["t"])).not.toContain("acme");
  });

  it("a skipped detection is stored with the rule that set it aside, and rewritten by the next sweep", async () => {
    await upsertSyncedThreads(sql(), ctx, {
      connection_id: connId,
      threads: [
        T({
          external_id: "sk-1",
          subject: "Skip me",
          contact: { address: "ann@acme.com" },
          chase_count: 2,
        }),
      ],
    });
    const inputs = await loadDetectionInputs(sql(), ctx);
    const t = inputs.threads.find((x) => x.subject === "Skip me")!;
    threadId = t.thread_id;
    contactId = t.contact_id;
    expect(t.chase_count).toBe(2);
    const o = {
      thread_id: threadId,
      contact_id: contactId,
      kind: "awaiting_them" as const,
      rank: 40,
      reason: { days_elapsed: 6 },
    };
    const r = await replacePendingObligations(
      sql(),
      ctx,
      [],
      new Date("2026-09-21T12:00:00.000Z"),
      [{ obligation: o, intent_id: intentId }],
    );
    expect(r).toEqual({ written: 0, kept_decided: 0, skipped: 1 });
    expect(
      (await listSkippedObligations(sql(), ctx)).map((s) => [s.subject, s.applied_intent_id]),
    ).toEqual([["Skip me", intentId]]);
    expect((await listPendingObligations(sql(), ctx)).map((x) => x.thread_id)).not.toContain(
      threadId,
    );
    // The rule is retired; the next sweep brings it back as pending.
    expect(await retireIntent(sql(), ctx, intentId)).toBe(true);
    expect(await retireIntent(sql(), ctx, intentId)).toBe(false);
    expect(await listIntents(sql(), ctx)).toEqual([]);
    await replacePendingObligations(sql(), ctx, [o], new Date("2026-09-21T12:00:00.000Z"));
    expect(await listSkippedObligations(sql(), ctx)).toEqual([]);
    expect((await listPendingObligations(sql(), ctx)).map((x) => x.thread_id)).toContain(threadId);
  });

  it("a colleague sees no intents and cannot retire one", async () => {
    const other = uuidv7();
    await globalCreateUser(sql(), {
      id: other,
      workos_user_id: `wu_${other}`,
      email: "peer6@co.example",
      display_name: "Peer",
    });
    await addMembership(sql(), { organizationId: orgId }, { user_id: other, role: "member" });
    const theirs = { organizationId: orgId, userId: other };
    const { id } = await createIntent(sql(), ctx, {
      text_ciphertext: Buffer.from("x"),
      text_chars: 1,
      source: "stated",
      scope_kind: "global",
    });
    expect(await listIntents(sql(), theirs)).toEqual([]);
    expect(await retireIntent(sql(), theirs, id)).toBe(false);
  });
});

describe("a draft attached to its obligation", () => {
  const sql = () => db.client.sql;
  it("rides on the list until it is matched to what was sent; the newest unsent one wins", async () => {
    await upsertSyncedThreads(sql(), ctx, {
      connection_id: connId,
      threads: [
        T({ external_id: "att-1", subject: "Attached", contact: { address: "att@x.com" } }),
      ],
    });
    const inputs = await loadDetectionInputs(sql(), ctx);
    const t = inputs.threads.find((x) => x.subject === "Attached")!;
    await replacePendingObligations(
      sql(),
      ctx,
      [
        {
          thread_id: t.thread_id,
          contact_id: t.contact_id,
          kind: "awaiting_them",
          rank: 40,
          reason: { days_elapsed: 6 },
        },
      ],
      new Date(),
    );
    const before = (await listPendingObligations(sql(), ctx)).find(
      (o) => o.thread_id === t.thread_id,
    )!;
    expect(before.draft).toBeNull();
    const oblig = before.id;
    await recordDraft(sql(), ctx, {
      obligation_id: oblig,
      thread_id: t.thread_id,
      gmail_draft_id: "d-old",
      gmail_message_id: "m-old",
      mode: "manual",
      subject: "Re: Attached",
      body_ciphertext: Buffer.from("x"),
      body_chars: 1,
      composer: "deterministic",
    });
    const { id: newer } = await recordDraft(sql(), ctx, {
      obligation_id: oblig,
      thread_id: t.thread_id,
      gmail_draft_id: "d-new",
      gmail_message_id: "m-new",
      mode: "auto",
      subject: "Re: Attached",
      body_ciphertext: Buffer.from("y"),
      body_chars: 1,
      composer: "model",
    });
    const withDraft = (await listPendingObligations(sql(), ctx)).find(
      (o) => o.thread_id === t.thread_id,
    )!;
    expect(withDraft.draft).toMatchObject({
      id: newer,
      gmail_draft_id: "d-new",
      gmail_message_id: "m-new",
      mode: "auto",
      composer: "model",
    });
    await matchDraftToSent(sql(), ctx, newer, {
      external_id: "sent-1",
      sent_at: new Date().toISOString(),
      edit_ratio: 1,
    });
    const after = (await listPendingObligations(sql(), ctx)).find(
      (o) => o.thread_id === t.thread_id,
    )!;
    expect(after.draft).toMatchObject({ gmail_draft_id: "d-old" });
  });
});

describe("the event stream", () => {
  const ev = (over: Record<string, unknown> = {}) => ({
    schema_version: 1 as const,
    event_id: uuidv7(),
    device_id: "1b7f4a2e-9c3d-4e5f-8a6b-7c8d9e0f1a2b",
    user_id: userId,
    organization_id: orgId,
    occurred_at: "2026-09-12T09:00:00.000Z",
    monotonic_ms: 1,
    source: "google" as const,
    app: { display_name: "Gmail" },
    event_type: "record_updated" as const,
    target: { role: "sender", semantic_type: "sent_reply" },
    context: { object_type: "email_thread", record_id_hash: "ab".repeat(16) },
    sensitivity: "internal" as const,
    redaction: { applied: false, reasons: [] },
    ...over,
  });

  it("writes an event once per fact: a second write of the same key changes nothing", async () => {
    const before = await countWorkflowEvents(db.client.sql, ctx);
    const first = await recordWorkflowEvents(db.client.sql, ctx, [
      { event: ev(), dedupe_key: "message:t:1" },
    ]);
    expect(first).toEqual({ written: 1, refused: null });
    const again = await recordWorkflowEvents(db.client.sql, ctx, [
      { event: ev(), dedupe_key: "message:t:1" },
    ]);
    expect(again).toEqual({ written: 0, refused: null });
    expect(await countWorkflowEvents(db.client.sql, ctx)).toBe(before + 1);
    expect(await latestWorkflowEventWrite(db.client.sql, ctx)).toBeInstanceOf(Date);
  });

  it("refuses the whole batch when one event breaks the contract, carries a forbidden field, or names another person", async () => {
    const before = await countWorkflowEvents(db.client.sql, ctx);
    const bad = ev({ context: { object_type: "email_thread", body: "hello" } });
    const r1 = await recordWorkflowEvents(db.client.sql, ctx, [
      { event: ev(), dedupe_key: "message:t:2" },
      { event: bad as never, dedupe_key: "message:t:3" },
    ]);
    expect(r1.written).toBe(0);
    expect(r1.refused).toMatch(/contract|forbidden/);
    const r2 = await recordWorkflowEvents(db.client.sql, ctx, [
      { event: ev({ user_id: uuidv7() }), dedupe_key: "message:t:4" },
    ]);
    expect(r2).toEqual({ written: 0, refused: "event names another person" });
    // Forbidden by name even where the contract would let a string through.
    const sneaky = { ...ev(), app: { display_name: "Gmail", text: "x" } };
    const r3 = await recordWorkflowEvents(db.client.sql, ctx, [
      { event: sneaky as never, dedupe_key: "message:t:5" },
    ]);
    expect(r3.written).toBe(0);
    expect(await countWorkflowEvents(db.client.sql, ctx)).toBe(before);
  });

  it("reads facts with the thread position and the previous direction, so a reply is told from a chase", async () => {
    await upsertSyncedThreads(db.client.sql, ctx, {
      connection_id: connId,
      threads: [
        T({
          external_id: "gm-events",
          message_count: 3,
          last_message_at: "2026-09-12T09:00:00.000Z",
          messages: [
            {
              external_id: "e1",
              from_address: "me@co.example",
              direction: "outbound",
              sent_at: "2026-09-10T09:00:00.000Z",
              body_ciphertext: new Uint8Array([1]),
              body_chars: 1,
            },
            {
              external_id: "e2",
              from_address: "bob@client.com",
              direction: "inbound",
              sent_at: "2026-09-11T09:00:00.000Z",
              body_ciphertext: new Uint8Array([1]),
              body_chars: 1,
            },
            {
              external_id: "e3",
              from_address: "me@co.example",
              direction: "outbound",
              sent_at: "2026-09-12T09:00:00.000Z",
              body_ciphertext: new Uint8Array([1]),
              body_chars: 1,
            },
          ],
        }),
      ],
    });
    const facts = await loadEventFacts(db.client.sql, ctx, {
      since: null,
      window_start: new Date("2026-09-01T00:00:00.000Z"),
    });
    const mine = facts.messages.filter((m) => m.thread_external_id === "gm-events");
    expect(mine.map((m) => [m.message_external_id, m.position, m.previous_direction])).toEqual([
      ["e1", 1, null],
      ["e2", 2, "outbound"],
      ["e3", 3, "inbound"],
    ]);
    expect(mine[0]!.contact_address).toBe("bob@client.com");
    // Nothing in a message fact but ids, direction and time.
    expect(Object.keys(mine[0]!).sort()).toEqual([
      "contact_address",
      "direction",
      "message_external_id",
      "position",
      "previous_direction",
      "sent_at",
      "thread_external_id",
    ]);
  });

  it("another user in the same org reads none of it, and cannot write into it", async () => {
    const other = uuidv7();
    await globalCreateUser(db.client.sql, {
      id: other,
      workos_user_id: `wu_${other}`,
      email: "ev-other@co.example",
      display_name: "Other",
    });
    await addMembership(
      db.client.sql,
      { organizationId: orgId },
      { user_id: other, role: "member" },
    );
    const theirs = { organizationId: orgId, userId: other };
    expect(await listWorkflowEvents(db.client.sql, theirs)).toEqual([]);
    expect(await countWorkflowEvents(db.client.sql, theirs)).toBe(0);
    // An event for Alice, written under the colleague's context, is refused before SQL.
    const r = await recordWorkflowEvents(db.client.sql, theirs, [
      { event: ev(), dedupe_key: "message:t:9" },
    ]);
    expect(r).toEqual({ written: 0, refused: "event names another person" });
    expect((await listWorkflowEvents(db.client.sql, ctx)).length).toBeGreaterThan(0);
  });
});

describe("routines discovery found", () => {
  const NOW = new Date("2026-09-22T12:00:00.000Z");
  const row = (over: Record<string, unknown> = {}) => ({
    id: "0192b3c4-0000-7000-8000-0000000000d1",
    signature: "a|b|c",
    status: "candidate" as const,
    title: "Reply and update Salesforce",
    summary: "You reply and update the deal.",
    occurrence_count: 2,
    distinct_day_count: 2,
    first_seen_at: "2026-09-01T10:00:00.000Z",
    last_seen_at: "2026-09-05T10:00:00.000Z",
    candidate: { canonical_sequence: ["a", "b", "c"] },
    naming: { required_capabilities: ["gmail.create_draft"] },
    verdict: { failed: [{ bar: "occurrences" }] },
    evidence: [
      {
        started_at: "2026-09-01T10:00:00.000Z",
        ended_at: "2026-09-01T12:00:00.000Z",
        case_ref: "ab".repeat(16),
        events: 3,
      },
    ],
    ...over,
  });

  it("a routine seen again is the same row with fresh counts and evidence; 'not now' and the agent link survive the rewrite", async () => {
    await upsertRoutineCandidates(db.client.sql, ctx, [row()], NOW);
    let rows = await listRoutineCandidates(db.client.sql, ctx);
    expect(rows.map((r) => r.signature)).toEqual(["a|b|c"]);
    expect(rows[0]!.decision).toBeNull();
    expect(rows[0]!.evidence.length).toBe(1);
    expect((await dismissRoutine(db.client.sql, ctx, rows[0]!.id, NOW))?.decision).toBe(
      "dismissed",
    );
    expect(
      await setRoutineAgent(
        db.client.sql,
        ctx,
        rows[0]!.id,
        "0192b3c4-0000-7000-8000-0000000000a9",
      ),
    ).toBe(true);
    await upsertRoutineCandidates(
      db.client.sql,
      ctx,
      [
        row({
          status: "eligible",
          occurrence_count: 4,
          distinct_day_count: 3,
          verdict: { failed: [] },
          evidence: [],
        }),
      ],
      new Date(NOW.getTime() + 1000),
    );
    rows = await listRoutineCandidates(db.client.sql, ctx);
    expect(rows.length).toBe(1);
    expect(rows[0]).toMatchObject({
      status: "eligible",
      occurrence_count: 4,
      decision: "dismissed",
      agent_id: "0192b3c4-0000-7000-8000-0000000000a9",
    });
    expect(rows[0]!.decided_at).toBe(NOW.toISOString());
    expect(rows[0]!.evidence).toEqual([]);
  });

  it("'not now' counts inside the cooldown and lapses after it", async () => {
    expect(await recentlyDismissedRoutines(db.client.sql, ctx, NOW, 14)).toEqual(["a|b|c"]);
    const later = new Date(NOW.getTime() + 15 * 86_400_000);
    expect(await recentlyDismissedRoutines(db.client.sql, ctx, later, 14)).toEqual([]);
  });

  it("a colleague reads none of it and cannot decide on it", async () => {
    const other = uuidv7();
    await globalCreateUser(db.client.sql, {
      id: other,
      workos_user_id: `wu_${other}`,
      email: "rt-other@co.example",
      display_name: "Other",
    });
    await addMembership(
      db.client.sql,
      { organizationId: orgId },
      { user_id: other, role: "member" },
    );
    const theirs = { organizationId: orgId, userId: other };
    expect(await listRoutineCandidates(db.client.sql, theirs)).toEqual([]);
    const mine = (await listRoutineCandidates(db.client.sql, ctx))[0]!;
    expect(await dismissRoutine(db.client.sql, theirs, mine.id, NOW)).toBeNull();
    expect(await setRoutineAgent(db.client.sql, theirs, mine.id, null)).toBe(false);
    expect((await listRoutineCandidates(db.client.sql, ctx))[0]!.agent_id).not.toBeNull();
  });
});

describe("runs of an accepted routine", () => {
  const NOW = new Date("2026-09-22T12:00:00.000Z");
  const input = (over: Record<string, unknown> = {}) => ({
    id: uuidv7(),
    routine_id: "0192b3c4-0000-7000-8000-0000000000d1",
    agent_id: "0192b3c4-0000-7000-8000-0000000000a9",
    agent_version_id: "0192b3c4-0000-7000-8000-0000000000a8",
    trigger_event_id: "0192b3c4-0000-7000-8000-0000000000e1",
    triggered_at: NOW.toISOString(),
    case_ref: "ab".repeat(16),
    mode: "shadow" as const,
    status: "watching" as const,
    proposed: [
      { object_ref: "ab".repeat(16), field: "gmail.create_draft", proposed_value_hash: "x" },
    ],
    ...over,
  });

  it("one run per trigger event: the second attempt returns nothing and nothing is written", async () => {
    const first = await createRoutineRun(db.client.sql, ctx, input());
    expect(first?.status).toBe("watching");
    expect(await createRoutineRun(db.client.sql, ctx, input({ id: uuidv7() }))).toBeNull();
    expect(
      (await listRoutineRuns(db.client.sql, ctx, { routine_id: input().routine_id })).length,
    ).toBe(1);
  });

  it("completes only from watching, once", async () => {
    const run = (await listRoutineRuns(db.client.sql, ctx, { status: "watching" }))[0]!;
    const done = await completeRoutineRun(db.client.sql, ctx, run.id, {
      status: "completed",
      comparison: { agreement: 1 },
      completed_at: NOW.toISOString(),
    });
    expect(done?.status).toBe("completed");
    expect(
      await completeRoutineRun(db.client.sql, ctx, run.id, {
        status: "failed",
        completed_at: NOW.toISOString(),
      }),
    ).toBeNull();
    expect(
      (await listRoutineRuns(db.client.sql, ctx, { routine_id: run.routine_id }))[0]!.status,
    ).toBe("completed");
  });

  it("a colleague reads none of it", async () => {
    const other = uuidv7();
    await globalCreateUser(db.client.sql, {
      id: other,
      workos_user_id: `wu_${other}`,
      email: "rr-other@co.example",
      display_name: "Other",
    });
    await addMembership(
      db.client.sql,
      { organizationId: orgId },
      { user_id: other, role: "member" },
    );
    expect(await listRoutineRuns(db.client.sql, { organizationId: orgId, userId: other })).toEqual(
      [],
    );
  });
});
