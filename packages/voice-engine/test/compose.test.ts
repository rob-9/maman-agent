import { describe, expect, it } from "vitest";
import { deterministicComposer, firstNameOf, type ComposeInput } from "../src/index.js";

const base: ComposeInput = {
  kind: "awaiting_them",
  contact_display_name: "Sarah Chen",
  contact_address: "sarah@acme.com",
  account_name: "Acme",
  subject: "Enterprise pricing",
  days_elapsed: 9,
  sender_name: "Alice",
};

describe("firstNameOf", () => {
  it("takes the first word of a display name", () => {
    expect(firstNameOf("Sarah Chen")).toBe("Sarah");
  });
  it("never guesses a name from an address", () => {
    // "sarah@acme.com" → "Hi sarah," reads as a bot. "there" is honest.
    expect(firstNameOf("sarah@acme.com")).toBe("there");
    expect(firstNameOf("")).toBe("there");
  });
});

describe("deterministicComposer", () => {
  it("is deterministic", async () => {
    expect(await deterministicComposer.compose(base)).toEqual(
      await deterministicComposer.compose(base),
    );
  });

  it("addresses the contact, replies on the thread subject, signs as the sender", async () => {
    const d = await deterministicComposer.compose(base);
    expect(d.to).toBe("sarah@acme.com");
    expect(d.subject).toBe("Re: Enterprise pricing");
    expect(d.body.startsWith("Hi Sarah,")).toBe(true);
    expect(d.body.trimEnd().endsWith("Alice")).toBe(true);
    expect(d.composer).toBe("deterministic");
  });

  it("does not double a Re: prefix", async () => {
    const d = await deterministicComposer.compose({ ...base, subject: "Re: Pricing" });
    expect(d.subject).toBe("Re: Pricing");
  });

  it("apologises when the user owes the reply, and does not when they are waiting", async () => {
    const owed = await deterministicComposer.compose({
      ...base,
      kind: "awaiting_you",
      days_elapsed: 3,
    });
    expect(owed.body).toMatch(/apologies/i);
    const waiting = await deterministicComposer.compose(base);
    expect(waiting.body).not.toMatch(/apologies/i);
  });

  it("names the gap and never invents content", async () => {
    // We hold gmail.metadata: subject, who, how long. Not what was said.
    // The draft may reference the topic by subject; it must not claim more.
    const d = await deterministicComposer.compose(base);
    expect(d.body).toContain('"Enterprise pricing"');
    expect(d.body).not.toMatch(/you (said|mentioned|asked)/i);
  });

  it("rejects malformed input rather than drafting nonsense", async () => {
    await expect(
      deterministicComposer.compose({ ...base, contact_address: "" } as ComposeInput),
    ).rejects.toThrow();
  });
});
