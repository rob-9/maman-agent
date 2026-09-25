import { z } from "zod";
import type { Obligation, ObligationKind, Thread } from "./types.js";

/**
 * INTENT AS A RULE. Deterministic, like the rest of this package.
 *
 * A person says "don't chase Acme" or "never follow up more than twice".
 * Those are rules, and rules are enforced here, in detection, not by asking
 * a model to remember. Everything a sentence says that is not a rule stays a
 * sentence, and goes to the model as the person's own instruction.
 *
 * Scope is resolved against the person's own contacts: a name or address or
 * account mentioned in the sentence narrows it; nothing mentioned means it
 * applies everywhere.
 */

export const intentScopeSchema = z
  .object({
    kind: z.enum(["global", "contact", "account", "situation"]),
    /** contact: the address; account: the account name; situation: the obligation kind. */
    value: z.string().optional(),
  })
  .strict();
export type IntentScope = z.infer<typeof intentScopeSchema>;

export const intentRuleSchema = z.discriminatedUnion("kind", [
  /** Do not chase (awaiting_them, unsent_followup). A reply owed is still owed. */
  z.object({ kind: z.literal("no_chase"), scope: intentScopeSchema }).strict(),
  /** Do not write drafts before being asked. Clicking still works. */
  z.object({ kind: z.literal("no_predraft"), scope: intentScopeSchema }).strict(),
  /**
   * A promotion: run this kind of write without asking. Made by the person,
   * bound to the shape of the write it covers (kind + field names).
   */
  z
    .object({
      kind: z.literal("auto_action"),
      action_kind: z.string().min(1),
      shape_sha256: z.string().min(1),
      scope: intentScopeSchema,
    })
    .strict(),
  /** Stop chasing after N unanswered messages in a row. */
  z
    .object({
      kind: z.literal("max_chases"),
      max: z.number().int().min(1).max(20),
      scope: intentScopeSchema,
    })
    .strict(),
  /**
   * A routine the agent found and the person accepted: "do this for me".
   * Bound to the routine's signature (its step sequence), so it covers that
   * shape and no other. Forgetting the entry withdraws the acceptance.
   */
  z
    .object({
      kind: z.literal("routine_accepted"),
      signature: z.string().min(1),
      routine_id: z.string().min(1),
      scope: intentScopeSchema,
    })
    .strict(),
  /** "Never offer this routine." Forgetting the entry lets it be offered again. */
  z
    .object({
      kind: z.literal("routine_never"),
      signature: z.string().min(1),
      scope: intentScopeSchema,
    })
    .strict(),

  /** Leave a thread alone this long before calling it "gone quiet". */
  z
    .object({
      kind: z.literal("chase_after_days"),
      days: z.number().int().min(1).max(30),
      scope: intentScopeSchema,
    })
    .strict(),

  /**
   * How the person writes, learned from what they sent: length, greeting,
   * sign-off, opener. Not enforced by detection; the sentence goes to the
   * writer as the person's own instruction. The rule is here so the same
   * thing is never proposed twice.
   */
  z
    .object({
      kind: z.literal("style"),
      key: z.enum(["length", "greeting", "signoff", "opener"]),
      value: z.string().min(1).max(80),
      scope: intentScopeSchema,
    })
    .strict(),
  /** Do not propose changes to this CRM field. Enforced where proposals are made. */
  z
    .object({
      kind: z.literal("skip_field"),
      field: z.enum(["next_step", "close_date"]),
      scope: intentScopeSchema,
    })
    .strict(),
]);
export type IntentRule = z.infer<typeof intentRuleSchema>;

export type ContactRef = { address: string; display_name: string; account_name?: string | null };

const NUMBER_WORDS: Record<string, number> = {
  once: 1,
  one: 1,
  twice: 2,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
  ten: 10,
};

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Which of the person's contacts, if any, a sentence is about. Longest match wins. */
export function resolveScope(text: string, contacts: readonly ContactRef[]): IntentScope {
  const lower = text.toLowerCase();
  let best: { scope: IntentScope; length: number } | null = null;
  const consider = (needle: string | null | undefined, scope: IntentScope) => {
    if (!needle) return;
    const n = needle.trim().toLowerCase();
    if (n.length < 3) return;
    const re = new RegExp(`(^|[^a-z0-9@._-])${escape(n)}([^a-z0-9._-]|$)`, "i");
    if (re.test(lower) && (!best || n.length > best.length)) best = { scope, length: n.length };
  };
  // A first name counts when it names exactly one contact. "Sarah" with two
  // Sarahs in the book names nobody, and the sentence stays general.
  const firstNames = new Map<string, number>();
  for (const c of contacts) {
    const first = firstNameOf(c.display_name, c.address);
    if (first) firstNames.set(first, (firstNames.get(first) ?? 0) + 1);
  }
  for (const c of contacts) {
    consider(c.address, { kind: "contact", value: c.address });
    if (!c.display_name.includes("@")) {
      consider(c.display_name, { kind: "contact", value: c.address });
    }
    const first = firstNameOf(c.display_name);
    if (first && firstNames.get(first) === 1)
      consider(first, { kind: "contact", value: c.address });
    consider(c.account_name, { kind: "account", value: c.account_name ?? undefined });
  }
  return best ? (best as { scope: IntentScope }).scope : { kind: "global" };
}

/**
 * The name a person would use in a sentence: the first word of a display
 * name, or, when all we hold is an address, the first token of its local
 * part ("dan.smith@x.com" is "Dan" to the person who emails him).
 */
function firstNameOf(displayName: string, address?: string): string | null {
  const t = displayName.trim();
  const candidate = t === "" || t.includes("@") ? localPartName(address ?? t) : t.split(/\s+/)[0]!;
  return candidate && candidate.length >= 3 && /^[a-z]+$/i.test(candidate)
    ? candidate.toLowerCase()
    : null;
}

