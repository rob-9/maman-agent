import type { Sql } from "postgres";
import { listPendingObligations, type UserContext } from "@maman/db";
import { groundOpportunityUpdate, type ModelProvider } from "@maman/model-provider";
import { promotionFor } from "@maman/obligation-engine";
import { orgActionPolicy } from "@maman/policy-engine";
import {
  applyAction,
  approveAction,
  proposeOpportunityUpdate,
  type ActionDeps,
} from "./actions.js";
import { storedThreadContent } from "./content.js";
import { activeRules, intentsFor } from "./intents.js";
import { meetingContext } from "./meetings.js";

/**
 * THE OPPORTUNITY PASS. After judgment, for candidates on an open deal: read
 * the thread for the next step and the close date, each with its sentence,
 * ground the sentences against the thread in code, and propose only what
 * differs from the record. Applied without asking only under a promotion
 * the organization allows for a medium-risk write. Bounded per sweep; one
 * proposal per (thread state).
 */

export type OpportunityPassDeps = ActionDeps & {
  provider: ModelProvider;
  /** Default 10. */
  max_candidates?: number;
  /** A click on one card: read only that thread. */
  only_thread_id?: string | undefined;
};

export type OpportunityPassResult = {
  considered: number;
  proposed: number;
  nothing_to_change: number;
  ungrounded: number;
  auto_applied: number;
  failed: number;
};

export async function runOpportunityPass(
  deps: OpportunityPassDeps,
  ctx: UserContext,
): Promise<OpportunityPassResult> {
  const result: OpportunityPassResult = {
    considered: 0,
    proposed: 0,
    nothing_to_change: 0,
    ungrounded: 0,
    auto_applied: 0,
    failed: 0,
  };
  if (!deps.opportunities) return result;
  const policy = await deps.orgPolicy(ctx.organizationId);
  if (!orgActionPolicy(policy, "salesforce.update_opportunity").allowed) return result;
  const rules = await activeRules(deps.sql, ctx);
  // The whole detected list, not the owed-only view: a deal moves in a thread
  // where nothing is owed too ("Thanks, next step is the MSA, signing by end of
  // quarter" owes no reply and says two things Salesforce should hold).
  const candidates = (
    await listPendingObligations(deps.sql, ctx, deps.max_candidates ?? 10, { agent: false })
  ).filter((o) =>
    deps.only_thread_id ? o.thread_id === deps.only_thread_id : o.has_open_deal === true,
  );
  result.considered = candidates.length;
  for (const c of candidates) {
    try {
      const content = await storedThreadContent(deps, ctx, c.thread_id);
      if (!content || content.messages.length === 0) continue;
      const lastExternal = await lastMessageExternalId(deps.sql, ctx, c.thread_id);
      if (!lastExternal) continue;
      const contactId = await deps.writer.findContact(ctx.organizationId, c.contact_address);
      if (!contactId) continue;
      const oppId = await deps.writer.findOpenOpportunity(ctx.organizationId, contactId.id);
      if (!oppId) continue;
      const opportunity = await deps.opportunities.readOpportunity(ctx.organizationId, oppId);
      if (!opportunity || opportunity.is_closed) continue;
      const [meetings, preferences] = await Promise.all([
        meetingContext(deps, ctx, c.contact_address, deps.now()),
        intentsFor(deps, ctx, {
          contact_address: c.contact_address,
          account_name: c.contact_account_name,
          kind: c.kind,
        }),
      ]);
      const read = await deps.provider.readOpportunity({
        contact_display_name: c.contact_display_name.slice(0, 120),
        account_name: c.contact_account_name ? c.contact_account_name.slice(0, 120) : null,
        subject: c.subject.slice(0, 300),
        current: {
          stage: opportunity.stage,
          next_step: opportunity.next_step,
          close_date: opportunity.close_date,
        },
        messages: content.messages,
        ...(meetings.next_meeting ? { next_meeting: meetings.next_meeting } : {}),
        ...(preferences.length > 0 ? { preferences } : {}),
      });
      if (!read.ok) {
        result.failed += 1;
        continue;
      }
      // Grounding in code: a quote not in the thread, or a date the quote
      // does not say, drops that field. Nothing invented reaches the record.
      const grounded = groundOpportunityUpdate(read.value, content.messages);
      const value = { ...read.value };
      if (!grounded.ok) {
        result.ungrounded += 1;
        for (const v of grounded.violations) {
          if (v.startsWith("next_step")) value.next_step = null;
          if (v.startsWith("close_date")) value.close_date = null;
        }
      }
      const proposed = await proposeOpportunityUpdate(deps, ctx, {
        thread_id: c.thread_id,
        contact_id: c.contact_id,
        contact_display_name: c.contact_display_name,
        message_external_id: lastExternal,
        opportunity,
        read: value,
      });
      if ("ok" in proposed) {
        if (proposed.reason === "nothing_to_change") result.nothing_to_change += 1;
        continue;
      }
      result.proposed += 1;
      const promotion = promotionFor(
        rules,
        { kind: proposed.kind, shape_sha256: proposed.shape_sha256 },
        {
          address: c.contact_address,
          display_name: c.contact_display_name,
          account_name: c.contact_account_name,
        },
        c.kind,
      );
      if (!promotion || !orgActionPolicy(policy, proposed.kind).unattended) continue;
      const approved = await approveAction(
        deps,
        ctx,
        proposed.id,
        proposed.diff_sha256,
        "promotion",
      );
      if (!approved.ok) continue;
      const applied = await applyAction(deps, ctx, proposed.id);
      if (applied.ok) result.auto_applied += 1;
      else result.failed += 1;
    } catch {
      result.failed += 1;
    }
  }
  return result;
}

async function lastMessageExternalId(
  sql: Sql,
  ctx: UserContext,
  threadId: string,
): Promise<string | null> {
  const { getThreadMessages } = await import("@maman/db");
  const rows = await getThreadMessages(sql, ctx, threadId);
  return rows.length > 0 ? rows[rows.length - 1]!.external_id : null;
}
