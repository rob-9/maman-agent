import type { Sql } from "postgres";
import {
  createIntent,
  listIntents,
  listSkippedObligations,
  loadDetectionInputs,
  retireIntent,
  type IntentRow,
  type UserContext,
} from "@maman/db";
import {
  intentRuleSchema,
  parseIntentRule,
  resolveScope,
  type ContactRef,
  type IntentRule,
  type IntentRuleRecord,
  type IntentScope,
} from "@maman/obligation-engine";
import { decryptBody, encryptBody } from "./content.js";

/**
 * THE INTENT STORE, from the outside.
 *
 * Capture: a sentence the person stated, or one the product writes down
 * because of what they did. Each is encrypted to the person and kept with
 * its scope (resolved against their own contacts) and, when it is a rule,
 * its enforceable form beside it. Retrieval: the entries that bear on one
 * contact, account or situation, most specific first, decrypted, bounded,
 * for the model; the rules alone, undecrypted, for detection.
 */

export type IntentDeps = { sql: Sql; contentKey: Buffer };

export type IntentView = {
  id: string;
  text: string;
  source: IntentRow["source"];
  scope: IntentScope;
  is_rule: boolean;
  created_at: string;
};

const MAX_TEXT = 300;

async function contactRefs(deps: IntentDeps, ctx: UserContext): Promise<ContactRef[]> {
  const inputs = await loadDetectionInputs(deps.sql, ctx);
  return inputs.contacts.map((c) => ({
    address: c.address,
    display_name: c.display_name,
    account_name: c.account_name ?? null,
  }));
}

/** What the person said, in their words. Scope and rule are worked out here, once. */
export async function stateIntent(
  deps: IntentDeps,
  ctx: UserContext,
  text: string,
  source: IntentRow["source"] = "stated",
  origin?: unknown,
): Promise<IntentView> {
  const clean = text.replace(/\s+/g, " ").trim().slice(0, MAX_TEXT);
  if (clean.length === 0) throw new Error("intent text is empty");
  const contacts = await contactRefs(deps, ctx);
  const rule = parseIntentRule(clean, contacts);
  const scope: IntentScope = rule ? rule.scope : resolveScope(clean, contacts);
  const { id } = await createIntent(deps.sql, ctx, {
    text_ciphertext: encryptBody(clean, deps.contentKey, ctx),
    text_chars: clean.length,
    source,
    scope_kind: scope.kind,
    scope_value: scope.value ?? null,
    rule,
    origin,
  });
  return {
    id,
    text: clean,
    source,
    scope,
    is_rule: rule !== null,
    created_at: new Date().toISOString(),
  };
}

/** Everything active, decrypted, newest first: the page the person reads. */
export async function listIntentViews(deps: IntentDeps, ctx: UserContext): Promise<IntentView[]> {
  const rows = await listIntents(deps.sql, ctx);
  return rows.map((r) => ({
    id: r.id,
    text: decryptBody(r.text_ciphertext, deps.contentKey, ctx),
    source: r.source,
    scope: { kind: r.scope_kind, ...(r.scope_value ? { value: r.scope_value } : {}) },
    is_rule: r.rule !== null,
    created_at: r.created_at,
  }));
}

export async function forgetIntent(
  deps: IntentDeps,
  ctx: UserContext,
  id: string,
): Promise<boolean> {
  return retireIntent(deps.sql, ctx, id);
}

/** The rules, in their enforceable form, without decrypting a word. */
export async function activeRules(sql: Sql, ctx: UserContext): Promise<IntentRuleRecord[]> {
  const rows = await listIntents(sql, ctx);
  const out: IntentRuleRecord[] = [];
  for (const r of rows) {
    if (r.rule === null) continue;
    const parsed = intentRuleSchema.safeParse(r.rule);
    if (parsed.success) out.push({ id: r.id, rule: parsed.data as IntentRule });
  }
  return out;
}

const SPECIFICITY: Record<IntentScope["kind"], number> = {
  contact: 0,
  account: 1,
  situation: 2,
  global: 3,
};

/**
 * The sentences that bear on one obligation, most specific first, bounded.
 * These go to the model as the person's own instructions.
 */
export async function intentsFor(
  deps: IntentDeps,
  ctx: UserContext,
  target: { contact_address: string; account_name: string | null; kind: string },
  limit = 12,
): Promise<string[]> {
  const rows = await listIntents(deps.sql, ctx);
  const relevant = rows.filter((r) => {
    switch (r.scope_kind) {
      case "global":
        return true;
      case "contact":
        return r.scope_value === target.contact_address;
      case "account":
        return r.scope_value !== null && r.scope_value === target.account_name;
      case "situation":
        return r.scope_value === target.kind;
    }
  });
  relevant.sort(
    (a, b) =>
      SPECIFICITY[a.scope_kind] - SPECIFICITY[b.scope_kind] ||
      b.created_at.localeCompare(a.created_at),
  );
  return relevant
    .slice(0, limit)
    .map((r) => decryptBody(r.text_ciphertext, deps.contentKey, ctx).slice(0, MAX_TEXT));
}

/** What was set aside and why, in the person's own words. */
export async function skippedWithReasons(
  deps: IntentDeps,
  ctx: UserContext,
): Promise<
  Array<{
    id: string;
    subject: string;
    contact_display_name: string;
    kind: string;
    intent_text: string | null;
  }>
> {
  const [skipped, intents] = await Promise.all([
    listSkippedObligations(deps.sql, ctx),
    listIntents(deps.sql, ctx),
  ]);
  const byId = new Map(intents.map((i) => [i.id, i]));
  return skipped.map((s) => {
    const intent = s.applied_intent_id ? byId.get(s.applied_intent_id) : undefined;
    return {
      id: s.id,
      subject: s.subject,
      contact_display_name: s.contact_display_name,
      kind: s.kind,
      intent_text: intent ? decryptBody(intent.text_ciphertext, deps.contentKey, ctx) : null,
    };
  });
}
