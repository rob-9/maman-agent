import type { ContactRef, IntentRule, IntentScope } from "./intents.js";
import type { ObligationKind } from "./types.js";

/**
 * INTENT INFERRED FROM WHAT THE PERSON DID. Deterministic, and held as a
 * proposal until the person keeps it: nothing here becomes a rule on its own.
 *
 * Each inference names its evidence in plain words, because the sentence
 * shown to the person is the whole argument. The thresholds are small on
 * purpose (two dismissals of the same person, three of the same age); the
 * person confirms, so the cost of a wrong guess is one click, and the cost
 * of no guess is a rule they had to type.
 */

export type Decision = {
  kind: ObligationKind;
  outcome: "drafted" | "snoozed" | "dismissed" | "resolved";
  days_elapsed: number;
  contact: ContactRef;
};

export type InferredIntent = {
  text: string;
  evidence: string;
  rule: IntentRule;
};

const CHASE: ReadonlySet<ObligationKind> = new Set(["awaiting_them", "unsent_followup"]);

/** Two dismissed follow-ups with one person is a pattern; one is a day. */
export const CONTACT_DISMISSALS = 2;
/** Three across an account, from at least two people there. */
export const ACCOUNT_DISMISSALS = 3;
/** Three follow-ups set aside young, and none acted on younger, is a waiting rule. */
export const YOUNG_DISMISSALS = 3;
export const MAX_WAIT_DAYS = 14;

function sameScope(a: IntentScope, b: IntentScope): boolean {
  return a.kind === b.kind && (a.value ?? null) === (b.value ?? null);
}

function alreadyThere(existing: readonly IntentRule[], rule: IntentRule): boolean {
  return existing.some(
    (e) =>
      e.kind === rule.kind &&
      (rule.kind === "chase_after_days" ? true : sameScope(e.scope, rule.scope)),
  );
}

export function inferIntents(
  decisions: readonly Decision[],
  existing: readonly IntentRule[],
): InferredIntent[] {
  const out: InferredIntent[] = [];
  const dismissedChases = decisions.filter((d) => d.outcome === "dismissed" && CHASE.has(d.kind));

  // 1. The same person, set aside again and again.
  const byContact = new Map<string, Decision[]>();
  for (const d of dismissedChases) {
    const list = byContact.get(d.contact.address) ?? [];
    list.push(d);
    byContact.set(d.contact.address, list);
  }
  for (const [address, list] of [...byContact.entries()].sort()) {
    if (list.length < CONTACT_DISMISSALS) continue;
    const rule: IntentRule = { kind: "no_chase", scope: { kind: "contact", value: address } };
    if (alreadyThere(existing, rule)) continue;
    const name = list[0]!.contact.display_name;
    out.push({
      text: `Don't chase ${name}.`,
      evidence: `You set aside ${list.length} follow-ups with ${name}.`,
      rule,
    });
  }

  // 2. The same account, from more than one person there.
  const byAccount = new Map<string, Decision[]>();
  for (const d of dismissedChases) {
    const account = d.contact.account_name;
    if (!account) continue;
    const list = byAccount.get(account) ?? [];
    list.push(d);
    byAccount.set(account, list);
  }
  for (const [account, list] of [...byAccount.entries()].sort()) {
    const people = new Set(list.map((d) => d.contact.address));
    if (list.length < ACCOUNT_DISMISSALS || people.size < 2) continue;
    const rule: IntentRule = { kind: "no_chase", scope: { kind: "account", value: account } };
    if (alreadyThere(existing, rule)) continue;
    out.push({
      text: `Don't chase ${account}.`,
      evidence: `You set aside ${list.length} follow-ups with ${people.size} people at ${account}.`,
      rule,
    });
  }

  // 3. Follow-ups set aside while young, and none acted on that young.
  const youngDismissed = decisions
    .filter((d) => d.outcome === "dismissed" && d.kind === "awaiting_them")
    .map((d) => d.days_elapsed);
  const actedAt = decisions
    .filter(
      (d) => d.kind === "awaiting_them" && (d.outcome === "drafted" || d.outcome === "resolved"),
    )
    .map((d) => d.days_elapsed);
  if (youngDismissed.length >= YOUNG_DISMISSALS) {
    const oldest = Math.max(...youngDismissed);
    const wait = oldest + 1;
    const actedYounger = actedAt.some((a) => a <= oldest);
    const rule: IntentRule = { kind: "chase_after_days", days: wait, scope: { kind: "global" } };
    if (wait <= MAX_WAIT_DAYS && !actedYounger && !alreadyThere(existing, rule)) {
      out.push({
        text: `Wait ${wait} days before chasing.`,
        evidence: `You set aside ${youngDismissed.length} follow-ups that were less than ${wait} days old.`,
        rule,
      });
    }
  }
  return out;
}
