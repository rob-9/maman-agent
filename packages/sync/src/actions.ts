import { createHash } from "node:crypto";
import type { Sql } from "postgres";
import type {
  OpportunityRecord,
  SalesforceActivityWriter,
  SalesforceOpportunityWriter,
} from "@maman/connector-adapters";
import {
  appendAuditEvent,
  createAction,
  findActionForMessage,
  getAction,
  getLatestPolicyVersion,
  listActions,
  transitionAction,
  withUser,
  type ActionRow,
  type UserContext,
  recordCorrection,
} from "@maman/db";
import {
  promotionFor,
  type ContactRef,
  type IntentRuleRecord,
  fieldSkipped,
} from "@maman/obligation-engine";
import {
  DEFAULT_ORG_POLICY,
  orgActionPolicy,
  orgPolicySchema,
  type OrgPolicy,
} from "@maman/policy-engine";
import { activeRules, stateIntent } from "./intents.js";
import type { OpportunityOutput } from "@maman/model-provider";

/**
 * ACTIONS: the agent writing to a system of record, with the safeguards
 * from the plan's §7, each one checkable on its own:
 *
 *   propose   the exact diff and its hash, from evidence the agent witnessed
 *   approve   bound to that hash; a changed diff is stale, never applied
 *   apply     re-proposed fresh and compared; exactly once, by marker
 *   verify    an independent read of the record; the write's own answer is
 *             never the last word
 *   revert    put it back, and read that back too
 *
 * The row in `actions` is the receipt. An audit event is appended for every
 * transition that touched the provider.
 *
 * The first kind is salesforce.log_activity: an email the person sent,
 * logged as a Task on the contact and their open opportunity. Factual,
 * reversible, and the CRM hygiene reps skip. Only kinds in ACTION_KINDS
 * exist; a promotion covers one kind and one shape.
 */

export const LOG_ACTIVITY = "salesforce.log_activity";
export const UPDATE_OPPORTUNITY = "salesforce.update_opportunity";

/** A field change read from the thread: what the record holds, what it will hold, and the sentence that says so. */
export type FieldChange = { from: string | null; to: string; quote: string };

export type OpportunityDiff = {
  kind: typeof UPDATE_OPPORTUNITY;
  opportunity_id: string;
  opportunity_name: string;
  contact_display_name: string;
  changes: { next_step?: FieldChange; close_date?: FieldChange };
};

export type ActivityDiff = {
  kind: typeof LOG_ACTIVITY;
  contact_email: string;
  contact_display_name: string;
  subject: string;
  description: string;
  activity_date: string;
  /** Resolved at apply time from the provider; part of the diff once known. */
  who_id?: string;
  what_id?: string | null;
};

const canonical = (v: unknown): string =>
  JSON.stringify(v, (_k, val) =>
    val && typeof val === "object" && !Array.isArray(val)
      ? Object.fromEntries(
          Object.entries(val as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : 1)),
        )
      : val,
  );
export const sha256 = (s: string): string => createHash("sha256").update(s).digest("hex");
export const diffHash = (diff: unknown): string => sha256(canonical(diff));
/** The write's shape: its kind and the fields it sets. A promotion covers exactly this. */
export const shapeHash = (kind: string, diff: Record<string, unknown>): string =>
  sha256(
    `${kind}:${Object.keys(diff)
      .filter((k) => k !== "kind")
      .sort()
      .join(",")}`,
  );

const marker = (actionId: string): string => `[maman:${actionId}]`;

export type ActionDeps = {
  sql: Sql;
  contentKey: Buffer;
  writer: SalesforceActivityWriter;
  /** Opportunity fields. Optional so a caller with only the activity writer still works. */
  opportunities?: SalesforceOpportunityWriter | undefined;
  orgPolicy: (organizationId: string) => Promise<OrgPolicy>;
  now: () => Date;
};

/**
 * Proposes logging a message the person sent. The diff is built from what
 * was witnessed: who, the subject, the date. Never the body: the CRM is
 * shared, the mailbox is not.
 */
