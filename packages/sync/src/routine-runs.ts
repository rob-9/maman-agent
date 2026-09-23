import { createHash } from "node:crypto";
import type { Sql } from "postgres";
import { uuidv7, type WorkflowEvent } from "@maman/contracts";
import { capabilitiesForToken } from "@maman/capability-catalog";
import {
  compareShadowRun,
  promotionReadiness,
  type ProposedChange,
  type ShadowComparison,
} from "@maman/agent-runtime";
import {
  completeRoutineRun,
  createRoutineRun,
  getCurrentAgentSpec,
  listPendingObligations,
  listRoutineRuns,
  listWorkflowEvents,
  type RoutineCandidateRow,
  type RoutineRunRow,
  type UserContext,
} from "@maman/db";
import { canonicalToken, toPatternFeature } from "@maman/pattern-engine";
import type { ModelProvider } from "@maman/model-provider";
import type { ContextComposer } from "@maman/voice-engine";
import type { HttpTransport, UserCredentialProvider } from "@maman/connector-adapters";
import type { ActionDeps } from "./actions.js";
import { runDraftJob } from "./draft-job.js";
import { runOpportunityPass } from "./opportunity-pass.js";
import { acceptedRoutines, routineAgentState } from "./routine-agents.js";
import { stepTokensOf, triggerTokenOf } from "./routine-spec.js";

/**
 * RUNS OF AN ACCEPTED ROUTINE. Phase 3, step 4.
 *
 * Each time the routine's trigger happens in the person's stream after they
 * accepted it, one run is made, keyed by the trigger event. What a run does
 * depends on the agent's state:
 *
 * - shadow: nothing is produced. The run records which steps the routine
 *   would have taken, waits for the episode to close (the case gap), then
 *   records which steps the person took and compares. Three agreeing
 *   comparisons make the routine ready to start.
 * - supervised: the steps run through the jobs that already exist for them:
 *   a draft in Gmail (never sent), a proposal in the Salesforce section
 *   (never applied without approval, or under a promotion the person made).
 *   The run records what it produced. The ladder for each output is the
 *   ladder it always had.
 *
 * What is compared in shadow is WHICH steps happened, by capability, on the
 * same case: did the person reply, did they update the deal. Not the words
 * or the values; the routine does not know them and the run does not store
 * them.
 */

export type RoutineRunDeps = {
  sql: Sql;
  now: () => Date;
  contentKey: Buffer;
  /** Days of quiet on a case that close a shadow run's episode. Default 3. */
  case_gap_days?: number | undefined;
  /** Present when the sweep can draft (the agent is on). */
  drafting?:
    | { credentials: UserCredentialProvider; transport: HttpTransport; composer: ContextComposer }
    | undefined;
  /** Present when the sweep can propose CRM updates. */
  proposing?:
    | (Pick<ActionDeps, "writer" | "opportunities" | "orgPolicy"> & { provider: ModelProvider })
    | undefined;
};

export type RoutineRunResult = {
  routines: number;
  runs_created: number;
  shadow_completed: number;
  supervised_completed: number;
  skipped: number;
};

const hashId = (organizationId: string, kind: string, id: string): string =>
  createHash("sha256").update(`${organizationId}:${kind}:${id}`).digest("hex").slice(0, 32);

/** A step, as a change: the capability that would do it, on this case. Values are not known here. */
function changeFor(caseRef: string, capabilityId: string): ProposedChange {
  return {
    object_ref: caseRef,
    field: capabilityId,
    proposed_value_hash: createHash("sha256").update(capabilityId).digest("hex").slice(0, 32),
  };
}

function eventToken(e: WorkflowEvent): string {
  return canonicalToken(toPatternFeature(e));
}

function capabilityOf(token: string): string | null {
  return capabilitiesForToken(token)[0] ?? null;
}

/** What the routine would do on a case: one change per distinct capability among its steps. */
export function proposedChanges(routine: RoutineCandidateRow, caseRef: string): ProposedChange[] {
  const out = new Map<string, ProposedChange>();
  for (const t of stepTokensOf(routine)) {
    const c = capabilityOf(t);
    if (c && !out.has(c)) out.set(c, changeFor(caseRef, c));
  }
  return [...out.values()];
}

