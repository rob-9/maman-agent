import { createHash } from "node:crypto";
import { uuidv7, type AgentSpec, type AgentStep } from "@maman/contracts";
import { capabilitiesForToken, getCapability } from "@maman/capability-catalog";
import { renderPlainLanguagePlan, validateAgentSpec } from "@maman/agent-runtime";
import type { RoutineCandidateRow, UserContext } from "@maman/db";
import { diffHash } from "./actions.js";

/**
 * A found routine, compiled. Deterministic: the same routine compiles to the
 * same spec, and the spec's hash is its version. No model anywhere.
 *
 * The first step of the routine is its trigger (something arrived, a
 * meeting ended). Every later step becomes a spec step on the capability
 * the catalog names for it: a reply the person wrote becomes a draft, a CRM
 * change becomes a proposal. No step is ever compiled in `write` mode. A
 * write happens only through the action ladder the proposal enters, with
 * its own approval, read-back and receipt, or not at all.
 */

export const ROUTINE_COMPILER = "routine-deterministic";
export const ROUTINE_COMPILER_VERSION = 1;

export type CompiledRoutine =
  | { ok: true; spec: AgentSpec; spec_sha256: string; plan: string[]; trigger_token: string }
  | { ok: false; reason: "no_steps" | "manual_step" | "invalid"; detail: string };

/** A seeded id: the same routine and the same content give the same id. */
function seededId(seed: string, timestampMs: number): string {
  const bytes = createHash("sha256").update(seed).digest();
  let i = 0;
  return uuidv7({ timestampMs, random: () => bytes[i++ % bytes.length]! / 256 });
}

export function routineSequence(row: RoutineCandidateRow): string[] {
  const candidate = row.candidate as { canonical_sequence?: string[] };
  return candidate.canonical_sequence ?? [];
}

/** The routine's trigger: its first step. */
export function triggerTokenOf(row: RoutineCandidateRow): string | null {
  return routineSequence(row)[0] ?? null;
}

/** The steps a helper would take: every step after the trigger, collapsed when repeated. */
export function stepTokensOf(row: RoutineCandidateRow): string[] {
  const out: string[] = [];
  for (const t of routineSequence(row).slice(1)) if (out.at(-1) !== t) out.push(t);
  return out;
}

export function compileRoutine(
  row: RoutineCandidateRow,
  ctx: UserContext,
  now: Date,
): CompiledRoutine {
  const trigger = triggerTokenOf(row);
  const tokens = stepTokensOf(row);
  if (!trigger || tokens.length === 0) {
    return { ok: false, reason: "no_steps", detail: "a routine needs a trigger and a step" };
  }
  const [source = "", , eventType = "", , semantic = "", object = ""] = trigger.split(":");
  const steps: AgentStep[] = [];
  for (const [i, token] of tokens.entries()) {
    const capabilityId = capabilitiesForToken(token)[0];
    const capability = capabilityId ? getCapability(capabilityId) : undefined;
    if (!capabilityId || !capability) {
      return {
        ok: false,
        reason: "manual_step",
        detail: `no capability for step ${i + 2}: ${token}`,
      };
    }
    // Never "write". A proposing capability proposes; the ladder decides.
    const mode: AgentStep["mode"] = capability.supported_modes.includes("propose_write")
      ? "propose_write"
      : "read";
    steps.push({
      step_id: `s${i + 1}`,
      order: i + 1,
      name: capability.display_name,
      capability_id: capabilityId,
      capability_version: capability.version,
      mode,
      inputs: { case: { source: "agent_input", ref: "case" } },
      output_key: `step_${i + 1}`,
      risk_level: capability.risk_level,
      approval:
        mode === "read"
          ? { required: false }
          : { required: true, reason: "a change to something you own is yours to approve" },
      retry: {
        allowed: mode === "read",
        max_attempts: mode === "read" ? 2 : 0,
        backoff_seconds: [],
      },
    });
  }
  const agentId = seededId(
    `agent:${ctx.organizationId}:${ctx.userId}:${row.id}`,
    Date.parse(row.first_seen_at),
  );
  const withoutVersion: Omit<AgentSpec, "version_id" | "created_at"> = {
    schema_version: 1,
    agent_id: agentId,
    organization_id: ctx.organizationId,
    owner_user_id: ctx.userId,
    name: row.title,
    description: row.summary,
    generalized_intent: `routine:${row.signature}`,
    source_pattern_id: row.id,
    compiler: ROUTINE_COMPILER,
    compiler_version: ROUTINE_COMPILER_VERSION,
    state: "shadow",
    trigger: { type: "event", connector: source, event_name: `${eventType}:${semantic}:${object}` },
    inputs: [
      {
        key: "case",
        label: "The contact this is about",
        type: "record_reference",
        required: true,
        sensitivity: "internal",
        source: "trigger",
      },
    ],
    steps,
    assertions: [],
    budgets: {
      max_runtime_seconds: 300,
      max_model_tokens: 20_000,
      max_cost_usd: 0.5,
      max_records_read: 50,
      max_records_written: steps.filter((s) => s.mode !== "read").length,
    },
    failure_policy: {
      on_assertion_failure: "stop",
      on_tool_failure: "stop",
      max_safe_retries: 0,
      approval_timeout_minutes: 24 * 60,
    },
    created_by: "compiler",
  };
  // The version is the content: the same steps are the same version, whenever compiled.
  const spec_sha256 = diffHash(withoutVersion);
  const spec: AgentSpec = {
    ...withoutVersion,
    version_id: seededId(`version:${spec_sha256}`, Date.parse(row.first_seen_at)),
    created_at: now.toISOString(),
  };
  const valid = validateAgentSpec(spec);
  if (!valid.valid) {
    return {
      ok: false,
      reason: "invalid",
      detail: valid.issues.map((i) => `${i.rule}: ${i.message}`).join("; "),
    };
  }
  return {
    ok: true,
    spec,
    spec_sha256,
    plan: renderPlainLanguagePlan(spec),
    trigger_token: trigger,
  };
}
