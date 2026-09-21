import { describe, expect, it } from "vitest";
import {
  ELIGIBILITY,
  evaluateEligibility,
  OPPORTUNITY_THRESHOLD,
  type BarName,
} from "@maman/pattern-engine";
import type { PatternCandidate } from "@maman/contracts";
import { patternGates } from "../src/lib/forming.js";

/**
 * The "Forming" progress must mirror the real pattern-engine eligibility bars
 * exactly (no invented criteria) and speak plainly about what's still needed.
 */

function candidate(over: Partial<PatternCandidate> = {}): PatternCandidate {
  return {
    pattern_id: "018f0000-0000-7000-8000-000000000001",
    owner_user_id: "018f0000-0000-7000-8000-0000000000aa",
    first_seen_at: "2026-07-14T09:40:00.000Z",
    last_seen_at: "2026-07-16T15:00:00.000Z",
    occurrence_count: 6,
    distinct_day_count: 3,
    median_duration_ms: 660_000,
    p90_duration_ms: 780_000,
    canonical_sequence: [],
    episode_ids: [],
    similarity_mean: 0.9,
    repeatability_score: 0.9,
    feasibility_score: 0.8,
    risk_score: 0.3,
    projected_minutes_saved_weekly: 70,
    opportunity_score: 0.72,
    status: "candidate",
    ...over,
  };
}

const PASSING_REPLAY = { runs_tested: 21, runs_matched: 19, min_runs: 10, min_match_pct: 0.85 };

describe("patternGates (forming progress)", () => {
  it("a fully-qualified, replay-proven pattern meets every check and reads as ready", () => {
    const p = patternGates(candidate(), PASSING_REPLAY);
    expect(p.metCount).toBe(p.total);
    expect(p.ratio).toBe(1);
    expect(p.nextStep).toMatch(/ready/i);
  });

  it("without replay data the replay gate is honestly unmet", () => {
    const p = patternGates(candidate());
    const replay = p.gates.find((g) => g.key === "replay")!;
    expect(replay.met).toBe(false);
    expect(replay.detail).toBe("not tested yet");
    expect(p.metCount).toBe(p.total - 1);
  });

  it("replay-only-unmet explains the score in plain language", () => {
    const p = patternGates(candidate(), {
      runs_tested: 21,
      runs_matched: 15, // 71% < 85%
      min_runs: 10,
      min_match_pct: 0.85,
    });
    const replay = p.gates.find((g) => g.key === "replay")!;
    expect(replay.met).toBe(false);
    expect(replay.detail).toContain("matched 15 of 21");
    expect(p.nextStep).toMatch(/matched 15 of your last 21 runs/);
  });

  it("too few tested runs asks for more runs, not more accuracy", () => {
    const p = patternGates(candidate(), {
      runs_tested: 4,
      runs_matched: 4,
      min_runs: 10,
      min_match_pct: 0.85,
    });
    expect(p.gates.find((g) => g.key === "replay")!.met).toBe(false);
    expect(p.nextStep).toMatch(/4 so far — 6 more/);
  });

  it("too-few repeats is the blocking check and the copy counts what's left", () => {
    const p = patternGates(candidate({ occurrence_count: 2, distinct_day_count: 1 }));
    expect(p.gates.find((g) => g.key === "repeats")!.met).toBe(false);
    expect(p.gates.find((g) => g.key === "repeats")!.detail).toBe("2 of 3 times");
    // Repeats is prioritized in the next-step sentence.
    expect(p.nextStep).toMatch(/1 more repeat/i);
    expect(p.metCount).toBeLessThan(p.total);
  });

  it("enough repeats but not enough distinct days asks for more days", () => {
    const p = patternGates(candidate({ occurrence_count: 5, distinct_day_count: 1 }));
    expect(p.gates.find((g) => g.key === "repeats")!.met).toBe(true);
    expect(p.gates.find((g) => g.key === "days")!.met).toBe(false);
    expect(p.nextStep).toMatch(/1 more day/i);
  });

  it("low consistency and low opportunity are surfaced as unmet checks", () => {
    const p = patternGates(candidate({ similarity_mean: 0.5, opportunity_score: 0.4 }));
    expect(p.gates.find((g) => g.key === "consistency")!.met).toBe(false);
    expect(p.gates.find((g) => g.key === "opportunity")!.met).toBe(false);
  });

  it("high risk fails the low-risk check", () => {
    const p = patternGates(candidate({ risk_score: 0.9 }));
    expect(p.gates.find((g) => g.key === "risk")!.met).toBe(false);
  });
});

describe("effective bars (live demo tuning)", () => {
  it("gates evaluate and display the tuned values, not the production defaults", () => {
    const c = candidate({
      occurrence_count: 4,
      distinct_day_count: 1,
      projected_minutes_saved_weekly: 8,
    });
    const tuned = patternGates(c, undefined, {
      eligibility: {
        ...ELIGIBILITY,
        min_occurrences: 3,
        min_distinct_days: 1,
        min_projected_minutes_weekly: 3,
      },
      opportunity_threshold: 0.5,
    });
    const byKey = Object.fromEntries(tuned.gates.map((g) => [g.key, g]));
    expect(byKey["repeats"]!.met).toBe(true);
    expect(byKey["repeats"]!.detail).toBe("4 of 3 times");
    expect(byKey["days"]!.met).toBe(true);
    expect(byKey["days"]!.detail).toBe("1 of 1 days");
    expect(byKey["time"]!.met).toBe(true);
    // Production bars would fail the same candidate on days.
    const prod = patternGates(c);
    expect(Object.fromEntries(prod.gates.map((g) => [g.key, g]))["days"]!.met).toBe(false);
  });
});

