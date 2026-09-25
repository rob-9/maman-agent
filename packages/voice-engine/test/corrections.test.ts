import { describe, expect, it } from "vitest";
import { compareText, greetingOf, signoffOf, wordCount } from "../src/corrections.js";

const draft = `Hi Sarah,

I hope you're well. Following up on "Enterprise pricing" from last week. The price holds for 60 seats if you start in November, and I can send the MSA over today.

Would it help to find a time this week to pick this up?

Best regards,
Alex
`;

describe("what changed between a draft and what was sent", () => {
  it("reads the greeting and the sign-off as forms, without the person", () => {
    expect(greetingOf(draft)).toBe("Hi {name},");
    expect(greetingOf("Hello,\n\nQuick one.")).toBe("Hello,");
    expect(greetingOf("Quick one.")).toBeNull();
    expect(signoffOf(draft)).toBe("Best regards, Alex");
    expect(signoffOf("Thanks!\nAlex")).toBe("Thanks, Alex");
    expect(signoffOf("Cheers")).toBe("Cheers");
    expect(signoffOf("No closing here.")).toBeNull();
    expect(wordCount("  a b   c ")).toBe(3);
  });

  it("a shorter, blunter version with a different sign-off carries each change as a signal", () => {
    const sent = `Hi Sarah,

Yes, the price holds for 60 seats from November. MSA on its way today.

Best,
Alex
`;
    const c = compareText(draft, sent);
    expect(c.signals).toEqual(["shorter", "signoff:Best, Alex", "no_opener"]);
    expect(c.summary).toMatchObject({
      greeting_proposed: "Hi {name},",
      greeting_actual: "Hi {name},",
      signoff_proposed: "Best regards, Alex",
      signoff_actual: "Best, Alex",
      opener_dropped: true,
    });
    expect(c.summary.words_actual).toBeLessThan(c.summary.words_proposed);
  });

  it("sent as written is no signal at all; a longer rewrite with a new greeting says so", () => {
    expect(compareText(draft, draft).signals).toEqual([]);
    const longer = `Hey Sarah,\n\nI hope you're well. ${"More detail here. ".repeat(30)}\n\nBest regards,\nAlex`;
    const c = compareText(draft, longer);
    expect(c.signals).toEqual(["longer", "greeting:Hey {name},"]);
  });
});
