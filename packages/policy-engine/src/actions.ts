import type { OrgPolicy } from "./org-policy.js";

/**
 * Writes the agent may perform on a system of record, and how far each may
 * go without asking. The ceiling is the organization's; the floor is the
 * person's promotion. Both must hold (§7: four conditions).
 *
 * `low` risk means factual and reversible: the agent witnessed the thing it
 * writes, and the write can be undone. Those may become unattended once the
 * person promotes them. Anything involving judgment stays at "propose".
 */
export const ACTION_KINDS = {
  /** Witnessed and undoable: may run unattended once the person promotes it. */
  "salesforce.log_activity": { risk: "low", reversible: true, unattended_allowed: true },
  /**
   * Read from the thread, with the sentence attached; undoable. Medium: it
   * moves a forecast field, so it runs unattended only where the
   * organization has listed it (unattended_medium_capabilities).
   */
  "salesforce.update_opportunity": { risk: "medium", reversible: true, unattended_allowed: true },
  /**
   * Sending mail. High: it cannot be taken back. Never unattended unless the
   * organization has said sends may be (allow_unattended_send) AND the
   * person promoted that exact shape of send. Until then, one message at a
   * time, the exact text shown, approved by the person.
   */
  "gmail.send": { risk: "high", reversible: false, unattended_allowed: true },
} as const;
export type ActionKind = keyof typeof ACTION_KINDS;

export function isActionKind(kind: string): kind is ActionKind {
  return kind in ACTION_KINDS;
}

/** Whether the organization allows this kind at all, and whether unattended. */
export function orgActionPolicy(
  policy: OrgPolicy,
  kind: string,
): { allowed: boolean; unattended: boolean; reason?: string } {
  if (!isActionKind(kind)) return { allowed: false, unattended: false, reason: "unknown_action" };
  if (policy.disabled_capabilities.includes(kind)) {
    return { allowed: false, unattended: false, reason: "disabled_by_org" };
  }
  const meta = ACTION_KINDS[kind];
  const unattended =
    meta.unattended_allowed &&
    (meta.risk === "low" ||
      (meta.risk === "medium" && policy.unattended_medium_capabilities.includes(kind)) ||
      (meta.risk === "high" && policy.allow_unattended_send));
  return { allowed: true, unattended };
}
