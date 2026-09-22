import { describe, expect, it } from "vitest";
import {
  daysBetween,
  detectObligations,
  rankObligation,
  DEFAULT_DETECTION_CONFIG,
  type Contact,
  type Thread,
} from "../src/index.js";

const NOW = new Date("2026-09-21T12:00:00.000Z");

/** Days before NOW, as an ISO string. */
const ago = (days: number): string => new Date(NOW.getTime() - days * 86_400_000).toISOString();

function thread(over: Partial<Thread> = {}): Thread {
  return {
    thread_id: "t1",
    contact_id: "c1",
    subject: "Pricing",
    last_message_at: ago(10),
    last_direction: "outbound",
    message_count: 3,
    ...over,
  };
}

function contact(over: Partial<Contact> = {}): Contact {
  return {
    contact_id: "c1",
    display_name: "Sarah Chen",
    account_name: "Acme",
    has_open_deal: true,
    ...over,
  };
}

const detect = (threads: Thread[], contacts: Contact[], config = {}) =>
  detectObligations({ threads, contacts, now: NOW, config });

describe("daysBetween", () => {
  it("floors, so a partial day does not cross a threshold", () => {
    // 1.9 days must read as 1, or a 2-day threshold fires a day early and the
    // user is nudged about something they answered yesterday.
    const from = new Date(NOW.getTime() - 1.9 * 86_400_000).toISOString();
    expect(daysBetween(from, NOW)).toBe(1);
  });

  it("clamps a future timestamp to zero rather than going negative", () => {
    // Connector clock skew is real; a negative age would rank nonsensically.
    expect(daysBetween(new Date(NOW.getTime() + 60_000).toISOString(), NOW)).toBe(0);
  });
});

