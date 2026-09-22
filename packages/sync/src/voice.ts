import type { Sql } from "postgres";
import {
  getThreadMessages,
  listOutboundFollowUps,
  listOutboundMessagesForContact,
  listRecentOutboundMessages,
  listUnmatchedDrafts,
  matchDraftToSent,
  type UserContext,
} from "@maman/db";
import { decryptBody } from "./content.js";

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
  const [toContact, similar, recent] = await Promise.all([
    listOutboundMessagesForContact(deps.sql, ctx, contactId, { limit: 3 }),
    listOutboundFollowUps(deps.sql, ctx, { limit: 3 }),
    listRecentOutboundMessages(deps.sql, ctx, { limit: 4, min_chars: 80 }),
  ]);
  return {
    to_this_contact: open(toContact),
    similar_situations: open(similar),
    recent: open(recent),
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
export async function matchSentDrafts(
  deps: { sql: Sql; contentKey: Buffer },
  ctx: UserContext,
): Promise<{ matched: number }> {
  const pending = await listUnmatchedDrafts(deps.sql, ctx);
  let matched = 0;
  for (const d of pending) {
    const messages = await getThreadMessages(deps.sql, ctx, d.thread_id);
    const sent = messages.find(
      (m) => m.direction === "outbound" && Date.parse(m.sent_at) > Date.parse(d.created_at),
    );
    if (!sent) continue;
    const draftText = decryptBody(d.body_ciphertext, deps.contentKey, ctx);
    const sentText = decryptBody(sent.body_ciphertext, deps.contentKey, ctx);
    await matchDraftToSent(deps.sql, ctx, d.id, {
      external_id: sent.external_id,
      sent_at: sent.sent_at,
      edit_ratio: similarity(draftText, sentText),
    });
    matched += 1;
  }
  return { matched };
}
