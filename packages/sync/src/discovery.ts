import { createHash } from "node:crypto";
import type { Sql } from "postgres";
import { uuidv7 } from "@maman/contracts";
import {
  listWorkflowEvents,
  recentlyDismissedRoutines,
  upsertRoutineCandidates,
  type RoutineCandidateInput,
  type UserContext,
} from "@maman/db";
import { activeRules } from "./intents.js";
import {
  ELIGIBILITY,
  OPPORTUNITY_THRESHOLD,
  deterministicName,
  patternSignature,
  runPatternEngine,
  segmentByCase,
  toPatternFeature,
  type CaseSegmentationOptions,
} from "@maman/pattern-engine";

/**
 * DISCOVERY. Phase 3, step 2.
 *
 * The pattern engine over the person's event stream: what they did, around
 * whom, in what order, how often. Episodes are segmented by case (the
 * contact) and by days of quiet, not by minutes on a screen, because that is
 * how a mailbox and a CRM look. Everything after segmentation is the engine
 * as it was: clustering, scores, the bars, the verdict that says why not.
 *
 * What comes out is a row per routine shape with the engine's word
 * (forming or eligible) beside the person's (not now, never, accepted).
 * Deterministic; no model anywhere in this step. The person's clicks on the
 * agent's own proposals are left out of the features: they are the ladder,
 * not steps of their routine.
 */

export type DiscoveryDeps = { sql: Sql; now: () => Date };

export type DiscoveryOptions = {
  /** How far back the stream is read. Default 90 days. */
  window_days?: number | undefined;
  /** Days of quiet on a contact that close an episode. Default 3. */
  case_gap_days?: number | undefined;
};

export type DiscoveryResult = {
  events: number;
  episodes: number;
  candidates: number;
  eligible: number;
  written: number;
};

/** A routine row id: the engine's pattern id, made this person's. */
export function routineRowId(ctx: UserContext, patternId: string): string {
  const bytes = createHash("sha256")
    .update(`routine:${ctx.organizationId}:${ctx.userId}:${patternId}`)
    .digest();
  let i = 0;
  return uuidv7({
    timestampMs: Number.parseInt(patternId.replace(/-/g, "").slice(0, 12), 16),
    random: () => bytes[i++ % bytes.length]! / 256,
  });
}

/** Dismissals hold this long before the same routine may be offered again. */
export const DISMISSAL_COOLDOWN_DAYS = ELIGIBILITY.dismissal_cooldown_days;

/**
 * The engine's ranking bar, less the weight of the one term a connector
 * stream cannot measure. A quarter of the opportunity score is projected
 * time, estimated from seconds of screen activity; connector events are
 * hours apart and carry no such thing, so that term is near zero for every
 * routine here. This is the same bar on the terms that exist. The safety
 * bars are untouched and not tunable.
 */
export const CONNECTOR_OPPORTUNITY_THRESHOLD =
  Math.round((OPPORTUNITY_THRESHOLD - 0.25) * 100) / 100;

export async function runDiscoveryStep(
  deps: DiscoveryDeps,
  ctx: UserContext,
  opts: DiscoveryOptions = {},
): Promise<DiscoveryResult> {
  const now = deps.now();
  const since = new Date(now.getTime() - (opts.window_days ?? 90) * 86_400_000);
  const events = await listWorkflowEvents(deps.sql, ctx, { since });
  const features = events.filter((e) => e.source !== "product").map((e) => toPatternFeature(e));
  // "Not now" is kept on the row with its date; "never" is an entry in the
  // intent store, so forgetting it there is what lifts it here.
  const [recentlyDismissed, rules] = await Promise.all([
    recentlyDismissedRoutines(deps.sql, ctx, now, DISMISSAL_COOLDOWN_DAYS),
    activeRules(deps.sql, ctx),
  ]);
  const suppressed = rules
    .flatMap(({ rule }) => (rule.kind === "routine_never" ? [rule.signature] : []))
    .sort();
  const segmentation: CaseSegmentationOptions = {
    case_gap_boundary_ms: (opts.case_gap_days ?? 3) * 86_400_000,
  };
  const result = runPatternEngine(features, {
    owner_user_id: ctx.userId,
    now: deps.now,
    segment: (evs) => segmentByCase(evs, segmentation),
    recently_dismissed_signatures: recentlyDismissed,
    suppressed_signatures: suppressed,
    // Minutes saved is estimated from event spacing here, not measured from a
    // screen, so it is not a bar. Occurrences and distinct days are, and the
    // safety bars (similarity, feasibility, risk) are not tunable at all.
    eligibility: { min_projected_minutes_weekly: 0 },
    opportunity_threshold: CONNECTOR_OPPORTUNITY_THRESHOLD,
  });
  const episodesById = new Map(result.episodes.map((e) => [e.episode_id, e]));
  const rows: RoutineCandidateInput[] = result.candidates.map((c) => {
    const members = c.episode_ids.map((id) => episodesById.get(id)!).filter(Boolean);
    const naming = deterministicName(c, members);
    const verdict = result.verdicts.find((v) => v.pattern_id === c.pattern_id) ?? null;
    return {
      // The engine's id is a function of the shape and the first day; two
      // people with the same habit would collide. The row is theirs.
      id: routineRowId(ctx, c.pattern_id),
      signature: patternSignature(c.canonical_sequence),
      status: c.status === "eligible" ? "eligible" : "candidate",
      title: naming.title,
      summary: naming.summary,
      occurrence_count: c.occurrence_count,
      distinct_day_count: c.distinct_day_count,
      first_seen_at: c.first_seen_at,
      last_seen_at: c.last_seen_at,
      candidate: c,
      naming,
      verdict,
      evidence: members.map((m) => ({
        started_at: m.started_at,
        ended_at: m.ended_at,
        case_ref: m.events[0]?.case_ref ?? null,
        events: m.events.length,
      })),
    };
  });
  const written = await upsertRoutineCandidates(deps.sql, ctx, rows, now);
  return {
    events: features.length,
    episodes: result.episodes.length,
    candidates: rows.length,
    eligible: rows.filter((r) => r.status === "eligible").length,
    written: written.written,
  };
}