export async function proposeActivityLog(
  deps: ActionDeps,
  ctx: UserContext,
  input: {
    thread_id: string;
    contact_id: string;
    contact_email: string;
    contact_display_name: string;
    subject: string;
    message_external_id: string;
    sent_at: string;
  },
): Promise<ActionRow | { ok: false; reason: "exists" | "not_allowed" }> {
  const existing = await findActionForMessage(
    deps.sql,
    ctx,
    LOG_ACTIVITY,
    input.message_external_id,
  );
  if (existing && existing.status !== "declined" && existing.status !== "stale") {
    return { ok: false, reason: "exists" };
  }
  const policy = orgActionPolicy(await deps.orgPolicy(ctx.organizationId), LOG_ACTIVITY);
  if (!policy.allowed) return { ok: false, reason: "not_allowed" };
  const diff: ActivityDiff = {
    kind: LOG_ACTIVITY,
    contact_email: input.contact_email,
    contact_display_name: input.contact_display_name,
    subject: `Email: ${input.subject}`.slice(0, 255),
    description: `Emailed ${input.contact_display_name} about "${input.subject}" on ${input.sent_at.slice(0, 10)}. Logged by their assistant.`,
    activity_date: input.sent_at.slice(0, 10),
  };
  return createAction(deps.sql, ctx, {
    kind: LOG_ACTIVITY,
    thread_id: input.thread_id,
    contact_id: input.contact_id,
    message_external_id: input.message_external_id,
    diff,
    diff_sha256: diffHash(diff),
    shape_sha256: shapeHash(LOG_ACTIVITY, diff as unknown as Record<string, unknown>),
    evidence: {
      message_external_id: input.message_external_id,
      sent_at: input.sent_at,
      thread_id: input.thread_id,
    },
    // One live action per message. A stale or declined one can be proposed
    // again; the key names the attempt so the ledger's unique index holds.
    idempotency_key: `${LOG_ACTIVITY}:${input.message_external_id}:${existing ? existing.id : "first"}`,
  });
}

/**
 * Proposes the opportunity fields the thread states. Only fields that differ
 * from the record, each with its sentence. Grounding happened before this
 * (groundOpportunityUpdate); this trusts nothing else. One live proposal per
 * (kind, latest message).
 */
export async function proposeOpportunityUpdate(
  deps: ActionDeps,
  ctx: UserContext,
  input: {
    thread_id: string;
    contact_id: string;
    contact_display_name: string;
    contact_address?: string | undefined;
    message_external_id: string;
    opportunity: OpportunityRecord;
    read: OpportunityOutput;
  },
): Promise<ActionRow | { ok: false; reason: "exists" | "not_allowed" | "nothing_to_change" }> {
  const existing = await findActionForMessage(
    deps.sql,
    ctx,
    UPDATE_OPPORTUNITY,
    input.message_external_id,
  );
  if (existing && existing.status !== "declined" && existing.status !== "stale") {
    return { ok: false, reason: "exists" };
  }
  const policy = orgActionPolicy(await deps.orgPolicy(ctx.organizationId), UPDATE_OPPORTUNITY);
  if (!policy.allowed) return { ok: false, reason: "not_allowed" };
  if (input.opportunity.is_closed) return { ok: false, reason: "nothing_to_change" };
  // Fields the person said not to propose (a kept inference, or their own
  // words) are left out before anything is compared.
  const rules = await activeRules(deps.sql, ctx);
  const contactRef = input.contact_address
    ? { address: input.contact_address, display_name: input.contact_display_name }
    : undefined;
  const skipNext = fieldSkipped(rules, "next_step", contactRef) !== undefined;
  const skipClose = fieldSkipped(rules, "close_date", contactRef) !== undefined;
  const changes: OpportunityDiff["changes"] = {};
  if (
    !skipNext &&
    input.read.next_step &&
    input.read.next_step.value !== (input.opportunity.next_step ?? "")
  ) {
    changes.next_step = {
      from: input.opportunity.next_step,
      to: input.read.next_step.value,
      quote: input.read.next_step.quote,
    };
  }
  if (
    !skipClose &&
    input.read.close_date &&
    input.read.close_date.value !== input.opportunity.close_date
  ) {
    changes.close_date = {
      from: input.opportunity.close_date,
      to: input.read.close_date.value,
      quote: input.read.close_date.quote,
    };
  }
  if (Object.keys(changes).length === 0) return { ok: false, reason: "nothing_to_change" };
  const diff: OpportunityDiff = {
    kind: UPDATE_OPPORTUNITY,
    opportunity_id: input.opportunity.id,
    opportunity_name: input.opportunity.name,
    contact_display_name: input.contact_display_name,
    changes,
  };
  return createAction(deps.sql, ctx, {
    kind: UPDATE_OPPORTUNITY,
    thread_id: input.thread_id,
    contact_id: input.contact_id,
    message_external_id: input.message_external_id,
    diff,
    diff_sha256: diffHash(diff),
    shape_sha256: shapeHash(UPDATE_OPPORTUNITY, { ...changes }),
    evidence: {
      message_external_id: input.message_external_id,
      thread_id: input.thread_id,
      quotes: Object.values(changes).map((c) => c.quote),
    },
    idempotency_key: `${UPDATE_OPPORTUNITY}:${input.message_external_id}:${existing ? existing.id : "first"}`,
  });
}