describe("detectObligations", () => {
  it("finds nothing when there is nothing to find", () => {
    expect(detect([], [])).toEqual([]);
  });

  it("surfaces a forgotten follow-up after the user went quiet", () => {
    const [o] = detect(
      [thread({ last_direction: "outbound", last_message_at: ago(8) })],
      [contact()],
    );
    expect(o!.kind).toBe("awaiting_them");
    expect(o!.reason.days_elapsed).toBe(8);
    expect(o!.reason.threshold_days).toBe(DEFAULT_DETECTION_CONFIG.awaiting_them_days);
  });

  it("surfaces a reply the user owes", () => {
    const [o] = detect(
      [thread({ last_direction: "inbound", last_message_at: ago(3) })],
      [contact()],
    );
    expect(o!.kind).toBe("awaiting_you");
  });

  it("owing a reply outranks waiting for one, regardless of deal size", () => {
    // THE ORDERING THAT MATTERS. They wrote to you and you went silent — that
    // damages the relationship, where waiting merely delays it. No amount of
    // pipeline value should promote a waiting thread above it.
    const results = detect(
      [
        thread({
          thread_id: "owed",
          contact_id: "small",
          last_direction: "inbound",
          last_message_at: ago(3),
        }),
        thread({
          thread_id: "waiting",
          contact_id: "huge",
          last_direction: "outbound",
          last_message_at: ago(30),
        }),
      ],
      [
        contact({ contact_id: "small", open_deal_value: 1_000 }),
        contact({ contact_id: "huge", open_deal_value: 10_000_000 }),
      ],
    );
    expect(results.map((o) => o.thread_id)).toEqual(["owed", "waiting"]);
  });

  it("says nothing before the threshold", () => {
    expect(
      detect([thread({ last_direction: "outbound", last_message_at: ago(2) })], [contact()]),
    ).toEqual([]);
  });

  it.each([
    ["awaiting_them", "outbound" as const, DEFAULT_DETECTION_CONFIG.awaiting_them_days],
    ["awaiting_you", "inbound" as const, DEFAULT_DETECTION_CONFIG.awaiting_you_days],
  ])("fires exactly ON the %s threshold, not a day later", (kind, dir, days) => {
    // Boundary: `>=` vs `>` is a whole day of silence to the user.
    expect(
      detect([thread({ last_direction: dir, last_message_at: ago(days) })], [contact()]),
    ).toHaveLength(1);
    expect(
      detect([thread({ last_direction: dir, last_message_at: ago(days - 1) })], [contact()]),
    ).toEqual([]);
    expect(
      detect([thread({ last_direction: dir, last_message_at: ago(days) })], [contact()])[0]!.kind,
    ).toBe(kind);
  });

  it("lets an UNKNOWN deal state through — no CRM is not the same as closed", () => {
    // Day one, Gmail only, no CRM connected. Treating unknown as closed would
    // show this user nothing at all and teach them the product is empty.
    const [o] = detect([thread({ last_message_at: ago(9) })], [contact({ has_open_deal: null })]);
    expect(o).toBeDefined();
    expect(o!.reason.has_open_deal).toBeNull();
  });

  it("ranks a known-open deal above an unknown one at equal lateness", () => {
    // The CRM's confirmation PROMOTES; it does not unlock.
    const results = detect(
      [
        thread({ thread_id: "unknown", contact_id: "u", last_message_at: ago(9) }),
        thread({ thread_id: "known", contact_id: "k", last_message_at: ago(9) }),
      ],
      [contact({ contact_id: "u", has_open_deal: null }), contact({ contact_id: "k" })],
    );
    expect(results.map((o) => o.thread_id)).toEqual(["known", "unknown"]);
  });

  it("an unknown deal never crosses a kind boundary", () => {
    // The penalty must reorder WITHIN a band only. An unknown-deal reply the
    // user owes still outranks a known-open thread they are merely waiting on.
    const results = detect(
      [
        thread({
          thread_id: "owed",
          contact_id: "u",
          last_direction: "inbound",
          last_message_at: ago(3),
        }),
        thread({
          thread_id: "waiting",
          contact_id: "k",
          last_direction: "outbound",
          last_message_at: ago(30),
        }),
      ],
      [
        contact({ contact_id: "u", has_open_deal: null }),
        contact({ contact_id: "k", open_deal_value: 10_000_000 }),
      ],
    );
    expect(results.map((o) => o.thread_id)).toEqual(["owed", "waiting"]);
  });

  it("ignores a closed relationship entirely", () => {
    // A list containing won and lost deals is the fastest way to teach someone
    // it is not worth reading.
    expect(
      detect([thread({ last_message_at: ago(30) })], [contact({ has_open_deal: false })]),
    ).toEqual([]);
  });

  it("drops anything past the staleness ceiling", () => {
    // Without a ceiling, months-old threads quietly outrank this week's work.
    const days = DEFAULT_DETECTION_CONFIG.max_days;
    expect(detect([thread({ last_message_at: ago(days) })], [contact()])).toHaveLength(1);
    expect(detect([thread({ last_message_at: ago(days + 1) })], [contact()])).toEqual([]);
  });

  it("skips a thread whose contact is unknown rather than assuming it is open", () => {
    // The two systems sync independently and WILL disagree. Guessing "probably
    // open" produces exactly the false positives that make the list ignorable.
    expect(detect([thread({ contact_id: "missing" })], [contact()])).toEqual([]);
  });

  it("recognises a meeting with no follow-up as its own, more specific failure", () => {
    const [o] = detect(
      [thread({ last_direction: "outbound", last_message_at: ago(10) })],
      [contact({ last_meeting_at: ago(3) })],
    );
    expect(o!.kind).toBe("unsent_followup");
    expect(o!.reason.days_elapsed).toBe(3); // since the MEETING, not the email
  });

  it("ignores a meeting that happened before the last message", () => {
    // They met, then the user emailed. Nothing is owed from the meeting.
    const [o] = detect(
      [thread({ last_direction: "outbound", last_message_at: ago(6) })],
      [contact({ last_meeting_at: ago(20) })],
    );
    expect(o!.kind).toBe("awaiting_them");
  });

  it("does not raise an unsent follow-up for an inbound thread", () => {
    // They replied after the meeting — the ball is with the user, and calling
    // that an unsent follow-up would misdescribe it.
    const [o] = detect(
      [thread({ last_direction: "inbound", last_message_at: ago(3) })],
      [contact({ last_meeting_at: ago(5) })],
    );
    expect(o!.kind).toBe("awaiting_you");
  });

  it("carries the facts that produced it, so the UI can explain itself", () => {
    const [o] = detect(
      [thread({ last_direction: "outbound", last_message_at: ago(9), message_count: 7 })],
      [contact({ open_deal_value: 25_000 })],
    );
    expect(o!.reason).toEqual({
      kind: "awaiting_them",
      days_elapsed: 9,
      threshold_days: 5,
      last_direction: "outbound",
      message_count: 7,
      has_open_deal: true,
      open_deal_value: 25_000,
    });
  });

  it("omits deal value rather than inventing a zero when the CRM has none", () => {
    const [o] = detect([thread({ last_message_at: ago(9) })], [contact()]);
    expect(o!.reason).not.toHaveProperty("open_deal_value");
  });

  it("is stable for equal ranks, so the list does not reshuffle under the cursor", () => {
    const results = detect(
      [thread({ thread_id: "b", contact_id: "c1" }), thread({ thread_id: "a", contact_id: "c2" })],
      [contact({ contact_id: "c1" }), contact({ contact_id: "c2" })],
    );
    expect(results.map((o) => o.thread_id)).toEqual(["a", "b"]);
  });

  it("honours tuned thresholds", () => {
    const fast = detect(
      [thread({ last_direction: "outbound", last_message_at: ago(3) })],
      [contact()],
      { awaiting_them_days: 2 },
    );
    expect(fast).toHaveLength(1);
    expect(fast[0]!.reason.threshold_days).toBe(2);
  });

  it("is deterministic — identical inputs give an identical list", () => {
    const args = [
      [
        thread({ thread_id: "x", last_message_at: ago(9) }),
        thread({
          thread_id: "y",
          contact_id: "c2",
          last_direction: "inbound",
          last_message_at: ago(4),
        }),
      ],
      [contact(), contact({ contact_id: "c2", open_deal_value: 9_000 })],
    ] as const;
    expect(detect([...args[0]], [...args[1]])).toEqual(detect([...args[0]], [...args[1]]));
  });
});

