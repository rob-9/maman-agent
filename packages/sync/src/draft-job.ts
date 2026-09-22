import type { Sql } from "postgres";
import {
  createGmailDraft,
  gmailContentReader,
  type HttpTransport,
  type UserCredentialProvider,
} from "@maman/connector-adapters";
import { getObligationForDraft, globalGetUserById, recordDraft, type UserContext } from "@maman/db";
import type { ContextComposer } from "@maman/voice-engine";
import { encryptBody, storedThreadContent } from "./content.js";
import { intentsFor } from "./intents.js";
import { meetingContext } from "./meetings.js";
import { voiceFor } from "./voice.js";

/**
 * THE DRAFT, as one job. A click and the sweep both come here, so a draft
 * written before being asked is built from exactly the same context as one
 * written on request: the stored conversation, the relationship, the deal,
 * the meetings, the agent's ask, the person's own instructions, their voice.
 *
 * It lands in Gmail Drafts and is recorded. Nothing is sent, ever. The
 * obligation stays pending with the draft attached until the person sends
 * it, snoozes the item, or says it is not needed.
 */

export type DraftJobDeps = {
  sql: Sql;
  contentKey: Buffer;
  credentials: UserCredentialProvider;
  transport: HttpTransport;
  composer: ContextComposer;
  now: () => Date;
};

export type DraftJobResult =
  | {
      ok: true;
      obligation_id: string;
      draft_id: string;
      message_id: string;
      to: string;
      subject: string;
      composer: "deterministic" | "model";
      fallback_reason?: string;
    }
  | { ok: false; reason: "not_found" | "no_thread_content" };

export async function runDraftJob(
  deps: DraftJobDeps,
  ctx: UserContext,
  obligationId: string,
  mode: "manual" | "auto",
): Promise<DraftJobResult> {
  const target = await getObligationForDraft(deps.sql, ctx, obligationId);
  if (!target) return { ok: false, reason: "not_found" };

  const key = { organization_id: ctx.organizationId, user_id: ctx.userId };
  const content =
    (await storedThreadContent(deps, ctx, target.thread.id)) ??
    (await gmailContentReader({ credentials: deps.credentials, transport: deps.transport }).read(
      key,
      target.thread.external_id,
      [],
    ));
  if (content.messages.length === 0) return { ok: false, reason: "no_thread_content" };

  const reason = target.reason as { days_elapsed?: number };
  const [sender, voice, meetings, preferences] = await Promise.all([
    globalGetUserById(deps.sql, ctx.userId),
    voiceFor(deps, ctx, target.contact.id),
    meetingContext(deps, ctx, target.contact.external_id, deps.now()),
    intentsFor(deps, ctx, {
      contact_address: target.contact.external_id,
      account_name: target.contact.account_name,
      kind: target.kind,
    }),
  ]);
  const draft = await deps.composer.compose({
    kind: target.kind,
    contact_display_name: target.contact.display_name,
    contact_address: target.contact.external_id,
    account_name: target.contact.account_name,
    subject: target.thread.subject,
    days_elapsed: reason.days_elapsed ?? 0,
    has_open_deal: target.facts.has_open_deal,
    ...(target.facts.open_deal_value !== null
      ? { open_deal_value: target.facts.open_deal_value }
      : {}),
    ...(target.facts.last_meeting_at ? { last_meeting_at: target.facts.last_meeting_at } : {}),
    ...meetings,
    sender_name: sender?.display_name ?? sender?.email ?? "me",
    sender_address: sender?.email ?? "",
    messages: content.messages.slice(-8),
    ...(target.assessment?.ask ? { ask: target.assessment.ask } : {}),
    ...(preferences.length > 0 ? { preferences } : {}),
    voice,
  });

  // A DRAFT. The scope cannot send; neither can this.
  const created = await createGmailDraft(
    { credentials: deps.credentials, transport: deps.transport },
    key,
    {
      to: draft.to,
      subject: draft.subject,
      body: draft.body,
      thread_id: target.thread.external_id,
    },
  );
  // Recorded AFTER Gmail confirmed, so the next sync can match it to what was sent.
  await recordDraft(deps.sql, ctx, {
    obligation_id: obligationId,
    thread_id: target.thread.id,
    gmail_draft_id: created.draft_id,
    gmail_message_id: created.message_id,
    mode,
    subject: draft.subject,
    body_ciphertext: encryptBody(draft.body, deps.contentKey, ctx),
    body_chars: draft.body.length,
    composer: draft.composer,
    model_alias: draft.model_alias,
    fallback_reason: draft.fallback_reason,
  });
  return {
    ok: true,
    obligation_id: obligationId,
    draft_id: created.draft_id,
    message_id: created.message_id,
    to: draft.to,
    subject: draft.subject,
    composer: draft.composer,
    ...(draft.fallback_reason ? { fallback_reason: draft.fallback_reason } : {}),
  };
}