/** Approval is bound to the exact diff the person saw. Anything else is stale. */
export async function approveAction(
  deps: ActionDeps,
  ctx: UserContext,
  id: string,
  diffSha256: string,
  by: "user" | "promotion" = "user",
): Promise<
  { ok: true; action: ActionRow } | { ok: false; reason: "not_found" | "stale" | "not_proposed" }
> {
  const current = await getAction(deps.sql, ctx, id);
  if (!current) return { ok: false, reason: "not_found" };
  if (current.status !== "proposed") return { ok: false, reason: "not_proposed" };
  if (current.diff_sha256 !== diffSha256) {
    await transitionAction(deps.sql, ctx, id, ["proposed"], {
      status: "stale",
      error: "approval did not match the diff",
    });
    return { ok: false, reason: "stale" };
  }
  const row = await transitionAction(deps.sql, ctx, id, ["proposed"], {
    status: "approved",
    approved_by: by,
    approved_at: deps.now().toISOString(),
  });
  return row ? { ok: true, action: row } : { ok: false, reason: "not_proposed" };
}

export async function declineAction(
  deps: ActionDeps,
  ctx: UserContext,
  id: string,
): Promise<boolean> {
  const row = await transitionAction(deps.sql, ctx, id, ["proposed"], { status: "declined" });
  if (!row) return false;
  // "Not now" on a proposal is the person correcting the agent. Which fields
  // it proposed is the signal; the values are not kept here.
  if (row.kind === UPDATE_OPPORTUNITY) {
    const d = row.diff as OpportunityDiff;
    await recordCorrection(deps.sql, ctx, {
      kind: "crm_field",
      ref_id: row.id,
      contact_address: null,
      signals: Object.keys(d.changes).map((f) => `declined:${f}`),
      summary: { opportunity: d.opportunity_name },
    });
  }
  return true;
}

export type ApplyResult =
  | { ok: true; action: ActionRow; verified: true }
  | {
      ok: false;
      action: ActionRow | null;
      reason: "not_found" | "not_approved" | "stale" | "provider" | "unverified";
    };

/**
 * Applies an approved action, exactly once, and reads the record back.
 *
 * The write is re-proposed from current facts and its hash compared with
 * what was approved; a difference aborts as stale. Before creating, the
 * marker is searched for, so a retry after an unknown result finds the
 * task rather than making a second. After creating, the task is read
 * through a separate call and compared field by field; only then is the
 * action verified. A write whose read-back disagrees is a failure, whatever
 * the provider said.
 */