describe("rankObligation", () => {
  const cfg = DEFAULT_DETECTION_CONFIG;

  it("separates the kinds by more than value or lateness can bridge", () => {
    // Pinned deliberately: the kind bands must not overlap, or a big enough
    // deal would promote a merely-waiting thread over one the user owes.
    const owedMinimum = rankObligation(
      "awaiting_you",
      cfg.awaiting_you_days,
      cfg.awaiting_you_days,
      0,
      cfg,
    );
    const waitingMaximum = rankObligation(
      "awaiting_them",
      10_000,
      cfg.awaiting_them_days,
      Number.MAX_SAFE_INTEGER,
      cfg,
    );
    expect(owedMinimum).toBeGreaterThan(waitingMaximum);
  });

  it("increases with lateness but saturates", () => {
    const a = rankObligation("awaiting_them", 10, 5, undefined, cfg);
    const b = rankObligation("awaiting_them", 30, 5, undefined, cfg);
    const c = rankObligation("awaiting_them", 3_000, 5, undefined, cfg);
    expect(b).toBeGreaterThan(a);
    expect(c).toBeGreaterThan(b);
    // One ancient thread must not monopolise the top of the list.
    expect(c - b).toBeLessThan(b - a);
  });

  it("uses value as a tiebreaker, never a driver", () => {
    const poor = rankObligation("awaiting_them", 6, 5, 0, cfg);
    const rich = rankObligation("awaiting_them", 6, 5, Number.MAX_SAFE_INTEGER, cfg);
    expect(rich).toBeGreaterThan(poor);
    // The entire value term is worth less than the gap between kinds.
    expect(rich - poor).toBeLessThan(30);
  });

  it("scores zero overdue at exactly the threshold", () => {
    const atThreshold = rankObligation("awaiting_them", 5, 5, 0, cfg);
    expect(atThreshold).toBe(30);
  });
});

describe("a meeting already on the calendar", () => {
  it("cancels a chase on a quiet thread, right up to the moment it starts", () => {
    const quiet = thread({ last_message_at: ago(9) });
    expect(detect([quiet], [contact({ next_meeting_at: ago(-2) })])).toEqual([]);
    // Boundary: a meeting exactly now is not "upcoming"; the chase is owed again.
    expect(detect([quiet], [contact({ next_meeting_at: NOW.toISOString() })])).toHaveLength(1);
    expect(detect([quiet], [contact({ next_meeting_at: ago(1) })])).toHaveLength(1);
  });

  it("does not cancel a reply that is owed: they wrote, and a booked call does not answer an email", () => {
    const owed = thread({ last_message_at: ago(4), last_direction: "inbound" });
    const [o] = detect([owed], [contact({ next_meeting_at: ago(-2) })]);
    expect(o!.kind).toBe("awaiting_you");
  });

  it("carries the meeting an unsent follow-up is counted from", () => {
    const [o] = detect(
      [thread({ last_message_at: ago(10) })],
      [contact({ last_meeting_at: ago(3) })],
    );
    expect(o!.kind).toBe("unsent_followup");
    expect(o!.reason.last_meeting_at).toBe(ago(3));
  });
});
