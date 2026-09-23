import { describe, expect, it } from "vitest";
import {
  explain,
  formingLine,
  nextMeetingLine,
  routineEvidenceLine,
  routineRunsLine,
  type ObligationView,
} from "../src/lib/explain.js";

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
  draft: null,
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

describe("a found routine, in one line", () => {
  const ev = (names: Array<string | null>) => names.map((n) => ({ contact_display_name: n }));
  it("says how often, on how many days, and around whom, by name only", () => {
    expect(
      routineEvidenceLine({
        occurrence_count: 4,
        distinct_day_count: 4,
        evidence: ev(["Bob Ray", "Sarah Chen", "Bob Ray", "Dan Li"]),
      }),
    ).toBe("Seen 4 times on 4 days, around Bob Ray, Sarah Chen and Dan Li.");
    expect(
      routineEvidenceLine({
        occurrence_count: 5,
        distinct_day_count: 3,
        evidence: ev(["A", "B", "C", "D", null]),
      }),
    ).toBe("Seen 5 times on 3 days, around A, B, C and 1 more.");
    expect(
      routineEvidenceLine({ occurrence_count: 1, distinct_day_count: 1, evidence: ev([null]) }),
    ).toBe("Seen once on 1 day.");
    expect(
      routineEvidenceLine({
        occurrence_count: 3,
        distinct_day_count: 2,
        evidence: ev(["Bob Ray"]),
      }),
    ).toBe("Seen 3 times on 2 days, around Bob Ray.");
  });
  it("a forming routine says what it still needs", () => {
    expect(
      formingLine({
        why_not: ["not seen often enough yet", "not seen on enough different days yet"],
      }),
    ).toBe("not seen often enough yet; not seen on enough different days yet");
    expect(formingLine({ why_not: [] })).toBe("still forming");
  });
});

describe("how a routine has run, in one line", () => {
  const base = {
    mode: "shadow" as const,
    shadow_completed: 0,
    shadow_successful: 0,
    required: 3,
    ready_to_start: false,
    supervised_completed: 0,
  };
  it("says what happened alongside the person and whether it can start", () => {
    expect(routineRunsLine(base)).toBe(
      "Accepted. It will run alongside you the next time this comes up.",
    );
    expect(routineRunsLine({ ...base, shadow_completed: 2, shadow_successful: 1 })).toBe(
      "Ran alongside you 2 times, agreed once. Needs 3 that agree before it can start.",
    );
    expect(
      routineRunsLine({ ...base, shadow_completed: 4, shadow_successful: 3, ready_to_start: true }),
    ).toBe("Ran alongside you 4 times, agreed 3 times. Ready to start.");
    expect(routineRunsLine({ ...base, mode: "supervised" })).toBe(
      "Running. Its drafts and proposals will show up here for your approval.",
    );
    expect(routineRunsLine({ ...base, mode: "supervised", supervised_completed: 2 })).toBe(
      "Running. Produced drafts or proposals 2 times, each for your approval.",
    );
  });
});
