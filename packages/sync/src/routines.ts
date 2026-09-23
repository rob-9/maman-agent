import type { Sql } from "postgres";
import {
  dismissRoutine,
  getRoutineCandidate,
  listRoutineCandidates,
  loadDetectionInputs,
  type RoutineCandidateRow,
  type UserContext,
} from "@maman/db";
import { explainWorkflowSteps } from "@maman/pattern-engine";
import { caseRefFor } from "./events.js";
import { DISMISSAL_COOLDOWN_DAYS } from "./discovery.js";
import { activeRules, stateIntent, type IntentDeps } from "./intents.js";
import { ensureRoutineAgents, routineAgentState, startRoutineAgent } from "./routine-agents.js";
import { routineRunSummary, type RoutineRunSummary } from "./routine-runs.js";
import { compileRoutine } from "./routine-spec.js";

/**
 * Found routines as the person sees and decides on them.
 *
 * Three words a person can say about a routine, and where each lives:
 * "not now" on the row, with its date, so the engine's cooldown can count;
 * "accepted" and "never" as entries in the intent store, in their words,
 * bound to the routine's signature, where they can be read and forgotten.
 * Forgetting the entry is the undo. Nothing is kept in two places.
 */

export type RoutineStepView = {
  order: number;
  observed: string;
  app: string;
  repeats: number;
  automation: "automated" | "context" | "manual";
  /** What the helper would do for this step: read it, or propose a change. Null when nothing. */
  mode: "read" | "propose_write" | "write" | null;
};

export type RoutineEvidenceView = {
  started_at: string;
  ended_at: string;
  /** The contact the run was around, by name, when they are still a contact. */
  contact_display_name: string | null;
  events: number;
};

export type RoutineView = {
  id: string;
  title: string;
  summary: string;
  status: "candidate" | "eligible";
  /** What the person said, and which intent entry says it. */
  decision: "dismissed" | "accepted" | "never" | null;
  intent_id: string | null;
  occurrence_count: number;
  distinct_day_count: number;
  first_seen_at: string;
  last_seen_at: string;
  steps: RoutineStepView[];
  evidence: RoutineEvidenceView[];
  /** The bars not yet cleared, nearest first. Empty when eligible. */
  why_not: string[];
  required_capabilities: string[];
  agent_id: string | null;
  /** What the compiled routine will do, in plain words, or why it could not be compiled. */
  plan: string[];
  compile_problem: string | null;
  /** How it has run since acceptance. Null until accepted. */
  runs: RoutineRunSummary | null;
};

const BAR_WORDS: Record<string, string> = {
  occurrences: "not seen often enough yet",
  distinct_days: "not seen on enough different days yet",
  similarity: "the runs differ too much from each other",
  projected_minutes: "too little time to be worth it",
  feasibility: "not enough of it can be done through a connector",
  risk: "too risky to do without you",
  excluded_from_learning: "some of it was marked not for learning",
  restricted_sensitivity: "some of it was too sensitive to learn from",
  dismissed_recently: "you said not now",
  suppressed: "you said never",
};

type Word = { decision: "accepted" | "never"; intent_id: string };

async function wordsBySignature(sql: Sql, ctx: UserContext): Promise<Map<string, Word>> {
  const out = new Map<string, Word>();
  for (const { id, rule } of await activeRules(sql, ctx)) {
    if (rule.kind === "routine_accepted")
      out.set(rule.signature, { decision: "accepted", intent_id: id });
    else if (rule.kind === "routine_never" && !out.has(rule.signature)) {
      out.set(rule.signature, { decision: "never", intent_id: id });
    }
  }
  return out;
}

/** "Not now" is a decision only while the cooldown runs; after that the routine is simply offered again. */
function dismissedNow(r: RoutineCandidateRow, now: Date): boolean {
  if (r.decision !== "dismissed" || !r.decided_at) return false;
  return new Date(r.decided_at).getTime() >= now.getTime() - DISMISSAL_COOLDOWN_DAYS * 86_400_000;
}

function toView(
  ctx: UserContext,
  r: RoutineCandidateRow,
  word: Word | undefined,
  contactByCase: ReadonlyMap<string, string>,
  now: Date,
  runs: RoutineRunSummary | null,
): RoutineView {
  const compiled = compileRoutine(r, ctx, now);
  const candidate = r.candidate as { canonical_sequence?: string[] };
  const naming = r.naming as { required_capabilities?: string[] };
  const verdict = r.verdict as {
    eligible?: boolean;
    surfaceable?: boolean;
    failed?: Array<{ bar: string }>;
  } | null;
  const explained = explainWorkflowSteps(candidate.canonical_sequence ?? []);
  return {
    id: r.id,
    title: r.title,
    summary: r.summary,
    status: r.status,
    decision: word ? word.decision : dismissedNow(r, now) ? "dismissed" : null,
    intent_id: word ? word.intent_id : null,
    occurrence_count: r.occurrence_count,
    distinct_day_count: r.distinct_day_count,
    first_seen_at: r.first_seen_at,
    last_seen_at: r.last_seen_at,
    steps: explained.steps.map((s) => ({
      order: s.order,
      observed: s.observed,
      app: s.app,
      repeats: s.repeats,
      automation: s.automation.kind,
      mode: s.automation.kind === "automated" ? (s.automation.steps[0]?.mode ?? null) : null,
    })),
    evidence: [...r.evidence]
      .sort((a, b) => b.started_at.localeCompare(a.started_at))
      .map((e) => ({
        started_at: e.started_at,
        ended_at: e.ended_at,
        contact_display_name: e.case_ref ? (contactByCase.get(e.case_ref) ?? null) : null,
        events: e.events,
      })),
    why_not: [
      ...(verdict?.failed ?? []).map((f) => BAR_WORDS[f.bar] ?? f.bar),
      ...(verdict?.eligible && !verdict.surfaceable ? ["not worth enough yet to offer"] : []),
    ],
    required_capabilities: naming.required_capabilities ?? [],
    agent_id: r.agent_id,
    plan: compiled.ok ? compiled.plan : [],
    compile_problem: compiled.ok ? null : compiled.detail,
    runs,
  };
}

