import { describe, expect, it } from "vitest";
import {
  applyIntentRules,
  parseIntentRule,
  predraftAllowed,
  promotionFor,
  resolveScope,
  type ContactRef,
} from "../src/intents.js";
import type { Obligation } from "../src/types.js";

const contacts: ContactRef[] = [
  { address: "sarah@acme.com", display_name: "Sarah Chen", account_name: "Acme" },
  { address: "bob@client.com", display_name: "bob@client.com", account_name: "Client Co" },
  { address: "dan@client.com", display_name: "Dan", account_name: "Client Co" },
];

describe("scope: whom a sentence is about", () => {
  it("finds a name, an address or an account; longest match wins; nothing means everyone", () => {
    expect(resolveScope("Don't chase Sarah, she'll come back to us.", contacts)).toEqual({
      kind: "contact",
      value: "sarah@acme.com",
    });
    expect(resolveScope("no more emails to bob@client.com", contacts)).toEqual({
      kind: "contact",
      value: "bob@client.com",
    });
    expect(resolveScope("Acme procurement is slow, leave them be", contacts)).toEqual({
      kind: "account",
      value: "Acme",
    });
    expect(resolveScope("Never follow up more than twice.", contacts)).toEqual({ kind: "global" });
    // "Dan" inside "Dance" is not Dan.
    expect(resolveScope("Dance recital tomorrow, keep it light", contacts)).toEqual({
      kind: "global",
    });
    // A bare address still answers to the name a person would use for it.
    expect(resolveScope("bob is fine", contacts)).toEqual({
      kind: "contact",
      value: "bob@client.com",
    });
  });
});

describe("rules: what a sentence enforces", () => {
  it("recognises 'don't chase' in its everyday forms, scoped", () => {
    for (const t of [
      "Don't chase Acme",
      "Do not follow up with Sarah",
      "Never email Dan again",
      "Stop nudging Sarah",
      "please don't reach out to Acme",
    ]) {
      expect(parseIntentRule(t, contacts)?.kind).toBe("no_chase");
    }
    expect(parseIntentRule("Don't chase Acme", contacts)).toEqual({
      kind: "no_chase",
      scope: { kind: "account", value: "Acme" },
    });
  });

  it("recognises 'no more than N' in words and digits, bounded", () => {
    expect(parseIntentRule("Never follow up more than twice.", contacts)).toEqual({
      kind: "max_chases",
      max: 2,
      scope: { kind: "global" },
    });
    expect(parseIntentRule("At most 3 follow-ups per thread", contacts)).toMatchObject({
      kind: "max_chases",
      max: 3,
    });
    expect(parseIntentRule("no more than once with Sarah", contacts)).toEqual({
      kind: "max_chases",
      max: 1,
      scope: { kind: "contact", value: "sarah@acme.com" },
    });
    expect(parseIntentRule("no more than 50 times", contacts)).toBeNull();
  });

  it("everything else is guidance, not a rule", () => {
    expect(parseIntentRule("After a demo, send a recap the same day.", contacts)).toBeNull();
    expect(parseIntentRule("Sign off as Cheers, A", contacts)).toBeNull();
    expect(parseIntentRule("Sarah prefers short emails", contacts)).toBeNull();
  });
});

