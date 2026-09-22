import type { Sql } from "postgres";
import type { ThreadContentReader } from "@maman/connector-adapters";
import {
  listContactThreads,
  listPendingObligations,
  upsertThreadAssessment,
  type PendingObligationRow,
  type UserContext,
} from "@maman/db";
import type { AssessmentInput, ModelProvider } from "@maman/model-provider";
import { storedThreadContent } from "./content.js";

/**
 * THE AGENT PASS. Runs after detection, over the candidates the detector
 * found, and only those. For each one whose thread has moved since it was
 * last judged: read the conversation from the store (decrypted to this
 * person), add the relationship so far, hand the facts to the model, store
 * the judgment against that thread state. Gmail is asked directly only for a
 * thread the store does not hold.
 *
 * Bounded: the top `max_candidates` by the detector's rank, so a mailbox with
 * hundreds of stalled threads costs a fixed number of model calls per sweep,
 * and unchanged threads cost none. A judgment that fails, for any reason,
 * leaves the arithmetic in charge of that item; the pass never throws.
 */

export type AgentDeps = {
  provider: ModelProvider;
  /** Fallback for a thread with nothing stored (older than the sync window). */
  content?: ThreadContentReader | undefined;
  /** Default 20. */
  max_candidates?: number;
};

export type AgentPassResult = {
  considered: number;
  assessed: number;
  reused: number;
  failed: number;
  model_alias: string | null;
};

export async function runAgentPass(
  deps: AgentDeps & { sql: Sql; contentKey: Buffer },
  ctx: UserContext,
  selfAddresses: readonly string[],
): Promise<AgentPassResult> {
  const max = deps.max_candidates ?? 20;
  const candidates = await listPendingObligations(deps.sql, ctx, max, { agent: false });
  const result: AgentPassResult = {
    considered: candidates.length,
    assessed: 0,
    reused: 0,
    failed: 0,
    model_alias: null,
  };
  for (const c of candidates) {
    if (c.assessment) {
      result.reused += 1;
      continue;
    }
    try {
      const content =
        (await storedThreadContent(deps, ctx, c.thread_id)) ??
        (deps.content
          ? await deps.content.read(
              { organization_id: ctx.organizationId, user_id: ctx.userId },
              c.thread_external_id,
              selfAddresses,
            )
          : null);
      if (!content || content.messages.length === 0) throw new Error("no content for thread");
      const history = await listContactThreads(deps.sql, ctx, c.contact_id, {
        exclude_thread_id: c.thread_id,
        limit: 10,
      });
      const input = toAssessmentInput(c, content.messages, history);
      const judged = await deps.provider.assessObligation(input);
      if (!judged.ok) throw new Error(judged.error);
      await upsertThreadAssessment(deps.sql, ctx, {
        thread_id: c.thread_id,
        assessed_last_message_at: c.thread_last_message_at,
        assessment: judged.value,
        model_alias: judged.usage.model_alias,
      });
      result.model_alias = judged.usage.model_alias;
      result.assessed += 1;
    } catch {
      // Content unreadable, model down, or output refused by the schema: the
      // item keeps its arithmetic rank and reason. Counted, not raised.
      result.failed += 1;
    }
  }
  return result;
}

function toAssessmentInput(
  c: PendingObligationRow,
  messages: AssessmentInput["messages"],
  history: Array<{
    subject: string;
    last_message_at: string;
    last_direction: "inbound" | "outbound";
    message_count: number;
  }>,
): AssessmentInput {
  const reason = c.reason as { days_elapsed?: number };
  return {
    history: history.map((h) => ({
      subject: h.subject.slice(0, 300),
      last_message_at: h.last_message_at,
      last_direction: h.last_direction,
      message_count: h.message_count,
    })),
    kind: c.kind,
    contact_display_name: c.contact_display_name.slice(0, 120),
    account_name: c.contact_account_name ? c.contact_account_name.slice(0, 120) : null,
    subject: c.subject.slice(0, 300),
    days_elapsed: reason.days_elapsed ?? 0,
    has_open_deal: c.has_open_deal,
    ...(c.open_deal_value !== null ? { open_deal_value: c.open_deal_value } : {}),
    ...(c.last_meeting_at ? { last_meeting_at: c.last_meeting_at } : {}),
    messages,
  };
}