async function runsFor(
  sql: Sql,
  ctx: UserContext,
  r: RoutineCandidateRow,
  word: Word | undefined,
): Promise<RoutineRunSummary | null> {
  return word?.decision === "accepted" && r.agent_id ? routineRunSummary(sql, ctx, r) : null;
}

async function contactsByCase(sql: Sql, ctx: UserContext): Promise<Map<string, string>> {
  const { contacts } = await loadDetectionInputs(sql, ctx);
  return new Map(contacts.map((c) => [caseRefFor(ctx.organizationId, c.address), c.display_name]));
}

export async function routineViews(
  sql: Sql,
  ctx: UserContext,
  now: Date = new Date(),
): Promise<RoutineView[]> {
  const [rows, words, byCase] = await Promise.all([
    listRoutineCandidates(sql, ctx),
    wordsBySignature(sql, ctx),
    contactsByCase(sql, ctx),
  ]);
  return Promise.all(
    rows.map(async (r) =>
      toView(
        ctx,
        r,
        words.get(r.signature),
        byCase,
        now,
        await runsFor(sql, ctx, r, words.get(r.signature)),
      ),
    ),
  );
}

export async function routineView(
  sql: Sql,
  ctx: UserContext,
  id: string,
  now: Date = new Date(),
): Promise<RoutineView | null> {
  const row = await getRoutineCandidate(sql, ctx, id);
  if (!row) return null;
  const [words, byCase] = await Promise.all([wordsBySignature(sql, ctx), contactsByCase(sql, ctx)]);
  return toView(
    ctx,
    row,
    words.get(row.signature),
    byCase,
    now,
    await runsFor(sql, ctx, row, words.get(row.signature)),
  );
}

export type RoutineWord = "dismissed" | "never" | "accepted";

/**
 * The person's word on a routine. "Accepted" is only for a routine that
 * cleared every bar: a routine still forming has not earned it, however the
 * request arrived. The sentence written to the intent store is the
 * confirmed entry the plan requires: nothing inferred becomes permanent
 * silently, and this is the moment it does.
 */
export async function decideOnRoutine(
  deps: IntentDeps & { now: () => Date },
  ctx: UserContext,
  id: string,
  word: RoutineWord,
): Promise<
  { ok: true; routine: RoutineView } | { ok: false; reason: "not_found" | "not_eligible" }
> {
  const row = await getRoutineCandidate(deps.sql, ctx, id);
  if (!row) return { ok: false, reason: "not_found" };
  if (word === "dismissed") {
    await dismissRoutine(deps.sql, ctx, id, deps.now());
  } else if (word === "never") {
    await stateIntent(
      deps,
      ctx,
      `Never offer to take this over: ${row.title}.`,
      "stated",
      { routine_id: row.id },
      { kind: "routine_never", signature: row.signature, scope: { kind: "global" } },
    );
  } else {
    if (row.status !== "eligible") return { ok: false, reason: "not_eligible" };
    await stateIntent(
      deps,
      ctx,
      `Do this for me when it comes up: ${row.title}.`,
      "inferred",
      { routine_id: row.id },
      {
        kind: "routine_accepted",
        signature: row.signature,
        routine_id: row.id,
        scope: { kind: "global" },
      },
    );
    // Compiled at once, so the card can say what it will do; the sweep is the backstop.
    await ensureRoutineAgents({ sql: deps.sql, now: deps.now }, ctx);
  }
  const view = await routineView(deps.sql, ctx, id, deps.now());
  return view ? { ok: true, routine: view } : { ok: false, reason: "not_found" };
}

/**
 * Start: shadow → supervised. Only for a routine the person accepted, whose
 * shadow runs agreed with what they did often enough. From here it produces
 * real drafts and proposals, each still theirs to approve.
 */
export async function startRoutine(
  sql: Sql,
  ctx: UserContext,
  id: string,
  now: Date,
): Promise<
  | { ok: true; routine: RoutineView }
  | { ok: false; reason: "not_found" | "not_accepted" | "not_ready" }
> {
  const view = await routineView(sql, ctx, id, now);
  if (!view) return { ok: false, reason: "not_found" };
  if (view.decision !== "accepted" || !view.agent_id) return { ok: false, reason: "not_accepted" };
  const state = await routineAgentState(sql, ctx, view.agent_id);
  if (state !== "shadow" || !view.runs?.ready_to_start) return { ok: false, reason: "not_ready" };
  await startRoutineAgent(sql, ctx, view.agent_id);
  const after = await routineView(sql, ctx, id, now);
  return after ? { ok: true, routine: after } : { ok: false, reason: "not_found" };
}