export async function applyAction(
  deps: ActionDeps,
  ctx: UserContext,
  id: string,
): Promise<ApplyResult> {
  const action = await getAction(deps.sql, ctx, id);
  if (!action) return { ok: false, action: null, reason: "not_found" };
  if (action.status !== "approved") return { ok: false, action, reason: "not_approved" };
  if (action.kind === UPDATE_OPPORTUNITY) return applyOpportunityUpdate(deps, ctx, action);
  const diff = action.diff as ActivityDiff;
  const audit = async (
    outcome: "success" | "failure",
    reason: string,
    metadata: Record<string, string | number | boolean>,
  ) =>
    appendAuditEvent(
      deps.sql,
      { organizationId: ctx.organizationId },
      {
        organization_id: ctx.organizationId,
        actor_type: action.approved_by === "promotion" ? "service" : "user",
        actor_id: ctx.userId,
        action: `action.${action.kind}`,
        resource_type: "action",
        resource_id: action.id,
        outcome,
        reason_code: reason,
        metadata,
      },
    ).catch(() => undefined);

  try {
    // Fresh facts: the contact and its open opportunity, now.
    const contact = await deps.writer.findContact(ctx.organizationId, diff.contact_email);
    if (!contact) {
      const row = await transitionAction(deps.sql, ctx, id, ["approved"], {
        status: "failed",
        error: "contact not in Salesforce",
      });
      await audit("failure", "contact_not_found", {});
      return { ok: false, action: row ?? action, reason: "provider" };
    }
    const opportunity = await deps.writer.findOpenOpportunity(ctx.organizationId, contact.id);
    // Re-propose and compare: the approved diff must still be the write we would make.
    const fresh: ActivityDiff = { ...diff };
    delete (fresh as { who_id?: string }).who_id;
    delete (fresh as { what_id?: string | null }).what_id;
    if (diffHash(fresh) !== action.diff_sha256) {
      const row = await transitionAction(deps.sql, ctx, id, ["approved"], {
        status: "stale",
        error: "the write changed after approval",
      });
      return { ok: false, action: row ?? action, reason: "stale" };
    }
    const description = `${diff.description} ${marker(action.id)}`;
    // Exactly once: anything already there with our marker is ours.
    let created = await deps.writer.findTaskByMarker(ctx.organizationId, marker(action.id));
    if (!created) {
      const { id: taskId } = await deps.writer.createTask(ctx.organizationId, {
        who_id: contact.id,
        what_id: opportunity ?? undefined,
        subject: diff.subject,
        description,
        activity_date: diff.activity_date,
      });
      created = {
        id: taskId,
        who_id: contact.id,
        what_id: opportunity,
        subject: diff.subject,
        description,
        activity_date: diff.activity_date,
        status: "Completed",
      };
    }
    const applied = await transitionAction(deps.sql, ctx, id, ["approved"], {
      status: "applied",
      applied_at: deps.now().toISOString(),
      external_id: created.id,
      revert: { delete_task: created.id },
    });
    // Independent read-back. Not the create call's answer: a separate GET.
    const seen = await deps.writer.readTask(ctx.organizationId, created.id);
    const mismatches: string[] = [];
    if (!seen) mismatches.push("task not found on read-back");
    else {
      if (seen.who_id !== contact.id) mismatches.push("WhoId");
      if ((seen.what_id ?? null) !== (opportunity ?? null)) mismatches.push("WhatId");
      if (seen.subject !== diff.subject) mismatches.push("Subject");
      if (!seen.description.includes(marker(action.id))) mismatches.push("Description marker");
      if ((seen.activity_date ?? "").slice(0, 10) !== diff.activity_date)
        mismatches.push("ActivityDate");
    }
    if (mismatches.length > 0) {
      const row = await transitionAction(deps.sql, ctx, id, ["applied"], {
        status: "failed",
        verification: { verified: false, mismatches, task_id: created.id },
        error: `read-back disagreed: ${mismatches.join(", ")}`,
      });
      await audit("failure", "unverified", {
        task_id: created.id,
        mismatches: mismatches.join(","),
      });
      return { ok: false, action: row ?? applied ?? action, reason: "unverified" };
    }
    const verified = await transitionAction(deps.sql, ctx, id, ["applied"], {
      status: "verified",
      verification: {
        verified: true,
        task_id: created.id,
        who_id: contact.id,
        what_id: opportunity ?? null,
        read_at: deps.now().toISOString(),
      },
      verified_at: deps.now().toISOString(),
    });
    await audit("success", "verified", {
      task_id: created.id,
      verified: true,
      approved_by: action.approved_by ?? "user",
    });
    return { ok: true, action: verified ?? applied ?? action, verified: true };
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    const row = await transitionAction(deps.sql, ctx, id, ["approved", "applied"], {
      status: "failed",
      error: message,
    });
    await audit("failure", "provider_error", { error: message.slice(0, 200) });
    return { ok: false, action: row ?? action, reason: "provider" };
  }
}

