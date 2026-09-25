import type { Sql } from "postgres";
import {
  createIntent,
  listCorrections,
  listDecidedObligations,
  listIntents,
  type UserContext,
} from "@maman/db";
import {
  inferFromCorrections,
  inferIntents,
  intentRuleSchema,
  type IntentRule,
} from "@maman/obligation-engine";
import { encryptBody } from "./content.js";

/**
 * THE THIRD KIND OF INTENT: inferred from what the person did, held as a
 * proposal until they keep it. Runs in the sweep over their decisions (what
 * they set aside, snoozed, drafted, resolved, and how old each item was),
 * proposes at most what the rules in the engine support, and never proposes
 * the same rule twice: an entry the person declined stays declined.
 */

export type InferenceDeps = { sql: Sql; contentKey: Buffer; now: () => Date };

export type InferenceResult = { decisions: number; corrections: number; proposed: number };

/** Decisions older than this are not evidence of how the person works now. */
export const INFERENCE_WINDOW_DAYS = 90;

export async function runInference(
  deps: InferenceDeps,
  ctx: UserContext,
): Promise<InferenceResult> {
  const since = new Date(deps.now().getTime() - INFERENCE_WINDOW_DAYS * 86_400_000);
  const [decisions, corrections, intents] = await Promise.all([
    listDecidedObligations(deps.sql, ctx, { since }),
    listCorrections(deps.sql, ctx, { since }),
    listIntents(deps.sql, ctx, { status: "all", limit: 500 }),
  ]);
  const existing: IntentRule[] = [];
  for (const i of intents) {
    const parsed = intentRuleSchema.safeParse(i.rule);
    if (parsed.success) existing.push(parsed.data);
  }
  const inferred = inferIntents(
    decisions.map((d) => ({
      kind: d.kind,
      outcome: d.outcome,
      days_elapsed: d.days_elapsed,
      contact: {
        address: d.contact_address,
        display_name: d.contact_display_name,
        account_name: d.contact_account_name,
      },
    })),
    existing,
  );
  // What the person changed in what the agent produced: drafts, fields, steps.
  const fromCorrections = inferFromCorrections(
    corrections.map((c) => ({
      kind: c.kind,
      signals: c.signals,
      summary: (c.summary ?? {}) as { words_actual?: number } & Record<string, unknown>,
    })),
    existing,
  );
  for (const i of [...inferred, ...fromCorrections]) {
    await createIntent(deps.sql, ctx, {
      text_ciphertext: encryptBody(i.text, deps.contentKey, ctx),
      text_chars: i.text.length,
      source: "inferred",
      status: "proposed",
      scope_kind: i.rule.scope.kind,
      scope_value: i.rule.scope.value ?? null,
      rule: i.rule,
      origin: { evidence: i.evidence },
    });
  }
  return {
    decisions: decisions.length,
    corrections: corrections.length,
    proposed: inferred.length + fromCorrections.length,
  };
}
