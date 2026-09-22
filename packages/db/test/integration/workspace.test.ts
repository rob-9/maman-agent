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
  upsertSyncedThreads,
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
    expect(first).toEqual({ contacts: 2, threads: 2 });

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
    expect(r1).toEqual({ written: 2, kept_decided: 0 });

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
    expect(r2).toEqual({ written: 1, kept_decided: 1 });

    const pending = await listPendingObligations(db.client.sql, ctx);
    expect(pending.map((p) => p.thread_id)).toEqual([t1!.thread_id]);
    expect(pending[0]!.rank).toBe(45);
    expect(pending[0]!.contact_display_name).toBe("Bob Jones");
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
    expect(pending.map((p) => p.rank)).toEqual([20, 10]);
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