describe("applying rules to what was detected", () => {
  const ob = (thread_id: string, contact: string, kind: Obligation["kind"]): Obligation => ({
    thread_id,
    contact_id: contact,
    kind,
    rank: 50,
    reason: {
      kind,
      days_elapsed: 6,
      threshold_days: 5,
      last_direction: "outbound",
      message_count: 2,
      has_open_deal: null,
    },
  });
  const byId = new Map<string, ContactRef>([
    ["c-sarah", contacts[0]!],
    ["c-bob", contacts[1]!],
    ["c-dan", contacts[2]!],
  ]);
  const threads = new Map([
    ["t1", { thread_id: "t1", chase_count: 1 }],
    ["t2", { thread_id: "t2", chase_count: 2 }],
    ["t3", { thread_id: "t3", chase_count: 3 }],
  ]);

  it("sets aside chases in scope, never a reply the person owes, and names the rule that did it", () => {
    const rules = [
      {
        id: "i-acme",
        rule: { kind: "no_chase" as const, scope: { kind: "account" as const, value: "Acme" } },
      },
    ];
    const r = applyIntentRules(
      [
        ob("t1", "c-sarah", "awaiting_them"),
        ob("t2", "c-sarah", "awaiting_you"),
        ob("t3", "c-bob", "awaiting_them"),
      ],
      rules,
      byId,
      threads,
    );
    expect(r.skipped.map((s) => [s.obligation.thread_id, s.intent_id])).toEqual([["t1", "i-acme"]]);
    expect(r.kept.map((o) => o.thread_id)).toEqual(["t2", "t3"]);
  });

  it("'no more than N' counts the chases already made, at the boundary", () => {
    const rules = [
      {
        id: "i-max",
        rule: { kind: "max_chases" as const, max: 2, scope: { kind: "global" as const } },
      },
    ];
    const r = applyIntentRules(
      [
        ob("t1", "c-dan", "awaiting_them"),
        ob("t2", "c-dan", "awaiting_them"),
        ob("t3", "c-dan", "awaiting_them"),
      ],
      rules,
      byId,
      threads,
    );
    expect(r.kept.map((o) => o.thread_id)).toEqual(["t1"]);
    expect(r.skipped.map((s) => s.obligation.thread_id)).toEqual(["t2", "t3"]);
  });

  it("with no rules, nothing changes", () => {
    const r = applyIntentRules([ob("t1", "c-dan", "awaiting_them")], [], byId, threads);
    expect(r).toEqual({ kept: [ob("t1", "c-dan", "awaiting_them")], skipped: [] });
  });
});

describe("'don't draft for me'", () => {
  it("is a rule about drafting, scoped like the others, and never sets a detection aside", () => {
    for (const t of [
      "Don't write drafts for me",
      "No drafts unless I ask",
      "Never draft for Acme",
      "stop drafting",
    ]) {
      expect(parseIntentRule(t, contacts)?.kind).toBe("no_predraft");
    }
    expect(parseIntentRule("Never draft for Acme", contacts)).toEqual({
      kind: "no_predraft",
      scope: { kind: "account", value: "Acme" },
    });
    const rules = [
      {
        id: "i",
        rule: { kind: "no_predraft" as const, scope: { kind: "account" as const, value: "Acme" } },
      },
    ];
    expect(predraftAllowed(rules, contacts[0], "awaiting_them")).toBe(false);
    expect(predraftAllowed(rules, contacts[1], "awaiting_them")).toBe(true);
    expect(predraftAllowed([], contacts[0], "awaiting_them")).toBe(true);
    const ob = {
      thread_id: "t",
      contact_id: "c-sarah",
      kind: "awaiting_them" as const,
      rank: 1,
      reason: {
        kind: "awaiting_them" as const,
        days_elapsed: 6,
        threshold_days: 5,
        last_direction: "outbound" as const,
        message_count: 1,
        has_open_deal: null,
      },
    };
    expect(
      applyIntentRules([ob], rules, new Map([["c-sarah", contacts[0]!]]), new Map()).skipped,
    ).toEqual([]);
  });
});

describe("a promotion", () => {
  it("covers exactly one kind and one shape, within its scope, and never sets a detection aside", () => {
    const rules = [
      {
        id: "p",
        rule: {
          kind: "auto_action" as const,
          action_kind: "salesforce.log_activity",
          shape_sha256: "abc",
          scope: { kind: "account" as const, value: "Acme" },
        },
      },
    ];
    expect(
      promotionFor(
        rules,
        { kind: "salesforce.log_activity", shape_sha256: "abc" },
        contacts[0],
        "awaiting_them",
      )?.id,
    ).toBe("p");
    expect(
      promotionFor(
        rules,
        { kind: "salesforce.log_activity", shape_sha256: "xyz" },
        contacts[0],
        "awaiting_them",
      ),
    ).toBeUndefined();
    expect(
      promotionFor(
        rules,
        { kind: "salesforce.update_stage", shape_sha256: "abc" },
        contacts[0],
        "awaiting_them",
      ),
    ).toBeUndefined();
    expect(
      promotionFor(
        rules,
        { kind: "salesforce.log_activity", shape_sha256: "abc" },
        contacts[1],
        "awaiting_them",
      ),
    ).toBeUndefined();
    const ob = {
      thread_id: "t",
      contact_id: "c-sarah",
      kind: "awaiting_them" as const,
      rank: 1,
      reason: {
        kind: "awaiting_them" as const,
        days_elapsed: 6,
        threshold_days: 5,
        last_direction: "outbound" as const,
        message_count: 1,
        has_open_deal: null,
      },
    };
    expect(
      applyIntentRules([ob], rules, new Map([["c-sarah", contacts[0]!]]), new Map()).skipped,
    ).toEqual([]);
  });
});