/** What the person did on the case after the trigger: the same mapping, from their events. */
export function actualChanges(
  events: readonly WorkflowEvent[],
  caseRef: string,
  after: string,
  until: string,
): ProposedChange[] {
  const out = new Map<string, ProposedChange>();
  for (const e of events) {
    if (e.source === "product") continue;
    if (e.target.stable_id_hash !== caseRef) continue;
    if (e.occurred_at <= after || e.occurred_at > until) continue;
    const c = capabilityOf(eventToken(e));
    if (c && !out.has(c)) out.set(c, changeFor(caseRef, c));
  }
  return [...out.values()];
}

export async function runRoutines(
  deps: RoutineRunDeps,
  ctx: UserContext,
): Promise<RoutineRunResult> {
  const result: RoutineRunResult = {
    routines: 0,
    runs_created: 0,
    shadow_completed: 0,
    supervised_completed: 0,
    skipped: 0,
  };
  const now = deps.now();
  const gapMs = (deps.case_gap_days ?? 3) * 86_400_000;
  const accepted = (await acceptedRoutines(deps.sql, ctx)).filter((a) => a.routine.agent_id);
  if (accepted.length === 0) return result;
  const earliest = accepted.map((a) => a.accepted_at).sort()[0]!;
  const events = await listWorkflowEvents(deps.sql, ctx, {
    since: new Date(Date.parse(earliest) - gapMs),
  });
  const tenant = { organizationId: ctx.organizationId, userId: ctx.userId };

  for (const { routine, accepted_at } of accepted) {
    const agentId = routine.agent_id!;
    const [state, current] = await Promise.all([
      routineAgentState(deps.sql, ctx, agentId),
      getCurrentAgentSpec(deps.sql, tenant, agentId),
    ]);
    if (!current || (state !== "shadow" && state !== "supervised")) continue;
    result.routines += 1;
    const trigger = triggerTokenOf(routine);
    if (!trigger) continue;

    // 1. New triggers since acceptance become runs, one per trigger event.
    const triggers = events.filter(
      (e) =>
        e.source !== "product" &&
        e.occurred_at >= accepted_at &&
        e.target.stable_id_hash !== undefined &&
        eventToken(e) === trigger,
    );
    for (const t of triggers) {
      const caseRef = t.target.stable_id_hash!;
      const created = await createRoutineRun(deps.sql, ctx, {
        id: uuidv7({ timestampMs: now.getTime() }),
        routine_id: routine.id,
        agent_id: agentId,
        agent_version_id: current.agent_version_id,
        trigger_event_id: t.event_id,
        triggered_at: t.occurred_at,
        case_ref: caseRef,
        mode: state,
        status: "watching",
        proposed: proposedChanges(routine, caseRef),
      });
      if (!created) continue;
      result.runs_created += 1;
      if (state === "supervised") {
        const done = await superviseRun(deps, ctx, routine, created, t);
        if (done === "completed") result.supervised_completed += 1;
        else result.skipped += 1;
      }
    }

    // 2. Shadow runs whose episode has closed are compared and completed.
    const watching = await listRoutineRuns(deps.sql, ctx, {
      routine_id: routine.id,
      status: "watching",
    });
    for (const run of watching) {
      if (run.mode !== "shadow" || !run.case_ref) continue;
      const closesAt = Date.parse(run.triggered_at) + gapMs;
      const until = new Date(Math.min(closesAt, now.getTime())).toISOString();
      const actual = actualChanges(events, run.case_ref, run.triggered_at, until);
      const proposed = run.proposed as ProposedChange[];
      const allSeen = proposed.every((p) => actual.some((a) => a.field === p.field));
      if (now.getTime() < closesAt && !allSeen) continue;
      const comparison = compareShadowRun(run.id, proposed, actual);
      const row = await completeRoutineRun(deps.sql, ctx, run.id, {
        status: "completed",
        actual,
        comparison,
        completed_at: now.toISOString(),
      });
      if (row) result.shadow_completed += 1;
    }
  }
  return result;
}

/**
 * A supervised run: the routine's steps through the jobs that exist for
 * them, on the thread the trigger was about. Reads have nothing to produce.
 * A step with no job yet is recorded as not run, never faked.
 */