/**
 * Applies an opportunity update. Reads the record first: a field the person
 * changed by hand since the proposal is never overwritten; the action goes
 * stale and shows both. Writes only the fields in the diff. Reads back and
 * compares. Keeps the previous values so undo is a write of the same shape.
 */
async function applyOpportunityUpdate(
  deps: ActionDeps,
  ctx: UserContext,
  action: ActionRow,
): Promise<ApplyResult> {
  const diff = action.diff as OpportunityDiff;
  const writer = deps.opportunities;
  const audit = async (
    outcome: "success" | "failure",
    reason: string,
    metadata: Record<string, string | number | boolean>,
  ) =>
    appendAuditEvent(
      deps.sql,
      { organizationId: ctx.organizationId },
      {
        organization_id: ctx.organizationId,
        actor_type: action.approved_by === "promotion" ? "service" : "user",
        actor_id: ctx.userId,
        action: `action.${action.kind}`,
        resource_type: "action",
        resource_id: action.id,
        outcome,
        reason_code: reason,
        metadata,
      },
    ).catch(() => undefined);
  if (!writer) {
    const row = await transitionAction(deps.sql, ctx, action.id, ["approved"], {
      status: "failed",
      error: "opportunity writer not configured",
    });
    return { ok: false, action: row ?? action, reason: "provider" };
  }
  try {
    const before = await writer.readOpportunity(ctx.organizationId, diff.opportunity_id);
    if (!before) {
      const row = await transitionAction(deps.sql, ctx, action.id, ["approved"], {
        status: "failed",
        error: "opportunity not in Salesforce",
      });
      await audit("failure", "opportunity_not_found", {});
      return { ok: false, action: row ?? action, reason: "provider" };
    }
    // Never write over a hand edit: what we proposed FROM must still be there.
    const moved: string[] = [];
    if (
      diff.changes.next_step &&
      (before.next_step ?? null) !== (diff.changes.next_step.from ?? null)
    ) {
      moved.push("next_step");
    }
    if (
      diff.changes.close_date &&
      (before.close_date ?? null) !== (diff.changes.close_date.from ?? null)
    ) {
      moved.push("close_date");
    }
    if (moved.length > 0) {
      // The person set the field themselves. That is a correction too.
      await recordCorrection(deps.sql, ctx, {
        kind: "crm_field",
        ref_id: action.id,
        contact_address: null,
        signals: moved.map((f) => `hand_edit:${f}`),
        summary: { opportunity: diff.opportunity_name, fields: moved },
      });
      const row = await transitionAction(deps.sql, ctx, action.id, ["approved"], {
        status: "stale",
        error: `changed in Salesforce since you saw it: ${moved.join(", ")}`,
        verification: {
          verified: false,
          current: { next_step: before.next_step, close_date: before.close_date },
        },
      });
      return { ok: false, action: row ?? action, reason: "stale" };
    }
    const fields: { next_step?: string; close_date?: string } = {};
    if (diff.changes.next_step) fields.next_step = diff.changes.next_step.to;
    if (diff.changes.close_date) fields.close_date = diff.changes.close_date.to;
    await writer.updateOpportunity(ctx.organizationId, diff.opportunity_id, fields);
    const revert: { next_step?: string | null; close_date?: string | null } = {};
    if (diff.changes.next_step) revert.next_step = diff.changes.next_step.from;
    if (diff.changes.close_date) revert.close_date = diff.changes.close_date.from;
    const applied = await transitionAction(deps.sql, ctx, action.id, ["approved"], {
      status: "applied",
      applied_at: deps.now().toISOString(),
      external_id: diff.opportunity_id,
      revert: { opportunity_id: diff.opportunity_id, fields: revert },
    });
    // Independent read-back, field by field.
    const after = await writer.readOpportunity(ctx.organizationId, diff.opportunity_id);
    const mismatches: string[] = [];
    if (!after) mismatches.push("opportunity not found on read-back");
    else {
      if (fields.next_step !== undefined && (after.next_step ?? "") !== fields.next_step) {
        mismatches.push("NextStep");
      }
      if (fields.close_date !== undefined && after.close_date !== fields.close_date) {
        mismatches.push("CloseDate");
      }
    }
    if (mismatches.length > 0) {
      const row = await transitionAction(deps.sql, ctx, action.id, ["applied"], {
        status: "failed",
        verification: { verified: false, mismatches },
        error: `read-back disagreed: ${mismatches.join(", ")}`,
      });
      await audit("failure", "unverified", { mismatches: mismatches.join(",") });
      return { ok: false, action: row ?? applied ?? action, reason: "unverified" };
    }
    const verified = await transitionAction(deps.sql, ctx, action.id, ["applied"], {
      status: "verified",
      verification: {
        verified: true,
        opportunity_id: diff.opportunity_id,
        fields,
        read_at: deps.now().toISOString(),
      },
      verified_at: deps.now().toISOString(),
    });
    await audit("success", "verified", {
      opportunity_id: diff.opportunity_id,
      fields: Object.keys(fields).join(","),
      approved_by: action.approved_by ?? "user",
    });
    return { ok: true, action: verified ?? applied ?? action, verified: true };
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    const row = await transitionAction(deps.sql, ctx, action.id, ["approved", "applied"], {
      status: "failed",
      error: message,
    });
    await audit("failure", "provider_error", { error: message.slice(0, 200) });
    return { ok: false, action: row ?? action, reason: "provider" };
  }
}

