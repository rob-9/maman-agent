import { describe, expect, it } from "vitest";
import {
  assessDeterministically,
  assessmentInputSchema,
  assessmentOutputSchema,
  lastQuestion,
  type AssessmentInput,
} from "../src/assessment.js";
import { DeterministicModelProvider } from "../src/deterministic.js";

const base = (over: Partial<AssessmentInput> = {}): AssessmentInput => ({
  kind: "awaiting_you",
  contact_display_name: "Sarah Chen",
  account_name: "Acme",
  subject: "Enterprise pricing",
  days_elapsed: 4,
  has_open_deal: null,
  messages: [
    {
      from: "Alex",
      direction: "outbound",
      sent_at: "2026-09-10T09:00:00.000Z",
      text: "Here is the proposal for 50 seats.",
    },
    {
      from: "Sarah Chen",
      direction: "inbound",
      sent_at: "2026-09-17T09:00:00.000Z",
      text: "Thanks Alex. Can you confirm the price holds for 60 seats? We need it by Friday.",
    },
  ],
  ...over,
});

describe("the contract", () => {
  it("refuses secret-shaped text before it can reach a model", () => {
    const r = assessmentInputSchema.safeParse(
      base({
        messages: [
          {
            from: "x",
            direction: "inbound",
            sent_at: "2026-09-17T09:00:00.000Z",
            text: "here you go: api_key=sk_live_ABCDEFGHIJKLMNOP",
          },
        ],
      }),
    );
    expect(r.success).toBe(false);
  });

  it("bounds every field and rejects extras", () => {
    expect(assessmentInputSchema.safeParse(base({ messages: [] })).success).toBe(false);
    expect(
      assessmentOutputSchema.safeParse({
        owed: true,
        ask: "x",
        summary: "y",
        urgency: "high",
        confidence: 0.5,
        extra: 1,
      }).success,
    ).toBe(false);
    expect(
      assessmentOutputSchema.safeParse({
        owed: true,
        ask: "x",
        summary: "y".repeat(241),
        urgency: "high",
        confidence: 0.5,
      }).success,
    ).toBe(false);
  });
});

describe("lastQuestion", () => {
  it("returns the sentence that holds the last question mark", () => {
    expect(lastQuestion("Thanks. Can you confirm the price? We need it by Friday.")).toBe(
      "Can you confirm the price?",
    );
    expect(lastQuestion("All good here.")).toBe("");
  });
});

describe("the deterministic judgment", () => {
  it("finds the ask when they asked something, and calls it urgent when late or a deal is open", () => {
    const j = assessDeterministically(base());
    expect(j).toMatchObject({ owed: true, urgency: "high" });
    expect(j.ask).toBe("Can you confirm the price holds for 60 seats?");
    expect(j.summary).toContain("Sarah Chen asked");
    expect(assessDeterministically(base({ days_elapsed: 2 })).urgency).toBe("normal");
    expect(
      assessDeterministically(
        base({ days_elapsed: 2, has_open_deal: true, open_deal_value: 48000 }),
      ),
    ).toMatchObject({
      urgency: "high",
    });
    expect(
      assessDeterministically(base({ has_open_deal: true, open_deal_value: 48000 })).summary,
    ).toContain("$48,000 open");
  });

  it("nothing is owed when they closed the loop or the message is automated", () => {
    const closed = base({
      messages: [
        {
          from: "Sarah Chen",
          direction: "inbound",
          sent_at: "2026-09-17T09:00:00.000Z",
          text: "Perfect, thanks! All set on our side.",
        },
      ],
    });
    expect(assessDeterministically(closed)).toMatchObject({ owed: false, urgency: "low" });
    const ooo = base({
      messages: [
        {
          from: "Sarah Chen",
          direction: "inbound",
          sent_at: "2026-09-17T09:00:00.000Z",
          text: "I am out of office until Monday.",
        },
      ],
    });
    expect(assessDeterministically(ooo)).toMatchObject({ owed: false });
  });

  it("a thanks WITH a question is still owed", () => {
    const j = assessDeterministically(
      base({
        messages: [
          {
            from: "Sarah Chen",
            direction: "inbound",
            sent_at: "2026-09-17T09:00:00.000Z",
            text: "Thanks! Could you send the contract?",
          },
        ],
      }),
    );
    expect(j).toMatchObject({ owed: true, ask: "Could you send the contract?" });
  });

  it("awaiting_them is owed unless their last word closed it", () => {
    const quiet = base({
      kind: "awaiting_them",
      days_elapsed: 9,
      messages: [
        {
          from: "Alex",
          direction: "outbound",
          sent_at: "2026-09-10T09:00:00.000Z",
          text: "Sending the proposal over.",
        },
      ],
    });
    expect(assessDeterministically(quiet)).toMatchObject({ owed: true, urgency: "normal" });
    expect(
      assessDeterministically({ ...quiet, has_open_deal: true, open_deal_value: 1 }).urgency,
    ).toBe("high");
    const done = base({
      kind: "awaiting_them",
      messages: [
        {
          from: "Sarah Chen",
          direction: "inbound",
          sent_at: "2026-09-09T09:00:00.000Z",
          text: "We're going to pass, thanks.",
        },
        {
          from: "Alex",
          direction: "outbound",
          sent_at: "2026-09-10T09:00:00.000Z",
          text: "Understood, thanks for letting me know.",
        },
      ],
    });
    expect(assessDeterministically(done)).toMatchObject({ owed: false });
  });

  it("the provider wraps it with the same parse-in, parse-out discipline", async () => {
    const p = new DeterministicModelProvider();
    const r = await p.assessObligation(base());
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.usage.model_alias).toBe("demo");
    const bad = await p.assessObligation({ ...base(), messages: [] });
    expect(bad).toMatchObject({ ok: false, error: "policy_violation" });
  });
});

describe("meetings in the judgment", () => {
  it("a booked meeting means no chase; a past meeting names what you met about", () => {
    const booked = assessDeterministically(
      base({
        kind: "awaiting_them",
        next_meeting: { title: "Kickoff", at: "2026-09-24T15:00:00.000Z" },
      }),
    );
    expect(booked).toMatchObject({ owed: false, urgency: "low" });
    expect(booked.summary).toBe(
      'You are meeting Sarah Chen for "Kickoff" on Thursday; no chase needed.',
    );
    const met = assessDeterministically(
      base({
        kind: "unsent_followup",
        last_meeting: { title: "Pricing review", at: "2026-09-17T15:00:00.000Z" },
      }),
    );
    expect(met.summary).toContain('You met Sarah Chen for "Pricing review"');
    // A booked meeting does not answer an email they are waiting on.
    expect(
      assessDeterministically(
        base({ next_meeting: { title: "Kickoff", at: "2026-09-24T15:00:00.000Z" } }),
      ).owed,
    ).toBe(true);
  });
});
