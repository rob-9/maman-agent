import { describe, expect, it } from "vitest";
import { containsForbiddenEventField, workflowEventSchema } from "@maman/contracts";
import type { EventFacts } from "@maman/db";
import { deriveEvents } from "../src/events.js";

const ctx = {
  organizationId: "0192b3c4-0000-7000-8000-000000000001",
  userId: "0192b3c4-0000-7000-8000-000000000002",
};
const NOW = new Date("2026-09-22T12:00:00.000Z");
const empty: EventFacts = { messages: [], meetings: [], actions: [], decisions: [], intents: [] };

const FACTS: EventFacts = {
  messages: [
    {
      message_external_id: "m1",
      thread_external_id: "t1",
      direction: "outbound",
      sent_at: "2026-09-10T09:00:00.000Z",
      position: 1,
      previous_direction: null,
      contact_address: "bob@client.com",
    },
    {
      message_external_id: "m2",
      thread_external_id: "t1",
      direction: "inbound",
      sent_at: "2026-09-11T09:00:00.000Z",
      position: 2,
      previous_direction: "outbound",
      contact_address: "bob@client.com",
    },
    {
      message_external_id: "m3",
      thread_external_id: "t1",
      direction: "outbound",
      sent_at: "2026-09-12T09:00:00.000Z",
      position: 3,
      previous_direction: "inbound",
      contact_address: "bob@client.com",
    },
    {
      message_external_id: "m4",
      thread_external_id: "t1",
      direction: "outbound",
      sent_at: "2026-09-15T09:00:00.000Z",
      position: 4,
      previous_direction: "outbound",
      contact_address: "bob@client.com",
    },
  ],
  meetings: [
    {
      external_id: "ev1",
      starts_at: "2026-09-12T15:00:00.000Z",
      ends_at: "2026-09-12T15:30:00.000Z",
      status: "confirmed",
      self_response: "accepted",
      attendee_count: 3,
    },
    {
      external_id: "ev-future",
      starts_at: "2026-09-30T15:00:00.000Z",
      ends_at: "2026-09-30T15:30:00.000Z",
      status: "confirmed",
      self_response: "accepted",
      attendee_count: 2,
    },
    {
      external_id: "ev-declined",
      starts_at: "2026-09-12T16:00:00.000Z",
      ends_at: "2026-09-12T16:30:00.000Z",
      status: "confirmed",
      self_response: "declined",
      attendee_count: 2,
    },
    {
      external_id: "ev-cancelled",
      starts_at: "2026-09-12T17:00:00.000Z",
      ends_at: "2026-09-12T17:30:00.000Z",
      status: "cancelled",
      self_response: "accepted",
      attendee_count: 2,
    },
  ],
  actions: [
    {
      id: "0192b3c4-0000-7000-8000-00000000a001",
      kind: "salesforce.update_opportunity",
      status: "verified",
      approved_by: "user",
      approved_at: "2026-09-12T16:00:00.000Z",
      verified_at: "2026-09-12T16:00:05.000Z",
      reverted_at: null,
      field_names: ["close_date", "next_step"],
    },
    {
      id: "0192b3c4-0000-7000-8000-00000000a002",
      kind: "salesforce.log_activity",
      status: "verified",
      approved_by: "promotion",
      approved_at: "2026-09-13T16:00:00.000Z",
      verified_at: "2026-09-13T16:00:05.000Z",
      reverted_at: "2026-09-13T17:00:00.000Z",
      field_names: [],
    },
    {
      id: "0192b3c4-0000-7000-8000-00000000a003",
      kind: "salesforce.log_activity",
      status: "proposed",
      approved_by: null,
      approved_at: null,
      verified_at: null,
      reverted_at: null,
      field_names: [],
    },
  ],
  decisions: [
    {
      obligation_id: "0192b3c4-0000-7000-8000-00000000b001",
      kind: "awaiting_them",
      outcome: "dismissed",
      decided_at: "2026-09-14T10:00:00.000Z",
    },
  ],
  intents: [
    {
      id: "0192b3c4-0000-7000-8000-00000000c001",
      source: "stated",
      scope_kind: "account",
      created_at: "2026-09-14T10:01:00.000Z",
    },
  ],
};

const tokens = (facts: EventFacts) =>
  deriveEvents(ctx, facts, NOW).map(
    (d) =>
      `${d.event.source}:${d.event.event_type}:${d.event.target.semantic_type}:${d.event.context.object_type}`,
  );

