import { describe, expect, it } from "vitest";
import {
  applyIntentRules,
  fieldSkipped,
  inferFromCorrections,
  inferIntents,
  type Correction,
  type Decision,
} from "../src/index.js";
import type { Obligation } from "../src/types.js";

const bob = { address: "bob@client.com", display_name: "Bob Ray", account_name: "Client Co" };
const ann = { address: "ann@client.com", display_name: "Ann Lee", account_name: "Client Co" };
const sam = { address: "sam@other.com", display_name: "Sam Poe", account_name: "Other" };
const d = (over: Partial<Decision> & { contact: Decision["contact"] }): Decision => ({
  kind: "awaiting_them",
  outcome: "dismissed",
  days_elapsed: 6,
  ...over,
});

describe("what the agent infers from decisions", () => {
  it("two follow-ups set aside with one person is 'don't chase them'; one is not", () => {
    expect(inferIntents([d({ contact: bob })], [])).toEqual([]);
    const out = inferIntents([d({ contact: bob }), d({ contact: bob, days_elapsed: 9 })], []);
    expect(out.map((o) => o.text)).toEqual(["Don't chase Bob Ray."]);
    expect(out[0]!.evidence).toBe("You set aside 2 follow-ups with Bob Ray.");
    expect(out[0]!.rule).toEqual({
      kind: "no_chase",
      scope: { kind: "contact", value: "bob@client.com" },
    });
  });

  it("three across an account from two people is 'don't chase the account'", () => {
    // One of them after a meeting, so only two are "gone quiet" and no waiting rule forms.
    const out = inferIntents(
      [
        d({ contact: bob, kind: "unsent_followup" }),
        d({ contact: ann }),
        d({ contact: ann, days_elapsed: 8 }),
      ],
      [],
    );
    expect(out.map((o) => o.text)).toEqual(["Don't chase Ann Lee.", "Don't chase Client Co."]);
    // Three from one person is that person, not the account.
    const one = inferIntents(
      [
        d({ contact: bob, kind: "unsent_followup" }),
        d({ contact: bob, kind: "unsent_followup" }),
        d({ contact: bob }),
      ],
      [],
    );
    expect(one.map((o) => o.text)).toEqual(["Don't chase Bob Ray."]);
  });

  it("three follow-ups set aside young, with none acted on that young, is a waiting rule", () => {
    const young = [
      d({ contact: bob, days_elapsed: 5 }),
      d({ contact: ann, days_elapsed: 7 }),
      d({ contact: sam, days_elapsed: 6 }),
    ];
    const out = inferIntents(young, []);
    expect(out.map((o) => o.text)).toEqual(["Wait 8 days before chasing."]);
    expect(out[0]!.rule).toEqual({ kind: "chase_after_days", days: 8, scope: { kind: "global" } });
    // Acting on one that young says the age was not the reason.
    const acted = inferIntents(
      [...young, d({ contact: sam, outcome: "drafted", days_elapsed: 6 })],
      [],
    );
    expect(acted.some((o) => o.rule.kind === "chase_after_days")).toBe(false);
    // Dismissing old ones says nothing about waiting.
    const old = inferIntents(
      young.map((x) => ({ ...x, days_elapsed: 20 })),
      [],
    );
    expect(old.some((o) => o.rule.kind === "chase_after_days")).toBe(false);
    // A reply owed is never a chase.
    expect(
      inferIntents(
        young.map((x) => ({ ...x, kind: "awaiting_you" as const })),
        [],
      ),
    ).toEqual([]);
  });

  it("never proposes a rule that already exists in any state, so a declined one stays declined", () => {
    const decisions = [d({ contact: bob }), d({ contact: bob })];
    expect(
      inferIntents(decisions, [
        { kind: "no_chase", scope: { kind: "contact", value: "bob@client.com" } },
      ]),
    ).toEqual([]);
    // A different scope is a different rule.
    expect(
      inferIntents(decisions, [
        { kind: "no_chase", scope: { kind: "account", value: "Client Co" } },
      ]).length,
    ).toBe(1);
    const young = [
      d({ contact: bob, days_elapsed: 5 }),
      d({ contact: ann, days_elapsed: 7 }),
      d({ contact: sam, days_elapsed: 6 }),
    ];
    expect(
      inferIntents(young, [{ kind: "chase_after_days", days: 10, scope: { kind: "global" } }]).some(
        (o) => o.rule.kind === "chase_after_days",
      ),
    ).toBe(false);
  });
});

describe("'wait N days before chasing', applied", () => {
  const ob = (kind: Obligation["kind"], days: number, contact = "c1"): Obligation => ({
    thread_id: `t-${kind}-${days}-${contact}`,
    contact_id: contact,
    kind,
    rank: 50,
    reason: {
      kind,
      days_elapsed: days,
      threshold_days: 5,
      last_direction: "outbound",
      message_count: 2,
      has_open_deal: null,
    },
  });
  const rules = [
    {
      id: "i1",
      rule: { kind: "chase_after_days" as const, days: 8, scope: { kind: "global" as const } },
    },
  ];
  const contacts = new Map([["c1", bob]]);

  it("sets aside a thread gone quiet for fewer days than the wait, keeps older ones and every reply owed", () => {
    const applied = applyIntentRules(
      [
        ob("awaiting_them", 6),
        ob("awaiting_them", 8),
        ob("awaiting_you", 6),
        ob("unsent_followup", 6),
      ],
      rules,
      contacts,
      new Map(),
    );
    expect(applied.skipped.map((s) => s.obligation.thread_id)).toEqual(["t-awaiting_them-6-c1"]);
    expect(applied.skipped[0]!.intent_id).toBe("i1");
    expect(applied.kept.map((k) => k.thread_id)).toEqual([
      "t-awaiting_them-8-c1",
      "t-awaiting_you-6-c1",
      "t-unsent_followup-6-c1",
    ]);
  });

  it("scoped to a contact, it leaves other people alone", () => {
    const scoped = [
      {
        id: "i2",
        rule: {
          kind: "chase_after_days" as const,
          days: 8,
          scope: { kind: "contact" as const, value: "bob@client.com" },
        },
      },
    ];
    const applied = applyIntentRules(
      [ob("awaiting_them", 6, "c1"), ob("awaiting_them", 6, "c2")],
      scoped,
      new Map([
        ["c1", bob],
        ["c2", sam],
      ]),
      new Map(),
    );
    expect(applied.skipped.map((s) => s.obligation.contact_id)).toEqual(["c1"]);
  });
});

