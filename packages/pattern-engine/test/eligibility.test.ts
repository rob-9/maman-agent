import { describe, expect, it } from "vitest";
import {
  evaluateEligibility,
  summarizeEligibility,
  UNTUNABLE_BARS,
  type EligibilityInput,
  type EligibilityVerdict,
} from "../src/eligibility.js";
import { ELIGIBILITY } from "../src/scoring.js";

/** An input that clears every bar comfortably; each test spoils exactly one. */
function passing(over: Partial<EligibilityInput> = {}): EligibilityInput {
  return {
    pattern_id: "p-1",
    occurrence_count: 6,
    distinct_day_count: 3,
    similarity_mean: 0.9,
    projected_minutes_saved_weekly: 70,
    feasibility_score: 0.8,
    risk_score: 0.3,
    opportunity_score: 0.72,
    excluded_from_learning: false,
    has_restricted_sensitivity: false,
    dismissed_recently: false,
    suppressed: false,
    ...over,
  };
}

const verdict = (over: Partial<EligibilityInput> = {}, opportunity = 0.65): EligibilityVerdict =>
  evaluateEligibility(passing(over), ELIGIBILITY, opportunity);

describe("evaluateEligibility", () => {
  it("passes every bar for a healthy pattern", () => {
    const v = verdict();
    expect(v.eligible).toBe(true);
    expect(v.surfaceable).toBe(true);
    expect(v.failed).toEqual([]);
    expect(v.bars.every((b) => b.passed)).toBe(true);
  });

  it("reports ALL failures, not just the first", () => {
    // A thin history typically misses several bars at once. Stopping at the
    // first would send someone to fix occurrences when similarity was never
    // going to pass either — the whole reason this does not short-circuit.
    const v = verdict({ occurrence_count: 1, distinct_day_count: 1, similarity_mean: 0.4 });
    expect(v.eligible).toBe(false);
    expect(v.failed.map((f) => f.bar).sort()).toEqual([
      "distinct_days",
      "occurrences",
      "similarity",
    ]);
  });

  it("measures how far short a min-bar fell", () => {
    const v = verdict({ feasibility_score: 0.5 });
    const bar = v.failed.find((f) => f.bar === "feasibility")!;
    expect(bar.actual).toBe(0.5);
    expect(bar.required).toBe(0.6);
    expect(bar.shortfall).toBeCloseTo(0.1, 5);
  });

  it("measures how far OVER a max-bar sat", () => {
    // risk is a ceiling, so the distance runs the other way. Reporting a
    // negative shortfall here would make the ranking meaningless.
    const v = verdict({ risk_score: 0.9 });
    const bar = v.failed.find((f) => f.bar === "risk")!;
    expect(bar.shortfall).toBeCloseTo(0.2, 5);
    expect(bar.shortfall!).toBeGreaterThan(0);
  });

  it("ranks failures nearest-to-passing first, comparing across units", () => {
    // THE CASE THAT CAUGHT THE FIRST IMPLEMENTATION. Raw shortfalls are 1
    // (occurrences) and 0.5 (feasibility), so sorting on them put feasibility
    // first. But 1-of-3 is a third of the way off while 0.5-of-0.6 is 83% off,
    // and occurrences is plainly the cheaper thing to move. Only the relative
    // shortfall gets this right.
    const v = verdict({ occurrence_count: 2, feasibility_score: 0.1 });
    expect(v.failed[0]!.bar).toBe("occurrences");
    expect(v.failed[0]!.shortfall).toBe(1);
    expect(v.failed[0]!.relative_shortfall).toBeCloseTo(1 / 3, 3);
    expect(v.failed[1]!.bar).toBe("feasibility");
    expect(v.failed[1]!.shortfall).toBeCloseTo(0.5, 5);
    expect(v.failed[1]!.relative_shortfall).toBeCloseTo(0.8333, 3);
    // The raw ordering would have been the reverse — pinned so a future
    // refactor cannot quietly sort on `shortfall` again.
    expect(v.failed[0]!.shortfall!).toBeGreaterThan(v.failed[1]!.shortfall!);
  });

  it("sorts magnitude-less bars last — a refusal is not a near miss", () => {
    const v = verdict({ suppressed: true, occurrence_count: 2 });
    expect(v.failed[0]!.bar).toBe("occurrences");
    expect(v.failed.at(-1)!.bar).toBe("suppressed");
    expect(v.failed.at(-1)!.shortfall).toBeNull();
  });

  it("marks the safety bars untunable and the volume bars tunable", () => {
    const v = verdict();
    const tunable = (n: string) => v.bars.find((b) => b.bar === n)!.tunable;
    expect(tunable("occurrences")).toBe(true);
    expect(tunable("distinct_days")).toBe(true);
    expect(tunable("projected_minutes")).toBe(true);
    // These three are exactly what effectiveEligibility refuses to relax.
    expect(tunable("similarity")).toBe(false);
    expect(tunable("feasibility")).toBe(false);
    expect(tunable("risk")).toBe(false);
  });

  it("agrees with UNTUNABLE_BARS", () => {
    for (const bar of verdict().bars) {
      expect(bar.tunable).toBe(!UNTUNABLE_BARS.has(bar.bar));
    }
  });

  it.each([
    ["occurrences", { occurrence_count: 1 }],
    ["distinct_days", { distinct_day_count: 1 }],
    ["similarity", { similarity_mean: 0.1 }],
    ["projected_minutes", { projected_minutes_saved_weekly: 1 }],
    ["feasibility", { feasibility_score: 0.1 }],
    ["risk", { risk_score: 0.99 }],
    ["excluded_from_learning", { excluded_from_learning: true }],
    ["restricted_sensitivity", { has_restricted_sensitivity: true }],
    ["dismissed_recently", { dismissed_recently: true }],
    ["suppressed", { suppressed: true }],
  ])("a failing %s bar alone blocks eligibility", (bar, over) => {
    const v = verdict(over as Partial<EligibilityInput>);
    expect(v.eligible).toBe(false);
    expect(v.failed).toHaveLength(1);
    expect(v.failed[0]!.bar).toBe(bar);
  });

  it("separates eligible from surfaceable — opportunity is a ranking bar, not a gate", () => {
    // Every bar passes but opportunity is below threshold: the pattern is
    // legitimate and simply not the best thing to show. Conflating the two
    // would report a healthy pattern as rejected.
    const v = verdict({ opportunity_score: 0.2 });
    expect(v.eligible).toBe(true);
    expect(v.surfaceable).toBe(false);
    expect(v.failed).toEqual([]);
  });
});