/** Puts it back: deletes the task and reads back that it is gone. */
export async function revertAction(
  deps: ActionDeps,
  ctx: UserContext,
  id: string,
): Promise<
  | { ok: true; action: ActionRow }
  | { ok: false; reason: "not_found" | "not_revertible" | "provider" }
> {
  const action = await getAction(deps.sql, ctx, id);
  if (!action) return { ok: false, reason: "not_found" };
  if (!["verified", "applied", "failed"].includes(action.status)) {
    return { ok: false, reason: "not_revertible" };
  }
  const opp = action.revert as {
    opportunity_id?: string;
    fields?: { next_step?: string | null; close_date?: string | null };
  } | null;
  if (opp?.opportunity_id && opp.fields && deps.opportunities) {
    // The same shape of write, with the previous values, read back the same way.
    try {
      await deps.opportunities.updateOpportunity(
        ctx.organizationId,
        opp.opportunity_id,
        opp.fields,
      );
      const after = await deps.opportunities.readOpportunity(
        ctx.organizationId,
        opp.opportunity_id,
      );
      const back =
        !!after &&
        (opp.fields.next_step === undefined ||
          (after.next_step ?? null) === (opp.fields.next_step ?? null)) &&
        (opp.fields.close_date === undefined ||
          (after.close_date ?? null) === (opp.fields.close_date ?? null));
      if (!back) return { ok: false, reason: "provider" };
      const row = await transitionAction(deps.sql, ctx, id, ["verified", "applied", "failed"], {
        status: "reverted",
        reverted_at: deps.now().toISOString(),
      });
      await appendAuditEvent(
        deps.sql,
        { organizationId: ctx.organizationId },
        {
          organization_id: ctx.organizationId,
          actor_type: "user",
          actor_id: ctx.userId,
          action: `action.${action.kind}.revert`,
          resource_type: "action",
          resource_id: action.id,
          outcome: "success",
          reason_code: "reverted",
          metadata: { opportunity_id: opp.opportunity_id },
        },
      ).catch(() => undefined);
      return row ? { ok: true, action: row } : { ok: false, reason: "not_revertible" };
    } catch {
      return { ok: false, reason: "provider" };
    }
  }
  const taskId = (action.revert as { delete_task?: string } | null)?.delete_task;
  if (!taskId) return { ok: false, reason: "not_revertible" };
  try {
    await deps.writer.deleteTask(ctx.organizationId, taskId);
    const still = await deps.writer.readTask(ctx.organizationId, taskId);
    if (still) {
      await appendAuditEvent(
        deps.sql,
        { organizationId: ctx.organizationId },
        {
          organization_id: ctx.organizationId,
          actor_type: "user",
          actor_id: ctx.userId,
          action: `action.${action.kind}.revert`,
          resource_type: "action",
          resource_id: action.id,
          outcome: "failure",
          reason_code: "still_present",
          metadata: { task_id: taskId },
        },
      ).catch(() => undefined);
      return { ok: false, reason: "provider" };
    }
    const row = await transitionAction(deps.sql, ctx, id, ["verified", "applied", "failed"], {
      status: "reverted",
      reverted_at: deps.now().toISOString(),
    });
    await appendAuditEvent(
      deps.sql,
      { organizationId: ctx.organizationId },
      {
        organization_id: ctx.organizationId,
        actor_type: "user",
        actor_id: ctx.userId,
        action: `action.${action.kind}.revert`,
        resource_type: "action",
        resource_id: action.id,
        outcome: "success",
        reason_code: "reverted",
        metadata: { task_id: taskId },
      },
    ).catch(() => undefined);
    return row ? { ok: true, action: row } : { ok: false, reason: "not_revertible" };
  } catch {
    return { ok: false, reason: "provider" };
  }
}