async function superviseRun(
  deps: RoutineRunDeps,
  ctx: UserContext,
  routine: RoutineCandidateRow,
  run: RoutineRunRow,
  trigger: WorkflowEvent,
): Promise<"completed" | "skipped"> {
  const now = deps.now();
  const outputs: Record<string, unknown> = {};
  const notes: string[] = [];
  // The thread the trigger names, found by the same hash the stream wrote.
  const pending = await listPendingObligations(deps.sql, ctx, 200, { agent: false });
  const target = pending.find(
    (o) =>
      hashId(ctx.organizationId, "thread", o.thread_external_id) === trigger.context.record_id_hash,
  );
  for (const token of stepTokensOf(routine)) {
    const capability = capabilityOf(token);
    if (!capability) continue;
    if (capability === "gmail.create_draft") {
      if (!deps.drafting) notes.push("draft: drafting is off");
      else if (!target) notes.push("draft: no open item on that thread");
      else {
        const r = await runDraftJob(
          { ...deps.drafting, sql: deps.sql, contentKey: deps.contentKey, now: deps.now },
          ctx,
          target.id,
          "auto",
        );
        outputs["draft"] = r.ok
          ? { draft_id: r.draft_id, obligation_id: target.id }
          : { reason: r.reason };
      }
    } else if (capability === "salesforce.propose_field_updates") {
      if (!deps.proposing) notes.push("crm: proposing is off");
      else if (!target) notes.push("crm: no open item on that thread");
      else {
        const r = await runOpportunityPass(
          {
            ...deps.proposing,
            sql: deps.sql,
            contentKey: deps.contentKey,
            now: deps.now,
            only_thread_id: target.thread_id,
            max_candidates: 50,
          },
          ctx,
        );
        outputs["crm"] = r;
      }
    }
    // Reads (a thread that arrived, a meeting that happened) have nothing to produce.
  }
  const produced = Object.keys(outputs).length > 0;
  await completeRoutineRun(deps.sql, ctx, run.id, {
    status: produced ? "completed" : "skipped",
    outputs,
    detail: notes.length > 0 ? notes.join("; ") : null,
    completed_at: now.toISOString(),
  });
  return produced ? "completed" : "skipped";
}

export type RoutineRunSummary = {
  mode: "shadow" | "supervised" | null;
  shadow_completed: number;
  shadow_successful: number;
  required: number;
  ready_to_start: boolean;
  latest_agreement: number | null;
  supervised_completed: number;
  recent: Array<{
    triggered_at: string;
    mode: "shadow" | "supervised";
    status: RoutineRunRow["status"];
    agreement: number | null;
    missing_rules: string[];
    case_ref: string | null;
  }>;
};

export async function routineRunSummary(
  sql: Sql,
  ctx: UserContext,
  routine: RoutineCandidateRow,
): Promise<RoutineRunSummary> {
  const state = routine.agent_id ? await routineAgentState(sql, ctx, routine.agent_id) : null;
  const runs = await listRoutineRuns(sql, ctx, { routine_id: routine.id });
  const comparisons = runs
    .filter((r) => r.mode === "shadow" && r.status === "completed" && r.comparison)
    .map((r) => r.comparison as ShadowComparison)
    .reverse();
  const readiness = promotionReadiness(comparisons);
  return {
    mode: state === "shadow" || state === "supervised" ? state : null,
    shadow_completed: comparisons.length,
    shadow_successful: readiness.successful_comparisons,
    required: readiness.required_comparisons,
    ready_to_start: state === "shadow" && readiness.ready,
    latest_agreement: readiness.latest_agreement,
    supervised_completed: runs.filter((r) => r.mode === "supervised" && r.status === "completed")
      .length,
    recent: runs.slice(0, 5).map((r) => ({
      triggered_at: r.triggered_at,
      mode: r.mode,
      status: r.status,
      agreement: (r.comparison as ShadowComparison | null)?.agreement ?? null,
      missing_rules: (r.comparison as ShadowComparison | null)?.missing_rules ?? [],
      case_ref: r.case_ref,
    })),
  };
}