describe("summarizeEligibility", () => {
  it("counts the population", () => {
    const s = summarizeEligibility([verdict(), verdict({ occurrence_count: 1 })]);
    expect(s.candidates).toBe(2);
    expect(s.eligible).toBe(1);
    expect(s.surfaceable).toBe(1);
  });

  it("ranks by SOLE blocker, not raw block count", () => {
    // THE LOAD-BEARING BEHAVIOUR. `occurrences` blocks 3 here and `feasibility`
    // blocks 2 — but two of the occurrence failures ALSO miss similarity, so
    // relaxing occurrences would free only one. Ranking by raw count would
    // point at the wrong bar, which on a thin history is always the volume
    // bars, and "wait longer" is not a finding.
    const s = summarizeEligibility([
      verdict({ occurrence_count: 1 }),
      verdict({ occurrence_count: 1, similarity_mean: 0.2 }),
      verdict({ occurrence_count: 1, similarity_mean: 0.2 }),
      verdict({ feasibility_score: 0.1 }),
      verdict({ feasibility_score: 0.1 }),
    ]);
    const occ = s.tallies.find((t) => t.bar === "occurrences")!;
    const feas = s.tallies.find((t) => t.bar === "feasibility")!;
    expect(occ.blocked).toBe(3);
    expect(occ.sole_blocker).toBe(1);
    expect(feas.blocked).toBe(2);
    expect(feas.sole_blocker).toBe(2);
    // Feasibility ranks first despite blocking fewer.
    expect(s.tallies[0]!.bar).toBe("feasibility");
  });

  it("reports the median shortfall among the candidates a bar blocked", () => {
    const s = summarizeEligibility([
      verdict({ feasibility_score: 0.5 }), // short 0.1
      verdict({ feasibility_score: 0.4 }), // short 0.2
      verdict({ feasibility_score: 0.3 }), // short 0.3
    ]);
    expect(s.tallies.find((t) => t.bar === "feasibility")!.median_shortfall).toBeCloseTo(0.2, 5);
  });

  it("leaves median_shortfall null for magnitude-less bars", () => {
    const s = summarizeEligibility([verdict({ suppressed: true })]);
    expect(s.tallies.find((t) => t.bar === "suppressed")!.median_shortfall).toBeNull();
  });

  it("handles an empty population without inventing bars", () => {
    const s = summarizeEligibility([]);
    expect(s).toEqual({ candidates: 0, eligible: 0, surfaceable: 0, tallies: [] });
  });
});