describe("what the agent infers from corrections", () => {
  const draft = (signals: string[], words = 60): Correction => ({
    kind: "draft",
    signals,
    summary: { words_actual: words },
  });
  const crm = (signals: string[]): Correction => ({ kind: "crm_field", signals, summary: {} });

  it("the same sign-off three times is how they sign; twice is not", () => {
    expect(
      inferFromCorrections([draft(["signoff:Best, Alex"]), draft(["signoff:Best, Alex"])], []),
    ).toEqual([]);
    const out = inferFromCorrections(
      [
        draft(["signoff:Best, Alex"]),
        draft(["signoff:Best, Alex"]),
        draft(["signoff:Best, Alex", "shorter"]),
      ],
      [],
    );
    expect(out.map((o) => o.text)).toEqual(['Sign off with "Best, Alex".']);
    expect(out[0]!.evidence).toBe('You changed the sign-off to "Best, Alex" on 3 drafts.');
    expect(out[0]!.rule).toEqual({
      kind: "style",
      key: "signoff",
      value: "Best, Alex",
      scope: { kind: "global" },
    });
    // Dropping the sign-off is not a sign-off to learn.
    expect(
      inferFromCorrections(
        [draft(["signoff:none"]), draft(["signoff:none"]), draft(["signoff:none"])],
        [],
      ),
    ).toEqual([]);
  });

  it("three shortened drafts become a length, from the median of what they sent, rounded", () => {
    const out = inferFromCorrections(
      [draft(["shorter"], 48), draft(["shorter"], 61), draft(["shorter"], 90)],
      [],
    );
    expect(out.map((o) => o.text)).toEqual(["Keep drafts short, about 60 words."]);
    expect(out[0]!.rule).toEqual({
      kind: "style",
      key: "length",
      value: "60",
      scope: { kind: "global" },
    });
    const opener = inferFromCorrections(
      [draft(["no_opener"]), draft(["no_opener"]), draft(["no_opener"])],
      [],
    );
    expect(opener[0]!.text).toBe("Skip the pleasantries at the top. Get to the point.");
    const greeting = inferFromCorrections(
      [
        draft(["greeting:Hey {name},"]),
        draft(["greeting:Hey {name},"]),
        draft(["greeting:Hey {name},"]),
      ],
      [],
    );
    expect(greeting[0]!.text).toBe('Open with "Hey first name,".');
  });

  it("declined and overwritten field changes count together, and become 'don't propose this field'", () => {
    const out = inferFromCorrections(
      [
        crm(["declined:close_date"]),
        crm(["hand_edit:close_date"]),
        crm(["declined:close_date", "declined:next_step"]),
      ],
      [],
    );
    expect(out.map((o) => o.text)).toEqual(["Don't propose changes to the close date."]);
    expect(out[0]!.evidence).toBe("You turned down or rewrote 3 proposed close date changes.");
    expect(out[0]!.rule).toEqual({
      kind: "skip_field",
      field: "close_date",
      scope: { kind: "global" },
    });
  });

  it("never proposes a style or field rule that already exists, whatever its value", () => {
    const three = [
      draft(["signoff:Best, Alex"]),
      draft(["signoff:Best, Alex"]),
      draft(["signoff:Best, Alex"]),
    ];
    expect(
      inferFromCorrections(three, [
        { kind: "style", key: "signoff", value: "Cheers, Alex", scope: { kind: "global" } },
      ]),
    ).toEqual([]);
    const fields = [
      crm(["declined:next_step"]),
      crm(["declined:next_step"]),
      crm(["declined:next_step"]),
    ];
    expect(
      inferFromCorrections(fields, [
        { kind: "skip_field", field: "next_step", scope: { kind: "global" } },
      ]),
    ).toEqual([]);
  });

  it("a kept 'skip this field' rule is found for the field, in scope", () => {
    const rules = [
      {
        id: "i1",
        rule: {
          kind: "skip_field" as const,
          field: "close_date" as const,
          scope: { kind: "contact" as const, value: "bob@client.com" },
        },
      },
    ];
    expect(fieldSkipped(rules, "close_date", bob)?.id).toBe("i1");
    expect(fieldSkipped(rules, "next_step", bob)).toBeUndefined();
    expect(fieldSkipped(rules, "close_date", sam)).toBeUndefined();
    expect(
      fieldSkipped(
        [
          {
            id: "i2",
            rule: {
              kind: "skip_field" as const,
              field: "close_date" as const,
              scope: { kind: "global" as const },
            },
          },
        ],
        "close_date",
        undefined,
      )?.id,
    ).toBe("i2");
  });
});