describe("the feasibility gate distinguishes 'never' from 'not yet'", () => {
  /**
   * The bug this pins: a pattern with feasibility 0 can NEVER qualify (no step
   * maps to a capability), while one at 0.5 might qualify with a small change.
   * Both used to read "not yet", so a permanently-stuck pattern was
   * indistinguishable from one about to arrive. A real machine sat at 0 for
   * 10,439 events and the UI never said so.
   */
  const gate = (feasibility: number) =>
    patternGates(candidate({ feasibility_score: feasibility })).gates.find(
      (g) => g.key === "feasibility",
    )!;

  it("says plainly when nothing maps, rather than 'not yet'", () => {
    const g = gate(0);
    expect(g.met).toBe(false);
    expect(g.detail).toBe("none of these steps map to something a helper can do");
    expect(g.detail).not.toContain("not yet");
  });

  it("reports the shortfall as a number when it is partial", () => {
    const g = gate(0.4);
    expect(g.met).toBe(false);
    expect(g.detail).toMatch(/40% of steps automatable \(need \d+%\)/);
  });

  it("reports the score when the gate is met", () => {
    const g = gate(1);
    expect(g.met).toBe(true);
    expect(g.detail).toBe("100% of steps automatable");
  });

  it("shows the risk number instead of a bare verdict", () => {
    const risky = patternGates(candidate({ risk_score: 0.95 })).gates.find(
      (g) => g.key === "risk",
    )!;
    expect(risky.met).toBe(false);
    expect(risky.detail).toMatch(/risk 95% \(limit \d+%\)/);
  });
});

describe("forming gates agree with the engine's eligibility verdict", () => {
  /**
   * THE DRIFT GUARD.
   *
   * `patternGates` used to re-derive every comparison the engine makes, so this
   * file and `runPatternEngine` were two implementations of one rule with
   * nothing holding them together. They now share `evaluateEligibility`; this
   * test fails if anyone reintroduces a local comparison.
   */
  const BAR_BY_GATE: Record<string, BarName> = {
    repeats: "occurrences",
    days: "distinct_days",
    consistency: "similarity",
    time: "projected_minutes",
    feasibility: "feasibility",
    risk: "risk",
  };

  const subject = (over: Partial<PatternCandidate>): PatternCandidate =>
    ({
      pattern_id: "00000000-0000-7000-8000-00000000c0de",
      owner_user_id: "00000000-0000-7000-8000-00000000beef",
      first_seen_at: "2026-09-01T09:00:00.000Z",
      last_seen_at: "2026-09-03T09:00:00.000Z",
      occurrence_count: 6,
      distinct_day_count: 3,
      median_duration_ms: 660_000,
      p90_duration_ms: 780_000,
      canonical_sequence: [],
      episode_ids: [],
      similarity_mean: 0.9,
      repeatability_score: 0.9,
      feasibility_score: 0.8,
      risk_score: 0.3,
      projected_minutes_saved_weekly: 70,
      opportunity_score: 0.72,
      status: "candidate",
      ...over,
    }) as PatternCandidate;

  // EXACTLY ON EACH BOUNDARY, because that is the only place `>` and `>=`
  // differ — and a gate rewritten as a local comparison is most likely to get
  // the boundary wrong, not the direction. Without these rows this guard passes
  // against a reintroduced `c.feasibility_score > b.min_feasibility`, which is
  // how it was first written here.
  const cases: Array<Partial<PatternCandidate>> = [
    {},
    { occurrence_count: 1 },
    { distinct_day_count: 1 },
    { similarity_mean: 0.2 },
    { projected_minutes_saved_weekly: 2 },
    { feasibility_score: 0 },
    { risk_score: 0.95 },
    { occurrence_count: 2, feasibility_score: 0.59, risk_score: 0.71 },
    // on the bar, to the digit
    { occurrence_count: ELIGIBILITY.min_occurrences },
    { distinct_day_count: ELIGIBILITY.min_distinct_days },
    { similarity_mean: ELIGIBILITY.min_similarity_mean },
    { projected_minutes_saved_weekly: ELIGIBILITY.min_projected_minutes_weekly },
    { feasibility_score: ELIGIBILITY.min_feasibility },
    { risk_score: ELIGIBILITY.max_risk },
    // one ulp under / over, so "met" must flip
    { feasibility_score: ELIGIBILITY.min_feasibility - 0.0001 },
    { risk_score: ELIGIBILITY.max_risk + 0.0001 },
  ];

  it.each(cases)("every shared gate matches the verdict for %j", (over) => {
    const c = subject(over);
    const progress = patternGates(c);
    const verdict = evaluateEligibility(
      {
        pattern_id: c.pattern_id,
        occurrence_count: c.occurrence_count,
        distinct_day_count: c.distinct_day_count,
        similarity_mean: c.similarity_mean,
        projected_minutes_saved_weekly: c.projected_minutes_saved_weekly,
        feasibility_score: c.feasibility_score,
        risk_score: c.risk_score,
        opportunity_score: c.opportunity_score,
        excluded_from_learning: false,
        has_restricted_sensitivity: false,
        dismissed_recently: false,
        suppressed: false,
      },
      ELIGIBILITY,
      OPPORTUNITY_THRESHOLD,
    );
    for (const [gateKey, bar] of Object.entries(BAR_BY_GATE)) {
      const gate = progress.gates.find((g) => g.key === gateKey);
      expect(gate, `gate ${gateKey} missing`).toBeDefined();
      expect(gate!.met, `gate ${gateKey} disagrees with bar ${bar}`).toBe(
        verdict.bars.find((b) => b.bar === bar)!.passed,
      );
    }
  });
});
