import type { Sql } from "postgres";
import {
  getThreadMessages,
  listOutboundFollowUps,
  listOutboundMessagesForContact,
  listRecentOutboundMessages,
  listUnmatchedDrafts,
  matchDraftToSent,
  type UserContext,
  listSentAfterDrafts,
  recordCorrection,
  threadContactAddress,
} from "@maman/db";
import { compareText } from "@maman/voice-engine";
import { decryptBody } from "./content.js";
import { stateIntent } from "./intents.js";

/**
 * VOICE: the person's own writing, retrieved for the draft at hand.
 *
 * Three shelves, most specific first. What they wrote to THIS contact. What
 * they wrote in THIS situation (their past follow-ups: a message that came
 * after their own message). And a sample of their recent writing. All from
 * the store, decrypted to the person, bounded. Each message sent from a
 * draft lands on these shelves on the next sync, so the voice converges.
 */

export type Voice = {
  to_this_contact: string[];
  similar_situations: string[];
  recent: string[];
};

const MAX_CHARS = 2000;

export async function voiceFor(
  deps: { sql: Sql; contentKey: Buffer },
  ctx: UserContext,
  contactId: string,
): Promise<Voice> {
  const open = (rows: { body_ciphertext: Uint8Array }[]) =>
    rows.map((r) => decryptBody(r.body_ciphertext, deps.contentKey, ctx).slice(0, MAX_CHARS));
  const [toContact, similar, recent, editedForContact, edited] = await Promise.all([
    listOutboundMessagesForContact(deps.sql, ctx, contactId, { limit: 3 }),
    listOutboundFollowUps(deps.sql, ctx, { limit: 3 }),
    listRecentOutboundMessages(deps.sql, ctx, { limit: 4, min_chars: 80 }),
    listSentAfterDrafts(deps.sql, ctx, { contact_id: contactId, limit: 2 }),
    listSentAfterDrafts(deps.sql, ctx, { limit: 2 }),
  ]);
  // What the person sent after editing a draft is the best example of what
  // they wanted. It goes first, and is not repeated below it.
  const dedupe = (first: typeof toContact, rest: typeof toContact) => [
    ...first,
    ...rest.filter((r) => !first.some((f) => f.external_id === r.external_id)),
  ];
  return {
    to_this_contact: open(dedupe(editedForContact, toContact)).slice(0, 4),
    similar_situations: open(similar),
    recent: open(dedupe(edited, recent)).slice(0, 5),
  };
}

// ---- edits as signal ----

/** Levenshtein distance, plain. Bodies are short; no need to be clever. */
export function editDistance(a: string, b: string): number {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i += 1) {
    const cur = [i];
    for (let j = 1; j <= b.length; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      cur[j] = Math.min(prev[j]! + 1, cur[j - 1]! + 1, prev[j - 1]! + cost);
    }
    prev = cur;
  }
  return prev[b.length]!;
}

const normalize = (s: string) =>
  s
    .replace(/\r\n/g, "\n")
    .replace(/[ \t]+/g, " ")
    .trim();

/** 1 means sent as written, 0 means nothing survived. */
export function similarity(draft: string, sent: string): number {
  const a = normalize(draft);
  const b = normalize(sent);
  const longest = Math.max(a.length, b.length);
  if (longest === 0) return 1;
  return Math.max(0, 1 - editDistance(a, b) / longest);
}

/**
 * After a sync: for each draft not yet matched, the first outbound message on
 * its thread sent after the draft was made is what the person actually sent.
 * Record how close it was. Runs inside the person's scope; decrypts nothing
 * it does not need.
 */
export type MatchedSent = { thread_id: string; sent_external_id: string; sent_at: string };

export async function matchSentDrafts(
  deps: { sql: Sql; contentKey: Buffer },
  ctx: UserContext,
): Promise<{ matched: number; items: MatchedSent[] }> {
  const pending = await listUnmatchedDrafts(deps.sql, ctx);
  let matched = 0;
  const items: MatchedSent[] = [];
  for (const d of pending) {
    const messages = await getThreadMessages(deps.sql, ctx, d.thread_id);
    const sent = messages.find(
      (m) => m.direction === "outbound" && Date.parse(m.sent_at) > Date.parse(d.created_at),
    );
    if (!sent) continue;
    const draftText = decryptBody(d.body_ciphertext, deps.contentKey, ctx);
    const sentText = decryptBody(sent.body_ciphertext, deps.contentKey, ctx);
    const ratio = similarity(draftText, sentText);
    await matchDraftToSent(deps.sql, ctx, d.id, {
      external_id: sent.external_id,
      sent_at: sent.sent_at,
      edit_ratio: ratio,
    });
    // What changed, as signals: the correction the agent learns from. The
    // texts stay where they are.
    const changed = compareText(draftText, sentText);
    await recordCorrection(deps.sql, ctx, {
      kind: "draft",
      ref_id: d.id,
      contact_address: await threadContactAddress(deps.sql, ctx, d.thread_id),
      signals: changed.signals,
      summary: { ...changed.summary, edit_ratio: ratio },
    });
    matched += 1;
    items.push({
      thread_id: d.thread_id,
      sent_external_id: sent.external_id,
      sent_at: sent.sent_at,
    });
    // A rewrite is the person telling the agent something. Written down,
    // scoped to the thread, not inferred into a rule.
    if (ratio < 0.5) {
      await stateIntent(
        deps,
        ctx,
        `Rewrote the agent's draft on "${d.subject}" (kept ${Math.round(ratio * 100)}% of it).`,
        "observed",
        { draft_id: d.id, thread_id: d.thread_id },
      );
    }
  }
  return { matched, items };
}