function localPartName(address: string): string | null {
  const local = address.split("@")[0] ?? "";
  const first = local.split(/[._+-]/)[0] ?? "";
  return first || null;
}

const NO_CHASE =
  /\b(don'?t|do not|never|stop|no need to|please don'?t)\s+(chase|chasing|follow(?:ing)? up(?: with| on)?|email(?:ing)?|nudge|nudging|ping(?:ing)?|bother(?:ing)?|contact(?:ing)?|reach(?:ing)? out(?: to)?)\b/i;
const MAX_CHASES =
  /\b(?:no more than|at most|max(?:imum)?(?: of)?|not more than)\s+(\d{1,2}|once|one|twice|two|three|four|five|six|seven|eight|nine|ten)\b|\b(?:follow up|chase|nudge)\s+(?:at most|no more than)\s+(\d{1,2}|once|twice|two|three|four|five)\b|\bnever\s+(?:follow up|chase)\s+more than\s+(\d{1,2}|once|twice|two|three|four|five)\b/i;

const NO_PREDRAFT =
  /\b(don'?t|do not|never|stop|no)\s+(?:(?:write|writing|make|making|create|creating|pre-?draft|pre-?drafting)\s+)?(?:drafts?|drafting)\b/i;

/** The rule a sentence states, or null when it is an instruction rather than a rule. */
export function parseIntentRule(text: string, contacts: readonly ContactRef[]): IntentRule | null {
  const scope = resolveScope(text, contacts);
  if (NO_PREDRAFT.test(text)) return { kind: "no_predraft", scope };
  const max = MAX_CHASES.exec(text);
  if (max) {
    const raw = (max[1] ?? max[2] ?? max[3] ?? "").toLowerCase();
    const n = NUMBER_WORDS[raw] ?? Number(raw);
    if (Number.isInteger(n) && n >= 1 && n <= 20) return { kind: "max_chases", max: n, scope };
  }
  if (NO_CHASE.test(text)) return { kind: "no_chase", scope };
  return null;
}

export type IntentRuleRecord = { id: string; rule: IntentRule };

export type AppliedRules = {
  kept: Obligation[];
  skipped: Array<{ obligation: Obligation; intent_id: string }>;
};

const CHASE_KINDS: ReadonlySet<ObligationKind> = new Set(["awaiting_them", "unsent_followup"]);

function inScope(
  scope: IntentScope,
  contact: ContactRef | undefined,
  kind: ObligationKind,
): boolean {
  switch (scope.kind) {
    case "global":
      return true;
    case "contact":
      return contact?.address === scope.value;
    case "account":
      return !!scope.value && (contact?.account_name ?? null) === scope.value;
    case "situation":
      return scope.value === kind;
  }
}

/**
 * Applies the person's rules to what the detector found. A rule can only set
 * an obligation aside; it can never add one, and it never touches a reply the
 * person owes (awaiting_you): what they asked for is about chasing, and a
 * question waiting on you is not a chase.
 */
export function applyIntentRules(
  detected: readonly Obligation[],
  rules: readonly IntentRuleRecord[],
  contactsById: ReadonlyMap<string, ContactRef>,
  threadsById: ReadonlyMap<string, Pick<Thread, "thread_id"> & { chase_count: number }>,
): AppliedRules {
  const kept: Obligation[] = [];
  const skipped: AppliedRules["skipped"] = [];
  for (const o of detected) {
    if (!CHASE_KINDS.has(o.kind)) {
      kept.push(o);
      continue;
    }
    const contact = contactsById.get(o.contact_id);
    const chases = threadsById.get(o.thread_id)?.chase_count ?? 0;
    const hit = rules.find(({ rule }) => {
      if (rule.kind === "chase_after_days") {
        return (
          o.kind === "awaiting_them" &&
          inScope(rule.scope, contact, o.kind) &&
          o.reason.days_elapsed < rule.days
        );
      }
      if (rule.kind !== "no_chase" && rule.kind !== "max_chases") return false;
      if (!inScope(rule.scope, contact, o.kind)) return false;
      if (rule.kind === "no_chase") return true;
      return chases >= rule.max;
    });
    if (hit) skipped.push({ obligation: o, intent_id: hit.id });
    else kept.push(o);
  }
  return { kept, skipped };
}

/** Whether a "don't draft for me" rule covers this obligation. */
export function predraftAllowed(
  rules: readonly IntentRuleRecord[],
  contact: ContactRef | undefined,
  kind: ObligationKind,
): boolean {
  return !rules.some(
    ({ rule }) => rule.kind === "no_predraft" && inScope(rule.scope, contact, kind),
  );
}

/** The promotion that covers this write, if the person made one. */
export function promotionFor(
  rules: readonly IntentRuleRecord[],
  action: { kind: string; shape_sha256: string },
  contact: ContactRef | undefined,
  obligationKind: ObligationKind,
): IntentRuleRecord | undefined {
  return rules.find(
    ({ rule }) =>
      rule.kind === "auto_action" &&
      rule.action_kind === action.kind &&
      rule.shape_sha256 === action.shape_sha256 &&
      inScope(rule.scope, contact, obligationKind),
  );
}

/** Whether a rule says not to propose this field for this person, in scope. */
export function fieldSkipped(
  rules: readonly IntentRuleRecord[],
  field: "next_step" | "close_date",
  contact: ContactRef | undefined,
): IntentRuleRecord | undefined {
  return rules.find(
    ({ rule }) =>
      rule.kind === "skip_field" &&
      rule.field === field &&
      inScope(rule.scope, contact, "awaiting_you"),
  );
}