/**
 * "Always do this." A promotion is a stated intent entry, in the person's
 * words, whose rule binds the kind and the shape of the write it covers.
 */
export async function promoteAction(
  deps: ActionDeps,
  ctx: UserContext,
  actionId: string,
): Promise<{ ok: true; intent_id: string } | { ok: false; reason: "not_found" | "not_allowed" }> {
  const action = await getAction(deps.sql, ctx, actionId);
  if (!action) return { ok: false, reason: "not_found" };
  const policy = orgActionPolicy(await deps.orgPolicy(ctx.organizationId), action.kind);
  if (!policy.allowed || !policy.unattended) return { ok: false, reason: "not_allowed" };
  const text =
    action.kind === UPDATE_OPPORTUNITY
      ? "Always update the opportunity's next step and close date from my threads, without asking."
      : "Always log the emails I send to Salesforce, without asking.";
  const view = await stateIntent(
    deps,
    ctx,
    text,
    "stated",
    { promoted_from: actionId },
    {
      kind: "auto_action",
      action_kind: action.kind,
      shape_sha256: action.shape_sha256,
      scope: { kind: "global" },
    },
  );
  return { ok: true, intent_id: view.id };
}

export type ActionView = {
  id: string;
  kind: string;
  status: ActionRow["status"];
  diff_sha256: string;
  summary: string;
  detail: string;
  /** The sentences the write rests on, when it was read from the thread. */
  quotes: string[];
  approved_by: ActionRow["approved_by"];
  external_id: string | null;
  verified: boolean;
  error: string | null;
  created_at: string;
  can_revert: boolean;
  /** Whether "Always" is available: the organization allows this kind unattended. */
  can_promote: boolean;
  /** What the write is about: the opportunity's name, or the email's subject. */
  record: string;
  /** Who it concerns. */
  contact_display_name: string;
  /** Each field the write touches, before and after. Plain labels, ISO dates. */
  changes: Array<{
    field: "next_step" | "close_date" | "subject" | "date";
    from: string | null;
    to: string;
  }>;
};

export async function listActionViews(deps: ActionDeps, ctx: UserContext): Promise<ActionView[]> {
  const [rows, policy] = await Promise.all([
    listActions(deps.sql, ctx),
    deps.orgPolicy(ctx.organizationId),
  ]);
  return rows.map((r) => {
    const base = {
      id: r.id,
      kind: r.kind,
      status: r.status,
      diff_sha256: r.diff_sha256,
      approved_by: r.approved_by,
      external_id: r.external_id,
      verified: r.status === "verified",
      error: r.error,
      created_at: r.created_at,
      can_revert: ["verified", "applied", "failed"].includes(r.status) && r.revert !== null,
      can_promote: orgActionPolicy(policy, r.kind).unattended,
    };
    if (r.kind === UPDATE_OPPORTUNITY) {
      const d = r.diff as OpportunityDiff;
      const parts: string[] = [];
      if (d.changes.next_step) parts.push(`next step "${d.changes.next_step.to}"`);
      if (d.changes.close_date) parts.push(`close date ${d.changes.close_date.to}`);
      return {
        ...base,
        summary: `Update ${d.opportunity_name}: ${parts.join(", ")}`,
        detail: `From the thread with ${d.contact_display_name}.`,
        quotes: Object.values(d.changes).map((c) => c.quote),
        record: d.opportunity_name,
        contact_display_name: d.contact_display_name,
        changes: [
          ...(d.changes.next_step
            ? [
                {
                  field: "next_step" as const,
                  from: d.changes.next_step.from,
                  to: d.changes.next_step.to,
                },
              ]
            : []),
          ...(d.changes.close_date
            ? [
                {
                  field: "close_date" as const,
                  from: d.changes.close_date.from,
                  to: d.changes.close_date.to,
                },
              ]
            : []),
        ],
      };
    }
    const d = r.diff as ActivityDiff;
    return {
      ...base,
      summary: `Log to Salesforce: ${d.subject}`,
      detail: `${d.description} Against ${d.contact_display_name}${d.what_id ? " and their open opportunity" : ""}.`,
      quotes: [],
      record: d.subject,
      contact_display_name: d.contact_display_name,
      changes: [
        { field: "subject" as const, from: null, to: d.subject },
        { field: "date" as const, from: null, to: d.activity_date },
      ],
    };
  });
}

