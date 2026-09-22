import type { Sql } from "postgres";
import {
  envelopeDecrypt,
  envelopeEncrypt,
  packEnvelope,
  unpackEnvelope,
  type EnvelopeAad,
} from "@maman/connector-auth";
import type { ContentMessage, ProjectedMessage, ThreadContent } from "@maman/connector-adapters";
import {
  getThreadMessages,
  listRecentOutboundMessages,
  type SyncedMessage,
  type UserContext,
} from "@maman/db";

/**
 * MAIL CONTENT, ENCRYPTED TO THE PERSON.
 *
 * Bodies are the agent's input and they live in the database, but only as
 * ciphertext under an envelope whose AAD names the organization, the user and
 * this provider. The same master key that opens a person's mailbox token
 * opens their mail, and a row copied to a colleague's account fails to open.
 * Nothing here logs, returns to a client, or sends a body anywhere but the
 * model, and the model gets a bounded slice.
 */

const PROVIDER = "gmail_content";

const aadOf = (ctx: UserContext): EnvelopeAad => ({
  organization_id: ctx.organizationId,
  user_id: ctx.userId,
  provider: PROVIDER,
});

export function encryptBody(text: string, key: Buffer, ctx: UserContext): Uint8Array {
  return packEnvelope(envelopeEncrypt({ text }, key, aadOf(ctx)));
}

export function decryptBody(ciphertext: Uint8Array, key: Buffer, ctx: UserContext): string {
  const opened = envelopeDecrypt(unpackEnvelope(ciphertext), key, aadOf(ctx)) as { text?: unknown };
  return typeof opened.text === "string" ? opened.text : "";
}

/** A projected message, made storable. */
export function toSyncedMessage(m: ProjectedMessage, key: Buffer, ctx: UserContext): SyncedMessage {
  return {
    external_id: m.external_id,
    from_address: m.from_address,
    ...(m.from_display_name !== undefined ? { from_display_name: m.from_display_name } : {}),
    direction: m.direction,
    sent_at: m.sent_at,
    body_ciphertext: encryptBody(m.text, key, ctx),
    body_chars: m.text.length,
  };
}

/**
 * A thread's conversation from the store, in the agent's reading shape: the
 * last N messages, each bounded. Empty when nothing is stored for it.
 */
export async function storedThreadContent(
  deps: { sql: Sql; contentKey: Buffer },
  ctx: UserContext,
  threadId: string,
  opts: { max_messages?: number; max_chars?: number } = {},
): Promise<ThreadContent | null> {
  const rows = await getThreadMessages(deps.sql, ctx, threadId);
  if (rows.length === 0) return null;
  const maxMessages = opts.max_messages ?? 8;
  const maxChars = opts.max_chars ?? 4000;
  const messages: ContentMessage[] = rows.slice(-maxMessages).map((r) => ({
    from: r.from_display_name ?? r.from_address,
    direction: r.direction,
    sent_at: r.sent_at,
    text: decryptBody(r.body_ciphertext, deps.contentKey, ctx).slice(0, maxChars),
  }));
  return { external_id: threadId, messages };
}

/** The person's own recent writing, decrypted and bounded: their voice. */
export async function voiceExemplars(
  deps: { sql: Sql; contentKey: Buffer },
  ctx: UserContext,
  opts: { limit?: number; max_chars?: number } = {},
): Promise<string[]> {
  const rows = await listRecentOutboundMessages(deps.sql, ctx, {
    limit: opts.limit ?? 8,
  });
  return rows.map((r) =>
    decryptBody(r.body_ciphertext, deps.contentKey, ctx).slice(0, opts.max_chars ?? 2000),
  );
}
