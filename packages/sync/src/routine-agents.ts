import { createHash } from "node:crypto";
import type { Sql } from "postgres";
import { uuidv7 } from "@maman/contracts";
import {
  createPolicyVersion,
  getAgentOwned,
  getLatestPolicyVersion,
  listIntents,
  listRoutineCandidates,
  persistCompiledAgent,
  setRoutineAgent,
  updateAgentStateOwned,
  type RoutineCandidateRow,
  type UserContext,
} from "@maman/db";
import { intentRuleSchema } from "@maman/obligation-engine";
import { DEFAULT_ORG_POLICY } from "@maman/policy-engine";
import { compileRoutine } from "./routine-spec.js";

/**
 * From "accepted" to an agent. Every accepted routine without one is
 * compiled and stored as an immutable versioned spec, in state `shadow`.
 * Runs alongside the person from then on; see routine-runs.ts.
 */

export type RoutineAgentDeps = { sql: Sql; now: () => Date };

export type AcceptedRoutine = {
  routine: RoutineCandidateRow;
  intent_id: string;
  accepted_at: string;
};

/** Routines the person accepted, with when, from the intent store. */
export async function acceptedRoutines(sql: Sql, ctx: UserContext): Promise<AcceptedRoutine[]> {
  const [intents, routines] = await Promise.all([
    listIntents(sql, ctx),
    listRoutineCandidates(sql, ctx),
  ]);
  const bySignature = new Map(routines.map((r) => [r.signature, r]));
  const out: AcceptedRoutine[] = [];
  for (const i of intents) {
    const parsed = intentRuleSchema.safeParse(i.rule);
    if (!parsed.success || parsed.data.kind !== "routine_accepted") continue;
    const routine = bySignature.get(parsed.data.signature);
    if (routine && !out.some((o) => o.routine.id === routine.id)) {
      out.push({ routine, intent_id: i.id, accepted_at: i.created_at });
    }
  }
  return out;
}

/** The organization's current policy version, created from the default when there is none. */
async function ensurePolicyVersionId(sql: Sql, ctx: UserContext): Promise<string> {
  const tenant = { organizationId: ctx.organizationId };
  const latest = await getLatestPolicyVersion(sql, tenant);
  if (latest) return latest.id;
  const policy = DEFAULT_ORG_POLICY;
  const row = await createPolicyVersion(sql, tenant, {
    id: uuidv7(),
    organization_id: ctx.organizationId,
    version_number: 1,
    policy,
    sha256: createHash("sha256").update(JSON.stringify(policy)).digest("hex"),
    created_by_user_id: ctx.userId,
  });
  return row.id;
}

export type EnsureAgentsResult = {
  compiled: number;
  failed: Array<{ routine_id: string; reason: string; detail: string }>;
};

export async function ensureRoutineAgents(
  deps: RoutineAgentDeps,
  ctx: UserContext,
): Promise<EnsureAgentsResult> {
  const result: EnsureAgentsResult = { compiled: 0, failed: [] };
  const accepted = await acceptedRoutines(deps.sql, ctx);
  for (const { routine } of accepted) {
    if (routine.agent_id) continue;
    const compiled = compileRoutine(routine, ctx, deps.now());
    if (!compiled.ok) {
      result.failed.push({
        routine_id: routine.id,
        reason: compiled.reason,
        detail: compiled.detail,
      });
      continue;
    }
    const policyVersionId = await ensurePolicyVersionId(deps.sql, ctx);
    const stored = await persistCompiledAgent(
      deps.sql,
      { organizationId: ctx.organizationId, userId: ctx.userId },
      {
        spec: compiled.spec,
        spec_sha256: compiled.spec_sha256,
        policy_version_id: policyVersionId,
      },
    );
    await setRoutineAgent(deps.sql, ctx, routine.id, stored.agent_id);
    result.compiled += 1;
  }
  return result;
}

export type RoutineAgentState = "shadow" | "supervised" | "active" | "paused" | "other";

export async function routineAgentState(
  sql: Sql,
  ctx: UserContext,
  agentId: string,
): Promise<RoutineAgentState | null> {
  const row = await getAgentOwned(
    sql,
    { organizationId: ctx.organizationId, userId: ctx.userId },
    agentId,
  );
  if (!row) return null;
  return row.state === "shadow" ||
    row.state === "supervised" ||
    row.state === "active" ||
    row.state === "paused"
    ? row.state
    : "other";
}

/** shadow → supervised: the routine starts producing real drafts and proposals, each still approved by the person. */
export async function startRoutineAgent(
  sql: Sql,
  ctx: UserContext,
  agentId: string,
): Promise<boolean> {
  const row = await updateAgentStateOwned(
    sql,
    { organizationId: ctx.organizationId, userId: ctx.userId },
    agentId,
    "supervised",
  );
  return row !== null;
}