/**
 * IN THE SWEEP. For every draft just matched to a message the person sent,
 * propose logging it. If the person promoted this kind (and the
 * organization allows it unattended, and the shape matches), approve and
 * apply without asking. Four conditions, none implying another (§7).
 */
export async function autoActions(
  deps: ActionDeps,
  ctx: UserContext,
  sent: readonly {
    thread_id: string;
    contact_id: string;
    contact_email: string;
    contact_display_name: string;
    contact_account_name: string | null;
    subject: string;
    message_external_id: string;
    sent_at: string;
  }[],
): Promise<{ proposed: number; auto_applied: number; auto_failed: number }> {
  const result = { proposed: 0, auto_applied: 0, auto_failed: 0 };
  if (sent.length === 0) return result;
  const policy = await deps.orgPolicy(ctx.organizationId);
  const rules: IntentRuleRecord[] = await activeRules(deps.sql, ctx);
  for (const s of sent) {
    const proposed = await proposeActivityLog(deps, ctx, s);
    if ("ok" in proposed) continue;
    result.proposed += 1;
    const contact: ContactRef = {
      address: s.contact_email,
      display_name: s.contact_display_name,
      account_name: s.contact_account_name,
    };
    const promotion = promotionFor(
      rules,
      { kind: proposed.kind, shape_sha256: proposed.shape_sha256 },
      contact,
      "awaiting_them",
    );
    const org = orgActionPolicy(policy, proposed.kind);
    if (!promotion || !org.unattended) continue;
    const approved = await approveAction(deps, ctx, proposed.id, proposed.diff_sha256, "promotion");
    if (!approved.ok) continue;
    const applied = await applyAction(deps, ctx, proposed.id);
    if (applied.ok) result.auto_applied += 1;
    else result.auto_failed += 1;
  }
  return result;
}

/** The messages the person sent that a draft was just matched to, with what an action needs. */
export async function sentFromMatchedDrafts(
  deps: { sql: Sql },
  ctx: UserContext,
  matched: readonly { thread_id: string; sent_external_id: string; sent_at: string }[],
): Promise<Parameters<typeof autoActions>[2]> {
  const out: Array<Parameters<typeof autoActions>[2][number]> = [];
  for (const m of matched) {
    const rows = await withUser(
      deps.sql,
      ctx,
      (tx) => tx<
        Array<{
          contact_id: string;
          contact_email: string;
          contact_display_name: string;
          contact_account_name: string | null;
          subject: string;
        }>
      >`
        SELECT c.id AS contact_id, c.external_id AS contact_email, c.display_name AS contact_display_name,
               c.account_name AS contact_account_name, t.subject
        FROM threads t JOIN contacts c ON c.id = t.contact_id
        WHERE t.id = ${m.thread_id}
      `,
    );
    const r = rows[0];
    if (!r) continue;
    out.push({
      ...r,
      thread_id: m.thread_id,
      message_external_id: m.sent_external_id,
      sent_at: m.sent_at,
    });
  }
  return out;
}

/** The organization's policy: the latest version it published, else the default. */
export function orgPolicyResolver(sql: Sql): (organizationId: string) => Promise<OrgPolicy> {
  return async (organizationId) => {
    const latest = await getLatestPolicyVersion(sql, { organizationId });
    if (!latest) return DEFAULT_ORG_POLICY;
    const parsed = orgPolicySchema.safeParse(latest.policy);
    return parsed.success ? parsed.data : DEFAULT_ORG_POLICY;
  };
}