describe("the event stream, derived from what is stored", () => {
  it("every event passes the contract and carries no forbidden field", () => {
    const derived = deriveEvents(ctx, FACTS, NOW);
    expect(derived.length).toBeGreaterThan(0);
    for (const d of derived) {
      expect(workflowEventSchema.safeParse(d.event).success).toBe(true);
      expect(containsForbiddenEventField(d.event)).toBeNull();
      expect(d.event.user_id).toBe(ctx.userId);
      expect(d.event.organization_id).toBe(ctx.organizationId);
    }
  });

  it("a message is the move it was: new, reply, chase, or the other side's turn", () => {
    expect(tokens({ ...empty, messages: FACTS.messages })).toEqual([
      "google:record_updated:sent_new:email_thread",
      "google:record_updated:received_reply:email_thread",
      "google:record_updated:sent_reply:email_thread",
      "google:record_updated:sent_chase:email_thread",
    ]);
  });

  it("a meeting counts once it happened and the person was in it; declined, cancelled and future ones do not", () => {
    const derived = deriveEvents(ctx, { ...empty, meetings: FACTS.meetings }, NOW);
    expect(derived.map((d) => d.dedupe_key)).toEqual(["meeting:ev1:held"]);
    expect(derived[0]!.event.duration_ms).toBe(30 * 60 * 1000);
    expect(derived[0]!.event.context.item_count).toBe(3);
  });

  it("a write is the click that approved it, the write that landed with its field names, and the undo; a proposal is nothing yet", () => {
    expect(tokens({ ...empty, actions: FACTS.actions })).toEqual([
      "product:element_activated:approve_update_opportunity:opportunity",
      "salesforce:record_updated:update_opportunity:opportunity",
      "salesforce:record_updated:log_activity:task",
      "product:element_activated:undo_log_activity:task",
    ]);
    const landed = deriveEvents(ctx, { ...empty, actions: FACTS.actions }, NOW).find((d) =>
      d.dedupe_key.endsWith("a001:verified"),
    )!;
    expect(landed.event.context.field_names).toEqual(["close_date", "next_step"]);
    // A promotion is not the person's click.
    expect(
      deriveEvents(ctx, { ...empty, actions: FACTS.actions }, NOW).some((d) =>
        d.dedupe_key.endsWith("a002:approved"),
      ),
    ).toBe(false);
  });

  it("a decision and a sentence are product events on the item, not their content", () => {
    expect(tokens({ ...empty, decisions: FACTS.decisions, intents: FACTS.intents })).toEqual([
      "product:element_activated:dismissed:awaiting_them",
      "product:value_committed:intent_stated:intent_account",
    ]);
  });

  it("carries a one-way hash of the record, never the id, the address or the subject", () => {
    const json = JSON.stringify(deriveEvents(ctx, FACTS, NOW).map((d) => d.event));
    for (const raw of ["t1", "m1", "bob@client.com", "ev1", "a001", "b001", "c001"]) {
      expect(json.includes(`"${raw}"`)).toBe(false);
    }
    expect(json).not.toContain("@");
    const hashes = deriveEvents(ctx, FACTS, NOW).map((d) => d.event.context.record_id_hash);
    for (const h of hashes) expect(h).toMatch(/^[0-9a-f]{32}$/);
    // The same fact in another organization hashes differently.
    const elsewhere = deriveEvents(
      { ...ctx, organizationId: "0192b3c4-0000-7000-8000-0000000000ff" },
      FACTS,
      NOW,
    );
    expect(elsewhere[0]!.event.context.record_id_hash).not.toBe(
      deriveEvents(ctx, FACTS, NOW)[0]!.event.context.record_id_hash,
    );
  });

  it("the dedupe key names the fact, so deriving twice is the same set; time order is the order", () => {
    const a = deriveEvents(ctx, FACTS, NOW).map((d) => d.dedupe_key);
    const b = deriveEvents(ctx, FACTS, NOW).map((d) => d.dedupe_key);
    expect(a).toEqual(b);
    // The event itself, id included, is a function of the fact.
    expect(deriveEvents(ctx, FACTS, NOW)).toEqual(deriveEvents(ctx, FACTS, NOW));
    const ids = deriveEvents(ctx, FACTS, NOW).map((d) => d.event.event_id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(new Set(a).size).toBe(a.length);
    const times = deriveEvents(ctx, FACTS, NOW).map((d) => d.event.occurred_at);
    expect([...times].sort()).toEqual(times);
  });
});
