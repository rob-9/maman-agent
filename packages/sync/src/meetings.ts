import type { Sql } from "postgres";
import { listContactMeetings, type UserContext } from "@maman/db";
import { decryptBody } from "./content.js";

/**
 * What the agent gets to know about meetings with a contact: the last one
 * (title, when, the agenda if there was one) and the next one. Descriptions
 * are decrypted to the person and bounded. This is one of the agent's
 * inputs, alongside the thread, the relationship and the deal.
 */

export type MeetingContext = {
  last_meeting?: { title: string; at: string; notes?: string };
  next_meeting?: { title: string; at: string };
};

export async function meetingContext(
  deps: { sql: Sql; contentKey: Buffer },
  ctx: UserContext,
  contactAddress: string,
  now: Date,
): Promise<MeetingContext> {
  const rows = await listContactMeetings(deps.sql, ctx, contactAddress, { limit: 12 });
  const t = now.getTime();
  const past = rows.filter((m) => Date.parse(m.starts_at) < t);
  const future = rows
    .filter((m) => Date.parse(m.starts_at) >= t)
    .sort((a, b) => Date.parse(a.starts_at) - Date.parse(b.starts_at));
  const out: MeetingContext = {};
  const last = past[0];
  if (last) {
    const notes = last.description_ciphertext
      ? decryptBody(last.description_ciphertext, deps.contentKey, ctx).slice(0, 1500)
      : "";
    out.last_meeting = {
      title: last.title.slice(0, 200),
      at: last.starts_at,
      ...(notes ? { notes } : {}),
    };
  }
  const next = future[0];
  if (next) out.next_meeting = { title: next.title.slice(0, 200), at: next.starts_at };
  return out;
}
