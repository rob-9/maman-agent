import { describe, expect, it } from "vitest";
import {
  groundOpportunityUpdate,
  readDate,
  readOpportunityDeterministically,
  type OpportunityInput,
} from "../src/opportunity.js";

const AT = "2026-09-22T15:00:00.000Z"; // a Tuesday
const input = (text: string, over: Partial<OpportunityInput> = {}): OpportunityInput => ({
  contact_display_name: "Sarah Chen",
  account_name: "Acme",
  subject: "Enterprise pricing",
  current: { stage: "Proposal", next_step: null, close_date: null },
  messages: [
    {
      from: "Alex",
      direction: "outbound",
      sent_at: "2026-09-20T09:00:00.000Z",
      text: "Here is the proposal.",
    },
    { from: "Sarah Chen", direction: "inbound", sent_at: AT, text },
  ],
  ...over,
});

describe("reading dates the way people write them", () => {
  it("weekdays are the next one after the message; 'next' skips a week", () => {
    expect(readDate("Can you send it by Friday?", AT)).toBe("2026-09-25");
    expect(readDate("Let's aim for Tuesday.", AT)).toBe("2026-09-29");
    expect(readDate("next Friday works", AT)).toBe("2026-10-02");
  });
  it("month names, numeric dates, ISO, and end of period", () => {
    expect(readDate("we want to sign by September 30", AT)).toBe("2026-09-30");
    expect(readDate("targeting Oct 15th", AT)).toBe("2026-10-15");
    expect(readDate("say January 5", AT)).toBe("2027-01-05");
    expect(readDate("by 10/31", AT)).toBe("2026-10-31");
    expect(readDate("on 2026-11-02", AT)).toBe("2026-11-02");
    expect(readDate("end of quarter", AT)).toBe("2026-09-30");
    expect(readDate("by end of the month", AT)).toBe("2026-09-30");
    expect(readDate("EOY", AT)).toBe("2026-12-31");
  });
  it("names no date rather than guessing", () => {
    expect(readDate("soon", AT)).toBeNull();
    expect(readDate("February 30", AT)).toBeNull();
    expect(readDate("13/45", AT)).toBeNull();
  });
});

describe("grounding: a quote must be in the thread, and a date must be what the quote says", () => {
  const msgs = input("Next step is to send the MSA. We want to close by end of quarter.").messages;
  it("passes when both hold", () => {
    expect(
      groundOpportunityUpdate(
        {
          next_step: { value: "send the MSA", quote: "Next step is to send the MSA." },
          close_date: { value: "2026-09-30", quote: "We want to close by end of quarter." },
        },
        msgs,
      ),
    ).toEqual({ ok: true });
  });
  it("refuses a quote that is not there, a value that is not an excerpt, and a date the quote does not hold", () => {
    const r = groundOpportunityUpdate(
      {
        next_step: { value: "send the SOW", quote: "Next step is to send the MSA." },
        close_date: { value: "2026-10-31", quote: "We want to close by end of quarter." },
      },
      msgs,
    );
    expect(r).toEqual({
      ok: false,
      violations: [
        "next_step: value is not an excerpt of the quote",
        "close_date: the quote reads as 2026-09-30, not 2026-10-31",
      ],
    });
    expect(
      groundOpportunityUpdate(
        { next_step: { value: "x", quote: "Never said." }, close_date: null },
        msgs,
      ),
    ).toMatchObject({ ok: false });
  });
});

describe("the deterministic reading", () => {
  it("finds an explicit next step and a close sentence, with the sentences attached", () => {
    const r = readOpportunityDeterministically(
      input("Thanks. Next step: send over the MSA for legal. We'd like to sign by end of quarter."),
    );
    expect(r.next_step).toEqual({
      value: "send over the MSA for legal",
      quote: "Next step: send over the MSA for legal.",
    });
    expect(r.close_date).toEqual({
      value: "2026-09-30",
      quote: "We'd like to sign by end of quarter.",
    });
    expect(
      groundOpportunityUpdate(
        r,
        input(
          "Thanks. Next step: send over the MSA for legal. We'd like to sign by end of quarter.",
        ).messages,
      ),
    ).toEqual({ ok: true });
  });
  it("reads 'I will' and 'can you' as next steps; says nothing when nothing is said or nothing changed", () => {
    expect(
      readOpportunityDeterministically(input("I'll send the contract tomorrow morning.")).next_step
        ?.value,
    ).toBe("send the contract tomorrow morning");
    expect(
      readOpportunityDeterministically(input("Can you confirm the seat count?")).next_step?.value,
    ).toBe("confirm the seat count");
    expect(readOpportunityDeterministically(input("Sounds good, thanks!"))).toEqual({
      next_step: null,
      close_date: null,
    });
    const same = input("Next step: send the MSA.", {
      current: { stage: "Proposal", next_step: "send the MSA", close_date: null },
    });
    expect(readOpportunityDeterministically(same).next_step).toBeNull();
  });
  it("a close sentence without a readable date proposes no date", () => {
    expect(
      readOpportunityDeterministically(input("We hope to close this soon.")).close_date,
    ).toBeNull();
  });
});

describe("which sentence is the next step", () => {
  it("an explicit 'next step' sentence beats a question that came before it", () => {
    const out = readOpportunityDeterministically({
      contact_display_name: "Sarah Chen",
      account_name: "Northwind",
      subject: "Enterprise pricing",
      current: { stage: "Proposal", next_step: null, close_date: "2026-12-31" },
      messages: [
        {
          from: "Sarah Chen",
          direction: "inbound",
          sent_at: "2026-09-18T10:00:00.000Z",
          text: "Thanks Alex. Can you confirm the price holds for 60 seats if we start in November? Next step: send over the MSA for legal. We'd like to sign by end of quarter.",
        },
      ],
    });
    expect(out.next_step?.value).toBe("send over the MSA for legal");
    expect(out.next_step?.quote).toBe("Next step: send over the MSA for legal.");
    expect(out.close_date?.value).toBe("2026-09-30");
  });
});
