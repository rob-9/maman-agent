import type { EligibilityThresholds } from "./scoring.js";

/**
 * WHY A CANDIDATE DID NOT SURFACE.
 *
 * `runPatternEngine` decided eligibility with one long `&&` chain, so a
 * rejected pattern produced a boolean and nothing else. The cost of that is on
 * record: 10,419 observed events became 438 episodes, 58 candidates and ZERO
 * eligible ones, "with no surface anywhere saying why" — the bars were doing
 * their job and there was no way to learn which one, or by how much.
 *
 * That is the question tuning actually asks. Feasibility being 0.59 against a
 * 0.60 floor and occurrence_count being 1 against a floor of 3 are both "not
 * eligible", and they call for opposite responses: one is a capability-mapping
 * gap, the other is a person who has not repeated themselves yet.
 *
 * This module is the single source of truth for that decision. `engine.ts`
 * derives its boolean from `verdict.eligible` rather than keeping a parallel
 * chain, so the explanation can never drift from the behaviour it explains —
 * the failure mode that makes diagnostics worse than none.
 *
 * DELIBERATELY NOT ON `PatternCandidate`. That type is a wire contract with a
 * sync projection that rejects unknown fields, and a verdict is local
 * diagnostic detail with no business on the server. It travels beside the
 * candidate, keyed by `pattern_id`, and stays on the device.
 */

/** Every gate a pattern must clear, named. */
export type BarName =
  | "occurrences"
  | "distinct_days"
  | "similarity"
  | "projected_minutes"
  | "feasibility"
  | "risk"
  | "excluded_from_learning"
  | "restricted_sensitivity"
  | "dismissed_recently"
  | "suppressed";

/**
 * The SAFETY bars, which `effectiveEligibility` refuses to let callers relax.
 * Surfaced here so a report can say "you cannot tune your way past this one"
 * instead of inviting someone to try.
 */
export const UNTUNABLE_BARS: ReadonlySet<BarName> = new Set<BarName>([
  "similarity",
  "feasibility",
  "risk",
  "excluded_from_learning",
  "restricted_sensitivity",
]);

export type BarResult = {
  bar: BarName;
  passed: boolean;
  /**
   * Observed value, and the value it needed to reach. `null` on the boolean
   * bars (suppressed, excluded…), where "how far short" is meaningless.
   */
  actual: number | null;
  required: number | null;
  /**
   * Distance from passing in the bar's OWN units, non-negative, `0` when
   * passed. A max-bar (risk) reports how far over it sits; a min-bar how far
   * under. Good for display — "needs 1 more occurrence" — and useless for
   * comparison, which is what `relative_shortfall` is for.
   */
  shortfall: number | null;
  /**
   * `shortfall / required` — the same distance as a FRACTION of what was
   * demanded, so bars in different units can be ranked against each other.
   *
   * Sorting on the raw shortfall looked right and was not: being one
   * occurrence short of three (a third of the way off) sorted as "further"
   * than being 0.5 short of a 0.6 feasibility floor (83% of the way off),
   * because 1 > 0.5. That ranking points at the wrong bar whenever the units
   * differ, which is most of the time.
   */
  relative_shortfall: number | null;
  /** False for the safety bars — see UNTUNABLE_BARS. */
  tunable: boolean;
};

export type EligibilityVerdict = {
  pattern_id: string;
  eligible: boolean;
  /** Eligible AND past the opportunity ranking threshold. */
  surfaceable: boolean;
  opportunity_score: number;
  opportunity_threshold: number;
  /** Every bar, in evaluation order, passed or not. */
  bars: BarResult[];
  /** Only the failures, nearest-to-passing first. */
  failed: BarResult[];
};

export type EligibilityInput = {
  pattern_id: string;
  occurrence_count: number;
  distinct_day_count: number;
  similarity_mean: number;
  projected_minutes_saved_weekly: number;
  feasibility_score: number;
  risk_score: number;
  opportunity_score: number;
  excluded_from_learning: boolean;
  has_restricted_sensitivity: boolean;
  dismissed_recently: boolean;
  suppressed: boolean;
};

/** `required` of 0 cannot be missed by a proportion; report the gap as total. */
function relative(shortfall: number, required: number): number {
  if (shortfall === 0) return 0;
  return required === 0 ? 1 : round4(shortfall / required);
}

function minBar(bar: BarName, actual: number, required: number, tunable: boolean): BarResult {
  const passed = actual >= required;
  const shortfall = passed ? 0 : round4(required - actual);
  return {
    bar,
    passed,
    actual,
    required,
    shortfall,
    relative_shortfall: relative(shortfall, required),
    tunable,
  };
}

function maxBar(bar: BarName, actual: number, required: number): BarResult {
  const passed = actual <= required;
  const shortfall = passed ? 0 : round4(actual - required);
  return {
    bar,
    passed,
    actual,
    required,
    shortfall,
    relative_shortfall: relative(shortfall, required),
    tunable: false,
  };
}

