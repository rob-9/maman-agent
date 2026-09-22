import { describe, expect, it } from "vitest";
import {
  composeDeterministically,
  draftInputSchema,
  draftOutputSchema,
  groundDraft,
  signOffFrom,
  type DraftInput,
} from "../src/draft.js";
import { DeterministicModelProvider } from "../src/deterministic.js";

const input = (over: Partial<DraftInput> = {}): DraftInput => ({
  kind: "awaiting_you",
  contact_display_name: "Sarah Chen",
  contact_address: "sarah@acme.com",
  account_name: "Acme",
  subject: "Enterprise pricing",
  days_elapsed: 4,
  has_open_deal: true,
  open_deal_value: 48_000,
  sender_name: "Alex",
  sender_address: "alex@co.example",
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
      text: "Can you confirm the price holds for 60 seats? We need it by Friday.",
    },
  ],
  ask: "Can you confirm the price holds for 60 seats?",
  voice: {
    to_this_contact: [],
    similar_situations: [],
    recent: ["Sounds good, sending it now.\n\nCheers,\nAlex"],
  },
  ...over,
});
const sources = (i: DraftInput) => ({
  messages: i.messages,
  subject: i.subject,
  days_elapsed: i.days_elapsed,
  open_deal_value: i.open_deal_value,
  ask: i.ask,
});

describe("grounding", () => {
  it("passes a draft whose numbers, money, days and claims all come from the thread or the facts", () => {
    const body =
      "Hi Sarah, yes, the price holds for 60 seats; the $48,000 figure stands, and I will confirm before Friday.";
    expect(groundDraft(body, sources(input()))).toEqual({ ok: true });
  });

  it("refuses an invented number, sum, URL, meeting or day", () => {
    const r = groundDraft(
      "Hi Sarah, we can do 75 seats at $52,000 with a 10% discount; see https://co.example/deal and let's set a meeting Monday.",
      sources(input()),
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.violations).toEqual(
      expect.arrayContaining([
        "number: 75",
        "money: $52,000",
        "number: 10%",
        "url: https://co.example/deal",
        "claim: discount",
        "claim: meeting",
        "claim: monday",
      ]),
    );
  });

  it("does not let the person's own exemplars vouch for a fact", () => {
    // The exemplar mentions $9,000; the thread does not. Voice is style only.
    const i = input({
      voice: {
        to_this_contact: ["We closed at $9,000 last time."],
        similar_situations: [],
        recent: [],
      },
    });
    const r = groundDraft("Same as last time, $9,000.", sources(i));
    expect(r.ok).toBe(false);
  });
});

describe("the contract", () => {
  it("refuses secret-shaped text in any field, and bounds the output", () => {
    expect(
      draftInputSchema.safeParse(
        input({
          voice: {
            to_this_contact: ["api_key=sk_live_ABCDEFGHIJKLMNOP"],
            similar_situations: [],
            recent: [],
          },
        }),
      ).success,
    ).toBe(false);
    expect(draftOutputSchema.safeParse({ subject: "x", body: "y".repeat(6001) }).success).toBe(
      false,
    );
    expect(draftOutputSchema.safeParse({ subject: "x", body: "y", extra: 1 }).success).toBe(false);
  });
});

describe("the deterministic draft", () => {
  it("is grounded by construction, answers the ask, and signs off the way the person does", () => {
    const d = composeDeterministically(input());
    expect(d.subject).toBe("Re: Enterprise pricing");
    expect(d.body.startsWith("Hi Sarah,")).toBe(true);
    expect(d.body).toContain('"Can you confirm the price holds for 60 seats?"');
    expect(d.body.trimEnd().endsWith("Cheers,\nAlex")).toBe(true);
    expect(groundDraft(d.body, sources(input()))).toEqual({ ok: true });
  });

  it("uses a plain sign-off when the person's writing shows none, and never guesses a first name", () => {
    const d = composeDeterministically(
      input({
        contact_display_name: "sarah@acme.com",
        voice: { to_this_contact: [], similar_situations: [], recent: [] },
      }),
    );
    expect(d.body.startsWith("Hi there,")).toBe(true);
    expect(d.body.trimEnd().endsWith("Best,\nAlex")).toBe(true);
    expect(signOffFrom(["Thanks!\nAlex"], "Alex")).toBe("Thanks,\nAlex");
    expect(signOffFrom(["Talk soon\nA"], "Alex")).toBe("Talk soon,\nAlex");
  });

  it("the provider wraps it with parse-in, parse-out", async () => {
    const p = new DeterministicModelProvider();
    const r = await p.composeDraft(input());
    expect(r.ok).toBe(true);
    expect(await p.composeDraft({ ...input(), messages: [] })).toMatchObject({
      ok: false,
      error: "policy_violation",
    });
  });
});

describe("meetings in the draft", () => {
  it("a meeting is a fact: its title and its day may be named, an invented day may not", () => {
    const i = input({
      kind: "unsent_followup",
      ask: undefined,
      last_meeting: { title: "Pricing review", at: "2026-09-17T15:00:00.000Z" },
    });
    const src = { ...sources(i), meetings: [i.last_meeting!] };
    expect(
      groundDraft(
        "Good to meet Thursday for the Pricing review. Following up on Enterprise pricing.",
        src,
      ),
    ).toEqual({ ok: true });
    const r = groundDraft("Good to meet Monday for the Pricing review.", src);
    expect(r).toMatchObject({ ok: false, violations: ["claim: monday"] });
    // The template names the meeting, and stays grounded.
    const d = composeDeterministically(i);
    expect(d.body).toContain('for "Pricing review"');
    expect(groundDraft(d.body, src)).toEqual({ ok: true });
  });
});
