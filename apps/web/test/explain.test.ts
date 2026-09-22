import { describe, expect, it } from "vitest";
import { explain, nextMeetingLine, type ObligationView } from "../src/lib/explain.js";

const o = (over: Partial<ObligationView> = {}): ObligationView => ({
  id: "1",
  thread_id: "t",
  contact_id: "c",
  kind: "awaiting_you",
  rank: 105,
  reason: {
    days_elapsed: 4,
    threshold_days: 2,
    last_direction: "inbound",
    message_count: 2,
    has_open_deal: null,
  },
  detected_at: "2026-09-21T12:00:00.000Z",
  subject: "Enterprise pricing",
  contact_display_name: "Sarah Chen",
  contact_account_name: null,
  last_meeting_at: null,
  last_meeting_title: null,
  next_meeting_at: null,
  next_meeting_title: null,
  assessment: null,
  ...over,
});

describe("what the card says", () => {
  it("states the facts when the agent is off or has not read the thread", () => {
    expect(explain(o())).toEqual({
      headline: "Sarah Chen is waiting on you",
      detail: 'They wrote 4 days ago on "Enterprise pricing" and you haven\'t replied.',
      ask: null,
      source: "facts",
    });
    const judged = o({
      assessment: {
        owed: true,
        ask: "the price",
        summary: "They want the price.",
        urgency: "high",
        confidence: 0.9,
      },
    });
    expect(explain(judged, "off").source).toBe("facts");
  });

  it("leads with the agent's sentence and the ask when the agent is on, keeping the headline from the facts", () => {
    const judged = o({
      assessment: {
        owed: true,
        ask: "the price",
        summary: "They want the price.",
        urgency: "high",
        confidence: 0.9,
      },
    });
    expect(explain(judged, "assist")).toEqual({
      headline: "Sarah Chen is waiting on you",
      detail: "They want the price.",
      ask: "the price",
      source: "agent",
    });
    expect(
      explain(
        o({ assessment: { owed: true, ask: "", summary: "s", urgency: "low", confidence: 0.5 } }),
        "assist",
      ).ask,
    ).toBeNull();
  });
});

describe("meetings on the card", () => {
  it("names the meeting a follow-up is counted from, and the next one booked", () => {
    const met = o({
      kind: "unsent_followup",
      reason: {
        days_elapsed: 2,
        threshold_days: 1,
        last_direction: "outbound",
        message_count: 3,
        has_open_deal: null,
      },
      last_meeting_at: "2026-09-17T15:00:00.000Z",
      last_meeting_title: "Pricing review",
    });
    expect(explain(met).detail).toBe(
      'You met 2 days ago for "Pricing review" and nothing has gone out since.',
    );
    const booked = o({
      next_meeting_at: "2026-09-24T15:00:00.000Z",
      next_meeting_title: "Kickoff",
    });
    expect(nextMeetingLine(booked, new Date("2026-09-21T12:00:00Z"))).toBe(
      "Meeting Thursday: Kickoff",
    );
    expect(nextMeetingLine(booked, new Date("2026-09-30T12:00:00Z"))).toBeNull();
    expect(nextMeetingLine(o())).toBeNull();
  });
});