/** A bar with no magnitude: it either applies or it does not. */
function flagBar(bar: BarName, blocked: boolean, tunable: boolean): BarResult {
  return {
    bar,
    passed: !blocked,
    actual: null,
    required: null,
    shortfall: null,
    relative_shortfall: null,
    tunable,
  };
}

function round4(n: number): number {
  return Math.round(n * 10_000) / 10_000;
}

/**
 * Evaluates every bar and reports all of them — it does NOT short-circuit.
 *
 * A chain that stops at the first failure answers "why not" with one reason
 * when there are four, which sends someone to fix a bar that was never the
 * binding constraint. Knowing a pattern misses on occurrences AND similarity
 * is what tells you that more repetitions alone will not help it.
 */
export function evaluateEligibility(
  input: EligibilityInput,
  thresholds: EligibilityThresholds,
  opportunityThreshold: number,
): EligibilityVerdict {
  const bars: BarResult[] = [
    minBar("occurrences", input.occurrence_count, thresholds.min_occurrences, true),
    minBar("distinct_days", input.distinct_day_count, thresholds.min_distinct_days, true),
    minBar("similarity", input.similarity_mean, thresholds.min_similarity_mean, false),
    minBar(
      "projected_minutes",
      input.projected_minutes_saved_weekly,
      thresholds.min_projected_minutes_weekly,
      true,
    ),
    minBar("feasibility", input.feasibility_score, thresholds.min_feasibility, false),
    maxBar("risk", input.risk_score, thresholds.max_risk),
    flagBar("excluded_from_learning", input.excluded_from_learning, false),
    flagBar("restricted_sensitivity", input.has_restricted_sensitivity, false),
    flagBar("dismissed_recently", input.dismissed_recently, true),
    flagBar("suppressed", input.suppressed, true),
  ];

  const eligible = bars.every((b) => b.passed);
  const surfaceable = eligible && input.opportunity_score >= opportunityThreshold;

  // Nearest-to-passing first, so the top of the list is the cheapest thing to
  // move. Flag bars have no magnitude and sort last: "the user said never" is
  // not a near miss.
  const failed = bars
    .filter((b) => !b.passed)
    .sort((a, b) => (a.relative_shortfall ?? Infinity) - (b.relative_shortfall ?? Infinity));

  return {
    pattern_id: input.pattern_id,
    eligible,
    surfaceable,
    opportunity_score: input.opportunity_score,
    opportunity_threshold: opportunityThreshold,
    bars,
    failed,
  };
}

/** One bar's tally across every candidate. */
export type BarTally = {
  bar: BarName;
  /** How many candidates this bar rejected. */
  blocked: number;
  /**
   * How many it was the ONLY thing rejecting — the number that matters.
   * A bar blocking 40 candidates it shares with another bar buys nothing when
   * fixed; a bar that is 12 candidates' sole obstacle buys 12.
   */
  sole_blocker: number;
  /** Median distance from passing among the candidates it blocked. */
  median_shortfall: number | null;
  tunable: boolean;
};

export type EligibilitySummary = {
  candidates: number;
  eligible: number;
  surfaceable: number;
  /** Most-blocking first, then by sole-blocker count. */
  tallies: BarTally[];
};

/**
 * Aggregates verdicts into "which bar is actually costing you suggestions".
 *
 * `sole_blocker` is the load-bearing column. Ranking by raw block count points
 * at whichever bar is strictest in general, which on a thin history is always
 * the volume bars — and "wait longer" is not a finding.
 */
export function summarizeEligibility(verdicts: readonly EligibilityVerdict[]): EligibilitySummary {
  const names = new Set<BarName>();
  for (const v of verdicts) for (const b of v.bars) names.add(b.bar);

  const tallies: BarTally[] = [...names].map((bar) => {
    const blocking = verdicts.filter((v) => v.bars.some((b) => b.bar === bar && !b.passed));
    const sole = blocking.filter((v) => v.failed.length === 1).length;
    const shortfalls = blocking
      .map((v) => v.bars.find((b) => b.bar === bar)?.shortfall)
      .filter((s): s is number => s !== null && s !== undefined)
      .sort((a, b) => a - b);
    const mid = Math.floor(shortfalls.length / 2);
    const median =
      shortfalls.length === 0
        ? null
        : shortfalls.length % 2 === 0
          ? round4(((shortfalls[mid - 1] ?? 0) + (shortfalls[mid] ?? 0)) / 2)
          : (shortfalls[mid] ?? null);
    return {
      bar,
      blocked: blocking.length,
      sole_blocker: sole,
      median_shortfall: median,
      tunable: !UNTUNABLE_BARS.has(bar),
    };
  });

  tallies.sort((a, b) => b.sole_blocker - a.sole_blocker || b.blocked - a.blocked);

  return {
    candidates: verdicts.length,
    eligible: verdicts.filter((v) => v.eligible).length,
    surfaceable: verdicts.filter((v) => v.surfaceable).length,
    tallies,
  };
}
