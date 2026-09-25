import { and, desc, eq, gte, inArray, isNull, sql as rawSql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import type { Sql, TransactionSql } from "postgres";
import {
  containsForbiddenEventField,
  uuidv7,
  workflowEventSchema,
  type WorkflowEvent,
} from "@maman/contracts";
import * as schema from "./schema.js";
import { withUser, type UserContext } from "./tenant.js";

/**
 * The per-user workspace: what a connector synced, and what detection found.
 *
 * Every function here takes a `UserContext` and runs under `withUser`, so the
 * two-level RLS policy backs every filter. There is deliberately no org-scoped
 * entry point into these tables — see tenant.ts.
 *
 * SHAPES ARE STRUCTURAL, NOT IMPORTED. `loadDetectionInputs` returns rows in
 * exactly the field names `@maman/obligation-engine` consumes, without this
 * package depending on it. db stays a leaf; the detector stays pure; the sync
 * job that composes them lives in an app.
 */

const db = (tx: TransactionSql) => drizzle(tx as unknown as Sql, { schema });

/** One message's stored form. The body arrives already encrypted; see @maman/sync content.ts. */
export type SyncedMessage = {
  external_id: string;
  from_address: string;
  from_display_name?: string | undefined;
  direction: "inbound" | "outbound";
  sent_at: string;
  body_ciphertext: Uint8Array;
  body_chars: number;
};

/** A thread as a connector projected it. Mirrors ProjectedThread, structurally. */
export type SyncedThread = {
  external_id: string;
  history_id?: string | undefined;
  subject: string;
  last_message_at: string;
  last_direction: "inbound" | "outbound";
  message_count: number;
  chase_count?: number | undefined;
  contact: { address: string; display_name?: string | undefined };
  messages?: readonly SyncedMessage[] | undefined;
};

export type UpsertResult = { contacts: number; threads: number; messages: number };

/**
 * Writes what a sync produced. Idempotent: re-running with the same input
 * changes nothing, and a later run updates a thread in place.
 *
 * Contacts are keyed by (connection, address) — Gmail has no contact ids, so
 * the address IS the identity. A display name seen later overwrites a bare
 * address; a bare address never overwrites a name.
 */
export async function upsertSyncedThreads(
  sql: Sql,
  ctx: UserContext,
  input: { connection_id: string; threads: readonly SyncedThread[] },
): Promise<UpsertResult> {
  return withUser(sql, ctx, async (tx) => {
    const d = db(tx);

    // Contacts first, so threads can reference their ids.
    const addresses = [...new Set(input.threads.map((t) => t.contact.address))];
    const nameFor = new Map<string, string>();
    for (const t of input.threads) {
      if (t.contact.display_name) nameFor.set(t.contact.address, t.contact.display_name);
    }

    const contactIds = new Map<string, string>();
    for (const address of addresses) {
      const [row] = await d
        .insert(schema.contacts)
        .values({
          id: uuidv7(),
          organization_id: ctx.organizationId,
          owner_user_id: ctx.userId,
          connection_id: input.connection_id,
          external_id: address,
          display_name: nameFor.get(address) ?? address,
          // Unknown until a CRM says otherwise. NOT false — see 0009.
          has_open_deal: null,
        })
        .onConflictDoUpdate({
          target: [schema.contacts.connection_id, schema.contacts.external_id],
          set: {
            // Keep an existing real name; only a real name may replace it.
            display_name: nameFor.has(address)
              ? nameFor.get(address)!
              : rawSql`${schema.contacts.display_name}`,
            updated_at: rawSql`now()`,
          },
        })
        .returning({ id: schema.contacts.id });
      contactIds.set(address, row!.id);
    }

    let threadsWritten = 0;
    let messagesWritten = 0;
    for (const t of input.threads) {
      const [row] = await d
        .insert(schema.threads)
        .values({
          id: uuidv7(),
          organization_id: ctx.organizationId,
          owner_user_id: ctx.userId,
          connection_id: input.connection_id,
          contact_id: contactIds.get(t.contact.address)!,
          external_id: t.external_id,
          subject: t.subject,
          last_message_at: t.last_message_at,
          last_direction: t.last_direction,
          message_count: t.message_count,
          chase_count: t.chase_count ?? 0,
          history_id: t.history_id ?? null,
        })
        .onConflictDoUpdate({
          target: [schema.threads.connection_id, schema.threads.external_id],
          set: {
            subject: t.subject,
            last_message_at: t.last_message_at,
            last_direction: t.last_direction,
            message_count: t.message_count,
            chase_count: t.chase_count ?? 0,
            history_id: t.history_id ?? null,
            updated_at: rawSql`now()`,
          },
        })
        .returning({ id: schema.threads.id });
      threadsWritten += 1;

      // Content, encrypted before it got here. A message seen again replaces
      // its body (an edit to a draft that was later sent, a corrected fetch).
      for (const m of t.messages ?? []) {
        await d
          .insert(schema.messages)
          .values({
            id: uuidv7(),
            organization_id: ctx.organizationId,
            owner_user_id: ctx.userId,
            thread_id: row!.id,
            external_id: m.external_id,
            from_address: m.from_address,
            from_display_name: m.from_display_name ?? null,
            direction: m.direction,
            sent_at: m.sent_at,
            body_ciphertext: m.body_ciphertext,
            body_chars: m.body_chars,
          })
          .onConflictDoUpdate({
            target: [schema.messages.thread_id, schema.messages.external_id],
            set: {
              from_address: m.from_address,
              from_display_name: m.from_display_name ?? null,
              direction: m.direction,
              sent_at: m.sent_at,
              body_ciphertext: m.body_ciphertext,
              body_chars: m.body_chars,
              updated_at: rawSql`now()`,
            },
          });
        messagesWritten += 1;
      }
    }

    return { contacts: contactIds.size, threads: threadsWritten, messages: messagesWritten };
  });
}

/** Rows shaped exactly as the obligation engine's `Thread` and `Contact`. */
export type DetectionInputs = {
  threads: Array<{
    thread_id: string;
    contact_id: string;
    subject: string;
    last_message_at: string;
    last_direction: "inbound" | "outbound";
    message_count: number;
    chase_count: number;
  }>;
  contacts: Array<{
    contact_id: string;
    /** The mailbox address; the key a person's own rules are scoped by. */
    address: string;
    display_name: string;
    account_name?: string;
    open_deal_value?: number;
    has_open_deal: boolean | null;
    last_meeting_at?: string;
    next_meeting_at?: string;
  }>;
};

export async function loadDetectionInputs(sql: Sql, ctx: UserContext): Promise<DetectionInputs> {
  return withUser(sql, ctx, async (tx) => {
    const d = db(tx);
    // Ordered, so two reads of the same workspace return the same list. The
    // detector re-sorts anyway; this is for callers and tests that index in.
    const threadRows = await d
      .select()
      .from(schema.threads)
      .orderBy(desc(schema.threads.last_message_at), schema.threads.id);
    const contactRows = await d.select().from(schema.contacts).orderBy(schema.contacts.id);
    return {
      threads: threadRows.map((r) => ({
        thread_id: r.id,
        contact_id: r.contact_id,
        subject: r.subject,
        last_message_at: new Date(r.last_message_at).toISOString(),
        last_direction: r.last_direction,
        message_count: r.message_count,
        chase_count: r.chase_count,
      })),
      contacts: contactRows.map((r) => ({
        contact_id: r.id,
        address: r.external_id,
        display_name: r.display_name,
        ...(r.account_name !== null ? { account_name: r.account_name } : {}),
        ...(r.open_deal_value !== null ? { open_deal_value: Number(r.open_deal_value) } : {}),
        has_open_deal: r.has_open_deal,
        ...(r.last_meeting_at !== null
          ? { last_meeting_at: new Date(r.last_meeting_at).toISOString() }
          : {}),
        ...(r.next_meeting_at !== null
          ? { next_meeting_at: new Date(r.next_meeting_at).toISOString() }
          : {}),
      })),
    };
  });
}

/** external_id → history_id for this connection, so an unchanged thread is not fetched again. */
export async function listThreadHistoryIds(
  sql: Sql,
  ctx: UserContext,
  connectionId: string,
): Promise<Map<string, string>> {
  return withUser(sql, ctx, async (tx) => {
    const rows = await db(tx)
      .select({ external_id: schema.threads.external_id, history_id: schema.threads.history_id })
      .from(schema.threads)
      .where(eq(schema.threads.connection_id, connectionId));
    const map = new Map<string, string>();
    for (const r of rows) if (r.history_id) map.set(r.external_id, r.history_id);
    return map;
  });
}

export type StoredMessageRow = {
  external_id: string;
  from_address: string;
  from_display_name: string | null;
  direction: "inbound" | "outbound";
  sent_at: string;
  body_ciphertext: Uint8Array;
  body_chars: number;
};

/** A thread's stored messages, oldest first. Ciphertext; the caller decrypts. */
export async function getThreadMessages(
  sql: Sql,
  ctx: UserContext,
  threadId: string,
): Promise<StoredMessageRow[]> {
  return withUser(sql, ctx, async (tx) => {
    const rows = await db(tx)
      .select({
        external_id: schema.messages.external_id,
        from_address: schema.messages.from_address,
        from_display_name: schema.messages.from_display_name,
        direction: schema.messages.direction,
        sent_at: schema.messages.sent_at,
        body_ciphertext: schema.messages.body_ciphertext,
        body_chars: schema.messages.body_chars,
      })
      .from(schema.messages)
      .where(eq(schema.messages.thread_id, threadId))
      .orderBy(schema.messages.sent_at, schema.messages.external_id);
    return rows.map((r) => ({ ...r, sent_at: new Date(r.sent_at).toISOString() }));
  });
}

export type ContactThreadRow = {
  thread_id: string;
  subject: string;
  last_message_at: string;
  last_direction: "inbound" | "outbound";
  message_count: number;
};

/** The relationship so far: this person's other threads with the same contact, newest first. */
export async function listContactThreads(
  sql: Sql,
  ctx: UserContext,
  contactId: string,
  opts: { exclude_thread_id?: string; limit?: number } = {},
): Promise<ContactThreadRow[]> {
  return withUser(sql, ctx, async (tx) => {
    const rows = await db(tx)
      .select({
        thread_id: schema.threads.id,
        subject: schema.threads.subject,
        last_message_at: schema.threads.last_message_at,
        last_direction: schema.threads.last_direction,
        message_count: schema.threads.message_count,
      })
      .from(schema.threads)
      .where(eq(schema.threads.contact_id, contactId))
      .orderBy(desc(schema.threads.last_message_at), schema.threads.id)
      .limit((opts.limit ?? 10) + 1);
    return rows
      .filter((r) => r.thread_id !== opts.exclude_thread_id)
      .slice(0, opts.limit ?? 10)
      .map((r) => ({ ...r, last_message_at: new Date(r.last_message_at).toISOString() }));
  });
}

/**
 * The person's own recent messages of some substance: the raw material for
 * their voice. Ciphertext; the caller decrypts. Bounded by count.
 */
export async function listRecentOutboundMessages(
  sql: Sql,
  ctx: UserContext,
  opts: { limit?: number; min_chars?: number } = {},
): Promise<StoredMessageRow[]> {
  return withUser(sql, ctx, async (tx) => {
    const rows = await db(tx)
      .select({
        external_id: schema.messages.external_id,
        from_address: schema.messages.from_address,
        from_display_name: schema.messages.from_display_name,
        direction: schema.messages.direction,
        sent_at: schema.messages.sent_at,
        body_ciphertext: schema.messages.body_ciphertext,
        body_chars: schema.messages.body_chars,
      })
      .from(schema.messages)
      .where(
        and(
          eq(schema.messages.direction, "outbound"),
          gte(schema.messages.body_chars, opts.min_chars ?? 80),
        ),
      )
      .orderBy(desc(schema.messages.sent_at))
      .limit(opts.limit ?? 12);
    return rows.map((r) => ({ ...r, sent_at: new Date(r.sent_at).toISOString() }));
  });
}

/** The person's own messages to ONE contact, newest first: the closest thing to their voice with this person. */
export async function listOutboundMessagesForContact(
  sql: Sql,
  ctx: UserContext,
  contactId: string,
  opts: { limit?: number; min_chars?: number } = {},
): Promise<StoredMessageRow[]> {
  return withUser(sql, ctx, async (tx) => {
    const rows = await db(tx)
      .select({
        external_id: schema.messages.external_id,
        from_address: schema.messages.from_address,
        from_display_name: schema.messages.from_display_name,
        direction: schema.messages.direction,
        sent_at: schema.messages.sent_at,
        body_ciphertext: schema.messages.body_ciphertext,
        body_chars: schema.messages.body_chars,
      })
      .from(schema.messages)
      .innerJoin(schema.threads, eq(schema.threads.id, schema.messages.thread_id))
      .where(
        and(
          eq(schema.threads.contact_id, contactId),
          eq(schema.messages.direction, "outbound"),
          gte(schema.messages.body_chars, opts.min_chars ?? 40),
        ),
      )
      .orderBy(desc(schema.messages.sent_at))
      .limit(opts.limit ?? 3);
    return rows.map((r) => ({ ...r, sent_at: new Date(r.sent_at).toISOString() }));
  });
}

/**
 * The person's past follow-ups: outbound messages whose immediately
 * preceding message in the thread was also theirs. That is what a chase
 * looks like, and it is the situation a follow-up draft is written for.
 */
export async function listOutboundFollowUps(
  sql: Sql,
  ctx: UserContext,
  opts: { limit?: number; min_chars?: number } = {},
): Promise<StoredMessageRow[]> {
  return withUser(sql, ctx, async (tx) => {
    const rows = await tx<
      Array<{
        external_id: string;
        from_address: string;
        from_display_name: string | null;
        direction: "inbound" | "outbound";
        sent_at: Date;
        body_ciphertext: Uint8Array;
        body_chars: number;
      }>
    >`
      SELECT external_id, from_address, from_display_name, direction, sent_at, body_ciphertext, body_chars
      FROM (
        SELECT m.*, LAG(m.direction) OVER (PARTITION BY m.thread_id ORDER BY m.sent_at, m.external_id) AS prev
        FROM messages m
      ) x
      WHERE direction = 'outbound' AND prev = 'outbound' AND body_chars >= ${opts.min_chars ?? 40}
      ORDER BY sent_at DESC
      LIMIT ${opts.limit ?? 3}
    `;
    return rows.map((r) => ({ ...r, sent_at: new Date(r.sent_at).toISOString() }));
  });
}

// ---------- drafts: what the agent wrote, and what was sent ----------

export type DraftRecord = {
  id: string;
  obligation_id: string | null;
  thread_id: string;
  gmail_draft_id: string;
  subject: string;
  body_ciphertext: Uint8Array;
  body_chars: number;
  composer: "deterministic" | "model";
  created_at: string;
};

export async function recordDraft(
  sql: Sql,
  ctx: UserContext,
  input: {
    obligation_id: string;
    thread_id: string;
    gmail_draft_id: string;
    gmail_message_id?: string | undefined;
    mode?: "manual" | "auto" | undefined;
    subject: string;
    body_ciphertext: Uint8Array;
    body_chars: number;
    composer: "deterministic" | "model";
    model_alias?: string | undefined;
    fallback_reason?: string | undefined;
  },
): Promise<{ id: string }> {
  return withUser(sql, ctx, async (tx) => {
    const [row] = await db(tx)
      .insert(schema.drafts)
      .values({
        id: uuidv7(),
        organization_id: ctx.organizationId,
        owner_user_id: ctx.userId,
        obligation_id: input.obligation_id,
        thread_id: input.thread_id,
        gmail_draft_id: input.gmail_draft_id,
        gmail_message_id: input.gmail_message_id ?? null,
        mode: input.mode ?? "manual",
        subject: input.subject,
        body_ciphertext: input.body_ciphertext,
        body_chars: input.body_chars,
        composer: input.composer,
        model_alias: input.model_alias ?? null,
        fallback_reason: input.fallback_reason ?? null,
      })
      .returning({ id: schema.drafts.id });
    return { id: row!.id };
  });
}

/** Drafts not yet matched to a sent message, oldest first. */
export async function listUnmatchedDrafts(sql: Sql, ctx: UserContext): Promise<DraftRecord[]> {
  return withUser(sql, ctx, async (tx) => {
    const rows = await db(tx)
      .select({
        id: schema.drafts.id,
        obligation_id: schema.drafts.obligation_id,
        thread_id: schema.drafts.thread_id,
        gmail_draft_id: schema.drafts.gmail_draft_id,
        subject: schema.drafts.subject,
        body_ciphertext: schema.drafts.body_ciphertext,
        body_chars: schema.drafts.body_chars,
        composer: schema.drafts.composer,
        created_at: schema.drafts.created_at,
      })
      .from(schema.drafts)
      .where(isNull(schema.drafts.matched_at))
      .orderBy(schema.drafts.created_at);
    return rows.map((r) => ({ ...r, created_at: new Date(r.created_at).toISOString() }));
  });
}

export async function matchDraftToSent(
  sql: Sql,
  ctx: UserContext,
  draftId: string,
  sent: { external_id: string; sent_at: string; edit_ratio: number },
): Promise<void> {
  await withUser(sql, ctx, async (tx) => {
    await db(tx)
      .update(schema.drafts)
      .set({
        sent_external_id: sent.external_id,
        sent_at: sent.sent_at,
        edit_ratio: String(Math.max(0, Math.min(1, sent.edit_ratio)).toFixed(3)),
        matched_at: rawSql`now()`,
      })
      .where(eq(schema.drafts.id, draftId));
  });
}

/** How the agent's drafts fared, for this person: the product's own measure of its voice. */
export async function draftOutcomes(
  sql: Sql,
  ctx: UserContext,
  opts: { since?: Date } = {},
): Promise<{
  drafted: number;
  sent: number;
  sent_as_written: number;
  mean_edit_ratio: number | null;
}> {
  return withUser(sql, ctx, async (tx) => {
    const since = (opts.since ?? new Date(0)).toISOString();
    const [row] = await tx<
      Array<{
        drafted: number;
        sent: number;
        sent_as_written: number;
        mean_edit_ratio: string | null;
      }>
    >`
      SELECT count(*)::int AS drafted,
             count(matched_at)::int AS sent,
             count(*) FILTER (WHERE edit_ratio >= 0.9)::int AS sent_as_written,
             avg(edit_ratio) AS mean_edit_ratio
      FROM drafts
      WHERE created_at >= ${since}::timestamptz
    `;
    return {
      drafted: row!.drafted,
      sent: row!.sent,
      sent_as_written: row!.sent_as_written,
      mean_edit_ratio: row!.mean_edit_ratio === null ? null : Number(row!.mean_edit_ratio),
    };
  });
}

// ---------- meetings ----------

/** A meeting as the calendar projected it, description already encrypted. */
export type SyncedMeeting = {
  external_id: string;
  title: string;
  description_ciphertext: Uint8Array | null;
  description_chars: number;
  starts_at: string;
  ends_at: string;
  all_day: boolean;
  organizer_address: string | null;
  attendees: Array<{
    address: string;
    display_name?: string | undefined;
    response?: string | undefined;
  }>;
  self_response: "accepted" | "tentative" | "declined" | "needsAction";
  status: "confirmed" | "tentative" | "cancelled";
};

export async function upsertSyncedMeetings(
  sql: Sql,
  ctx: UserContext,
  input: {
    connection_id: string;
    meetings: readonly SyncedMeeting[];
    cancelled?: readonly string[];
  },
): Promise<{ meetings: number; cancelled: number }> {
  return withUser(sql, ctx, async (tx) => {
    const d = db(tx);
    let written = 0;
    for (const m of input.meetings) {
      await d
        .insert(schema.meetings)
        .values({
          id: uuidv7(),
          organization_id: ctx.organizationId,
          owner_user_id: ctx.userId,
          connection_id: input.connection_id,
          external_id: m.external_id,
          title: m.title,
          description_ciphertext: m.description_ciphertext,
          description_chars: m.description_chars,
          starts_at: m.starts_at,
          ends_at: m.ends_at,
          all_day: m.all_day,
          organizer_address: m.organizer_address,
          attendees: m.attendees,
          self_response: m.self_response,
          status: m.status,
        })
        .onConflictDoUpdate({
          target: [schema.meetings.connection_id, schema.meetings.external_id],
          set: {
            title: m.title,
            description_ciphertext: m.description_ciphertext,
            description_chars: m.description_chars,
            starts_at: m.starts_at,
            ends_at: m.ends_at,
            all_day: m.all_day,
            organizer_address: m.organizer_address,
            attendees: m.attendees,
            self_response: m.self_response,
            status: m.status,
            updated_at: rawSql`now()`,
          },
        });
      written += 1;
    }
    // Google reports a cancelled event with its id and little else; the row
    // we already hold is marked, not rewritten from a shell.
    let cancelled = 0;
    for (const id of input.cancelled ?? []) {
      const rows = await d
        .update(schema.meetings)
        .set({ status: "cancelled", updated_at: rawSql`now()` })
        .where(
          and(
            eq(schema.meetings.connection_id, input.connection_id),
            eq(schema.meetings.external_id, id),
          ),
        )
        .returning({ id: schema.meetings.id });
      cancelled += rows.length;
    }
    return { meetings: written, cancelled };
  });
}

/**
 * Puts the last and next meeting with each contact onto the contact row.
 * A meeting counts when it is not cancelled and the person did not decline.
 * One statement, under the person's scope.
 */
export async function refreshContactMeetingStamps(
  sql: Sql,
  ctx: UserContext,
  now: Date,
): Promise<{ contacts: number }> {
  return withUser(sql, ctx, async (tx) => {
    const at = now.toISOString();
    const rows = await tx<Array<{ id: string }>>`
      WITH stamps AS (
        SELECT c.id,
          (SELECT m.starts_at FROM meetings m
            WHERE m.status <> 'cancelled' AND m.self_response <> 'declined'
              AND m.attendees @> jsonb_build_array(jsonb_build_object('address', c.external_id))
              AND m.starts_at < ${at}::timestamptz
            ORDER BY m.starts_at DESC LIMIT 1) AS last_at,
          (SELECT m.title FROM meetings m
            WHERE m.status <> 'cancelled' AND m.self_response <> 'declined'
              AND m.attendees @> jsonb_build_array(jsonb_build_object('address', c.external_id))
              AND m.starts_at < ${at}::timestamptz
            ORDER BY m.starts_at DESC LIMIT 1) AS last_title,
          (SELECT m.starts_at FROM meetings m
            WHERE m.status <> 'cancelled' AND m.self_response <> 'declined'
              AND m.attendees @> jsonb_build_array(jsonb_build_object('address', c.external_id))
              AND m.starts_at >= ${at}::timestamptz
            ORDER BY m.starts_at ASC LIMIT 1) AS next_at,
          (SELECT m.title FROM meetings m
            WHERE m.status <> 'cancelled' AND m.self_response <> 'declined'
              AND m.attendees @> jsonb_build_array(jsonb_build_object('address', c.external_id))
              AND m.starts_at >= ${at}::timestamptz
            ORDER BY m.starts_at ASC LIMIT 1) AS next_title
        FROM contacts c
      )
      UPDATE contacts c
      SET last_meeting_at = s.last_at, last_meeting_title = s.last_title,
          next_meeting_at = s.next_at, next_meeting_title = s.next_title,
          updated_at = now()
      FROM stamps s
      WHERE c.id = s.id
        AND (c.last_meeting_at IS DISTINCT FROM s.last_at
          OR c.last_meeting_title IS DISTINCT FROM s.last_title
          OR c.next_meeting_at IS DISTINCT FROM s.next_at
          OR c.next_meeting_title IS DISTINCT FROM s.next_title)
      RETURNING c.id
    `;
    return { contacts: rows.length };
  });
}

export type ContactMeetingRow = {
  external_id: string;
  title: string;
  description_ciphertext: Uint8Array | null;
  starts_at: string;
  ends_at: string;
  status: "confirmed" | "tentative" | "cancelled";
  self_response: "accepted" | "tentative" | "declined" | "needsAction";
};

/** Meetings with one contact, newest first. Descriptions are ciphertext; the caller decrypts. */
export async function listContactMeetings(
  sql: Sql,
  ctx: UserContext,
  contactAddress: string,
  opts: { limit?: number } = {},
): Promise<ContactMeetingRow[]> {
  return withUser(sql, ctx, async (tx) => {
    const rows = await tx<
      Array<{
        external_id: string;
        title: string;
        description_ciphertext: Uint8Array | null;
        starts_at: Date;
        ends_at: Date;
        status: "confirmed" | "tentative" | "cancelled";
        self_response: "accepted" | "tentative" | "declined" | "needsAction";
      }>
    >`
      SELECT external_id, title, description_ciphertext, starts_at, ends_at, status, self_response
      FROM meetings
      WHERE status <> 'cancelled' AND self_response <> 'declined'
        AND attendees @> jsonb_build_array(jsonb_build_object('address', ${contactAddress}::text))
      ORDER BY starts_at DESC
      LIMIT ${opts.limit ?? 6}
    `;
    return rows.map((r) => ({
      ...r,
      starts_at: new Date(r.starts_at).toISOString(),
      ends_at: new Date(r.ends_at).toISOString(),
    }));
  });
}

export async function getCalendarSyncToken(
  sql: Sql,
  ctx: UserContext,
  connectionId: string,
): Promise<string | null> {
  return withUser(sql, ctx, async (tx) => {
    const [row] = await db(tx)
      .select({ token: schema.user_connections.calendar_sync_token })
      .from(schema.user_connections)
      .where(eq(schema.user_connections.id, connectionId));
    return row?.token ?? null;
  });
}

export async function setCalendarSyncToken(
  sql: Sql,
  ctx: UserContext,
  connectionId: string,
  token: string | null,
): Promise<void> {
  await withUser(sql, ctx, async (tx) => {
    await db(tx)
      .update(schema.user_connections)
      .set({ calendar_sync_token: token, updated_at: rawSql`now()` })
      .where(eq(schema.user_connections.id, connectionId));
  });
}

/** This person's contact addresses — the question to put to a CRM. */
export async function listContactAddresses(sql: Sql, ctx: UserContext): Promise<string[]> {
  return withUser(sql, ctx, async (tx) => {
    const rows = await db(tx)
      .select({ external_id: schema.contacts.external_id })
      .from(schema.contacts)
      .orderBy(schema.contacts.external_id);
    return rows.map((r) => r.external_id);
  });
}

/** What a CRM said about a contact. Mirrors DealSignal, structurally. */
export type DealSignalRow = {
  address: string;
  has_open_deal: boolean;
  open_deal_value?: number | undefined;
  account_name?: string | undefined;
};

export type DealApplyResult = { open: number; closed: number; unknown: number; untouched: number };

/**
 * Writes a CRM's answer onto this person's contacts.
 *
 * Every address ASKED is rewritten from the answer: the ones the CRM returned
 * as it returned them, and the rest back to UNKNOWN (null) — the CRM was
 * consulted and had nothing to say, which is not "closed" (see DealSignal).
 * That also means a deal the CRM stops reporting stops promoting. Addresses
 * NOT asked are left alone. An account name from the CRM fills a blank but
 * never overwrites one already held; the value is replaced wholesale, since
 * "open" and "how much" are one observation.
 */
export async function applyDealAnswer(
  sql: Sql,
  ctx: UserContext,
  answer: { asked: readonly string[]; signals: readonly DealSignalRow[] },
): Promise<DealApplyResult> {
  return withUser(sql, ctx, async (tx) => {
    const d = db(tx);
    const byAddress = new Map(answer.signals.map((s) => [s.address, s]));
    const result: DealApplyResult = { open: 0, closed: 0, unknown: 0, untouched: 0 };
    for (const address of new Set(answer.asked)) {
      const signal = byAddress.get(address);
      const state = signal ? signal.has_open_deal : null;
      const updated = await d
        .update(schema.contacts)
        .set({
          has_open_deal: state,
          open_deal_value:
            state === true && signal?.open_deal_value !== undefined
              ? String(signal.open_deal_value)
              : null,
          ...(signal?.account_name
            ? {
                account_name: rawSql`COALESCE(${schema.contacts.account_name}, ${signal.account_name})`,
              }
            : {}),
          updated_at: rawSql`now()`,
        })
        .where(eq(schema.contacts.external_id, address))
        .returning({ id: schema.contacts.id });
      if (updated.length === 0) result.untouched += 1;
      else if (state === true) result.open += 1;
      else if (state === false) result.closed += 1;
      else result.unknown += 1;
    }
    return result;
  });
}

/** An obligation as the engine emits it. Mirrors `Obligation`, structurally. */
export type DetectedObligation = {
  thread_id: string;
  contact_id: string;
  kind: "awaiting_you" | "awaiting_them" | "unsent_followup";
  rank: number;
  reason: unknown;
};

/**
 * Replaces this user's PENDING obligations with a fresh detection.
 *
 * Only pending rows are rewritten. A thread the user snoozed, dismissed or
 * drafted keeps that outcome — UNIQUE(thread_id) makes the re-insert a no-op
 * for it — so a sweep can never re-surface something the person already
 * decided about. That is the difference between a reminder and a nag.
 */
export async function replacePendingObligations(
  sql: Sql,
  ctx: UserContext,
  detected: readonly DetectedObligation[],
  detectedAt: Date,
  /** Detections the person's own rules set aside; stored as `skipped`, rewritten like pending. */
  skipped: readonly { obligation: DetectedObligation; intent_id: string }[] = [],
): Promise<{ written: number; kept_decided: number; skipped: number }> {
  return withUser(sql, ctx, async (tx) => {
    const d = db(tx);
    await d
      .delete(schema.obligations)
      .where(inArray(schema.obligations.outcome, ["pending", "skipped"]));
    // A decision holds for the thread as it was. Once the thread moves (they
    // replied, the person wrote again), "not needed" or "later" was about
    // something else, and the detector gets to look again.
    await tx`
      DELETE FROM obligations o
      USING threads t
      WHERE t.id = o.thread_id
        AND o.outcome IN ('drafted', 'snoozed', 'dismissed', 'resolved')
        AND t.last_message_at > o.updated_at
    `;

    const insert = async (
      o: DetectedObligation,
      outcome: "pending" | "skipped",
      intentId?: string,
    ) => {
      const rows = await d
        .insert(schema.obligations)
        .values({
          id: uuidv7(),
          organization_id: ctx.organizationId,
          owner_user_id: ctx.userId,
          thread_id: o.thread_id,
          contact_id: o.contact_id,
          kind: o.kind,
          rank: String(o.rank),
          reason: o.reason,
          outcome,
          applied_intent_id: intentId ?? null,
          detected_at: detectedAt.toISOString(),
        })
        .onConflictDoNothing({ target: schema.obligations.thread_id })
        .returning({ id: schema.obligations.id });
      return rows.length;
    };
    let written = 0;
    for (const o of detected) written += await insert(o, "pending");
    let skippedWritten = 0;
    for (const s of skipped) skippedWritten += await insert(s.obligation, "skipped", s.intent_id);
    return { written, kept_decided: detected.length - written, skipped: skippedWritten };
  });
}

export type SkippedObligationRow = {
  id: string;
  thread_id: string;
  kind: "awaiting_you" | "awaiting_them" | "unsent_followup";
  subject: string;
  contact_display_name: string;
  applied_intent_id: string | null;
};

/** What the person's own rules set aside, so the product can say so. */
export async function listSkippedObligations(
  sql: Sql,
  ctx: UserContext,
  limit = 20,
): Promise<SkippedObligationRow[]> {
  return withUser(sql, ctx, async (tx) => {
    return db(tx)
      .select({
        id: schema.obligations.id,
        thread_id: schema.obligations.thread_id,
        kind: schema.obligations.kind,
        subject: schema.threads.subject,
        contact_display_name: schema.contacts.display_name,
        applied_intent_id: schema.obligations.applied_intent_id,
      })
      .from(schema.obligations)
      .innerJoin(schema.threads, eq(schema.threads.id, schema.obligations.thread_id))
      .innerJoin(schema.contacts, eq(schema.contacts.id, schema.obligations.contact_id))
      .where(eq(schema.obligations.outcome, "skipped"))
      .orderBy(desc(schema.obligations.rank), schema.obligations.thread_id)
      .limit(limit);
  });
}

// ---------- actions: writes to a system of record ----------

export type ActionStatus =
  "proposed" | "approved" | "applied" | "verified" | "failed" | "stale" | "declined" | "reverted";

export type ActionRow = {
  id: string;
  kind: string;
  status: ActionStatus;
  thread_id: string | null;
  contact_id: string | null;
  message_external_id: string | null;
  diff: unknown;
  diff_sha256: string;
  shape_sha256: string;
  evidence: unknown;
  idempotency_key: string;
  approved_by: "user" | "promotion" | null;
  approved_at: string | null;
  applied_at: string | null;
  external_id: string | null;
  verification: unknown;
  verified_at: string | null;
  revert: unknown;
  reverted_at: string | null;
  error: string | null;
  created_at: string;
};

const iso = (d: Date | string | null): string | null => (d ? new Date(d).toISOString() : null);

function toActionRow(r: typeof schema.actions.$inferSelect): ActionRow {
  return {
    id: r.id,
    kind: r.kind,
    status: r.status,
    thread_id: r.thread_id,
    contact_id: r.contact_id,
    message_external_id: r.message_external_id,
    diff: r.diff,
    diff_sha256: r.diff_sha256,
    shape_sha256: r.shape_sha256,
    evidence: r.evidence,
    idempotency_key: r.idempotency_key,
    approved_by: r.approved_by,
    approved_at: iso(r.approved_at),
    applied_at: iso(r.applied_at),
    external_id: r.external_id,
    verification: r.verification,
    verified_at: iso(r.verified_at),
    revert: r.revert,
    reverted_at: iso(r.reverted_at),
    error: r.error,
    created_at: new Date(r.created_at).toISOString(),
  };
}

export async function createAction(
  sql: Sql,
  ctx: UserContext,
  input: {
    kind: string;
    thread_id?: string | null;
    contact_id?: string | null;
    message_external_id?: string | null;
    diff: unknown;
    diff_sha256: string;
    shape_sha256: string;
    evidence: unknown;
    idempotency_key: string;
  },
): Promise<ActionRow> {
  return withUser(sql, ctx, async (tx) => {
    const [row] = await db(tx)
      .insert(schema.actions)
      .values({
        id: uuidv7(),
        organization_id: ctx.organizationId,
        owner_user_id: ctx.userId,
        kind: input.kind,
        status: "proposed",
        thread_id: input.thread_id ?? null,
        contact_id: input.contact_id ?? null,
        message_external_id: input.message_external_id ?? null,
        diff: input.diff,
        diff_sha256: input.diff_sha256,
        shape_sha256: input.shape_sha256,
        evidence: input.evidence,
        idempotency_key: input.idempotency_key,
      })
      .returning();
    return toActionRow(row!);
  });
}

export async function getAction(sql: Sql, ctx: UserContext, id: string): Promise<ActionRow | null> {
  return withUser(sql, ctx, async (tx) => {
    const [row] = await db(tx).select().from(schema.actions).where(eq(schema.actions.id, id));
    return row ? toActionRow(row) : null;
  });
}

/** An action already proposed or done for this message and kind, so a sweep never proposes it twice. */
export async function findActionForMessage(
  sql: Sql,
  ctx: UserContext,
  kind: string,
  messageExternalId: string,
): Promise<ActionRow | null> {
  return withUser(sql, ctx, async (tx) => {
    const [row] = await db(tx)
      .select()
      .from(schema.actions)
      .where(
        and(
          eq(schema.actions.kind, kind),
          eq(schema.actions.message_external_id, messageExternalId),
        ),
      )
      .orderBy(desc(schema.actions.created_at))
      .limit(1);
    return row ? toActionRow(row) : null;
  });
}

export async function listActions(
  sql: Sql,
  ctx: UserContext,
  opts: { limit?: number } = {},
): Promise<ActionRow[]> {
  return withUser(sql, ctx, async (tx) => {
    const rows = await db(tx)
      .select()
      .from(schema.actions)
      .orderBy(desc(schema.actions.created_at))
      .limit(opts.limit ?? 50);
    return rows.map(toActionRow);
  });
}

/**
 * Moves an action forward. `from` guards the transition: an approve on a
 * row that is no longer proposed, or an apply on one that is no longer
 * approved, changes nothing and returns null. That is the exactly-once
 * discipline at the ledger.
 */
export async function transitionAction(
  sql: Sql,
  ctx: UserContext,
  id: string,
  from: readonly ActionStatus[],
  set: Partial<{
    status: ActionStatus;
    approved_by: "user" | "promotion";
    approved_at: string;
    applied_at: string;
    external_id: string;
    verification: unknown;
    verified_at: string;
    revert: unknown;
    reverted_at: string;
    error: string | null;
  }>,
): Promise<ActionRow | null> {
  return withUser(sql, ctx, async (tx) => {
    const [row] = await db(tx)
      .update(schema.actions)
      .set({ ...set, updated_at: rawSql`now()` })
      .where(and(eq(schema.actions.id, id), inArray(schema.actions.status, [...from])))
      .returning();
    return row ? toActionRow(row) : null;
  });
}

// ---------- the intent store ----------

export type IntentRow = {
  id: string;
  text_ciphertext: Uint8Array;
  text_chars: number;
  source: "stated" | "observed" | "inferred";
  status: "active" | "proposed" | "retired";
  scope_kind: "global" | "contact" | "account" | "situation";
  scope_value: string | null;
  rule: unknown;
  origin: unknown;
  created_at: string;
};

export async function createIntent(
  sql: Sql,
  ctx: UserContext,
  input: {
    text_ciphertext: Uint8Array;
    text_chars: number;
    source: IntentRow["source"];
    status?: IntentRow["status"];
    scope_kind: IntentRow["scope_kind"];
    scope_value?: string | null;
    rule?: unknown;
    origin?: unknown;
  },
): Promise<{ id: string }> {
  return withUser(sql, ctx, async (tx) => {
    const [row] = await db(tx)
      .insert(schema.intents)
      .values({
        id: uuidv7(),
        organization_id: ctx.organizationId,
        owner_user_id: ctx.userId,
        text_ciphertext: input.text_ciphertext,
        text_chars: input.text_chars,
        source: input.source,
        status: input.status ?? "active",
        scope_kind: input.scope_kind,
        scope_value: input.scope_value ?? null,
        rule: input.rule ?? null,
        origin: input.origin ?? null,
      })
      .returning({ id: schema.intents.id });
    return { id: row!.id };
  });
}

/** Active entries, newest first. Ciphertext; the caller decrypts. */
export async function listIntents(
  sql: Sql,
  ctx: UserContext,
  opts: { status?: IntentRow["status"] | "all"; limit?: number } = {},
): Promise<IntentRow[]> {
  return withUser(sql, ctx, async (tx) => {
    const status = opts.status ?? "active";
    const rows = await db(tx)
      .select()
      .from(schema.intents)
      .where(status === "all" ? undefined : eq(schema.intents.status, status))
      .orderBy(desc(schema.intents.created_at))
      .limit(opts.limit ?? 100);
    return rows.map((r) => ({
      id: r.id,
      text_ciphertext: r.text_ciphertext,
      text_chars: r.text_chars,
      source: r.source,
      status: r.status,
      scope_kind: r.scope_kind,
      scope_value: r.scope_value,
      rule: r.rule,
      origin: r.origin,
      created_at: new Date(r.created_at).toISOString(),
    }));
  });
}

/** Retires an active entry, or declines a proposed one. Either way it is gone and never re-proposed. */
export async function retireIntent(sql: Sql, ctx: UserContext, id: string): Promise<boolean> {
  return withUser(sql, ctx, async (tx) => {
    const rows = await db(tx)
      .update(schema.intents)
      .set({ status: "retired", retired_at: rawSql`now()`, updated_at: rawSql`now()` })
      .where(and(eq(schema.intents.id, id), inArray(schema.intents.status, ["active", "proposed"])))
      .returning({ id: schema.intents.id });
    return rows.length === 1;
  });
}

/** The person keeps what the agent inferred: proposed → active. Only from proposed. */
export async function confirmIntent(sql: Sql, ctx: UserContext, id: string): Promise<boolean> {
  return withUser(sql, ctx, async (tx) => {
    const rows = await db(tx)
      .update(schema.intents)
      .set({ status: "active", updated_at: rawSql`now()` })
      .where(and(eq(schema.intents.id, id), eq(schema.intents.status, "proposed")))
      .returning({ id: schema.intents.id });
    return rows.length === 1;
  });
}

export type DecidedObligationRow = {
  kind: "awaiting_you" | "awaiting_them" | "unsent_followup";
  outcome: "drafted" | "snoozed" | "dismissed" | "resolved";
  days_elapsed: number;
  decided_at: string;
  contact_address: string;
  contact_display_name: string;
  contact_account_name: string | null;
};

/** What the person decided, with how old each item was when they did. */
export async function listDecidedObligations(
  sql: Sql,
  ctx: UserContext,
  opts: { since: Date },
): Promise<DecidedObligationRow[]> {
  return withUser(sql, ctx, async (tx) => {
    const rows = await tx<
      Array<{
        kind: DecidedObligationRow["kind"];
        outcome: DecidedObligationRow["outcome"];
        days_elapsed: number | null;
        decided_at: Date;
        contact_address: string;
        contact_display_name: string;
        contact_account_name: string | null;
      }>
    >`
      SELECT o.kind, o.outcome, (o.reason->>'days_elapsed')::int AS days_elapsed,
             o.updated_at AS decided_at,
             c.external_id AS contact_address, c.display_name AS contact_display_name,
             c.account_name AS contact_account_name
      FROM obligations o
      JOIN contacts c ON c.id = o.contact_id
      WHERE o.outcome IN ('drafted', 'snoozed', 'dismissed', 'resolved')
        AND o.updated_at >= ${opts.since.toISOString()}::timestamptz
      ORDER BY o.updated_at, o.id
    `;
    return rows.map((r) => ({
      kind: r.kind,
      outcome: r.outcome,
      days_elapsed: Number(r.days_elapsed ?? 0),
      decided_at: new Date(r.decided_at).toISOString(),
      contact_address: r.contact_address,
      contact_display_name: r.contact_display_name,
      contact_account_name: r.contact_account_name,
    }));
  });
}

/** What the agent said about a thread. Mirrors AssessmentOutput, structurally. */
export type ThreadAssessment = {
  owed: boolean;
  ask: string;
  summary: string;
  urgency: "high" | "normal" | "low";
  confidence: number;
};

export type PendingObligationRow = {
  id: string;
  thread_id: string;
  thread_external_id: string;
  thread_last_message_at: string;
  contact_id: string;
  kind: "awaiting_you" | "awaiting_them" | "unsent_followup";
  rank: number;
  reason: unknown;
  detected_at: string;
  subject: string;
  contact_display_name: string;
  contact_account_name: string | null;
  contact_address: string;
  has_open_deal: boolean | null;
  open_deal_value: number | null;
  last_meeting_at: string | null;
  last_meeting_title: string | null;
  next_meeting_at: string | null;
  next_meeting_title: string | null;
  /** Present when the agent has judged this thread in its current state. */
  assessment: ThreadAssessment | null;
  /** The draft waiting in Gmail for this thread, if one is. */
  draft: PendingDraft | null;
};

export type PendingDraft = {
  id: string;
  gmail_draft_id: string;
  gmail_message_id: string | null;
  composer: "deterministic" | "model";
  mode: "manual" | "auto";
  created_at: string;
};

const URGENCY_WEIGHT: Record<ThreadAssessment["urgency"], number> = { high: 2, normal: 1, low: 0 };

/**
 * The ranked list the UI shows. Most urgent first.
 *
 * With `agent: false` (the default) this is the detector's ranking and nothing
 * else — the assessment rides along for display but decides nothing. With
 * `agent: true` the agent's judgment narrows and reorders: an item it judged
 * not owed is left out, and urgency orders within the detector's rank. An
 * item with no judgment (never assessed, or the model failed) keeps its
 * arithmetic place. Switching the flag switches the list; nothing is lost.
 */
export async function listPendingObligations(
  sql: Sql,
  ctx: UserContext,
  limit = 50,
  opts: { agent?: boolean } = {},
): Promise<PendingObligationRow[]> {
  return withUser(sql, ctx, async (tx) => {
    const d = db(tx);
    const rows = await d
      .select({
        id: schema.obligations.id,
        thread_id: schema.obligations.thread_id,
        thread_external_id: schema.threads.external_id,
        thread_last_message_at: schema.threads.last_message_at,
        contact_id: schema.obligations.contact_id,
        kind: schema.obligations.kind,
        rank: schema.obligations.rank,
        reason: schema.obligations.reason,
        detected_at: schema.obligations.detected_at,
        subject: schema.threads.subject,
        contact_display_name: schema.contacts.display_name,
        contact_account_name: schema.contacts.account_name,
        contact_address: schema.contacts.external_id,
        has_open_deal: schema.contacts.has_open_deal,
        open_deal_value: schema.contacts.open_deal_value,
        last_meeting_at: schema.contacts.last_meeting_at,
        last_meeting_title: schema.contacts.last_meeting_title,
        next_meeting_at: schema.contacts.next_meeting_at,
        next_meeting_title: schema.contacts.next_meeting_title,
        assessment: schema.thread_assessments.assessment,
        assessed_last_message_at: schema.thread_assessments.assessed_last_message_at,
      })
      .from(schema.obligations)
      .innerJoin(schema.threads, eq(schema.threads.id, schema.obligations.thread_id))
      .innerJoin(schema.contacts, eq(schema.contacts.id, schema.obligations.contact_id))
      .leftJoin(
        schema.thread_assessments,
        eq(schema.thread_assessments.thread_id, schema.obligations.thread_id),
      )
      .where(and(eq(schema.obligations.outcome, "pending")))
      .orderBy(desc(schema.obligations.rank), schema.obligations.thread_id);

    const drafts = await unmatchedDraftsByThread(
      tx,
      rows.map((r) => r.thread_id),
    );
    const mapped = rows.map((r) => {
      // A judgment describes one thread state; a newer message makes it stale
      // and it is not shown (nor trusted) until the agent looks again.
      const fresh =
        r.assessment !== null &&
        r.assessed_last_message_at !== null &&
        new Date(r.assessed_last_message_at).getTime() >=
          new Date(r.thread_last_message_at).getTime();
      return {
        id: r.id,
        thread_id: r.thread_id,
        thread_external_id: r.thread_external_id,
        thread_last_message_at: new Date(r.thread_last_message_at).toISOString(),
        contact_id: r.contact_id,
        kind: r.kind,
        rank: Number(r.rank),
        reason: r.reason,
        detected_at: new Date(r.detected_at).toISOString(),
        subject: r.subject,
        contact_display_name: r.contact_display_name,
        contact_account_name: r.contact_account_name,
        contact_address: r.contact_address,
        has_open_deal: r.has_open_deal,
        open_deal_value: r.open_deal_value !== null ? Number(r.open_deal_value) : null,
        last_meeting_at: r.last_meeting_at ? new Date(r.last_meeting_at).toISOString() : null,
        last_meeting_title: r.last_meeting_title,
        next_meeting_at: r.next_meeting_at ? new Date(r.next_meeting_at).toISOString() : null,
        next_meeting_title: r.next_meeting_title,
        assessment: fresh ? (r.assessment as ThreadAssessment) : null,
        draft: drafts.get(r.thread_id) ?? null,
      };
    });

    if (!opts.agent) return mapped.slice(0, limit);
    return mapped
      .filter((o) => o.assessment === null || o.assessment.owed)
      .sort((a, b) => {
        const kindA = kindWeight(a.kind);
        const kindB = kindWeight(b.kind);
        if (kindA !== kindB) return kindB - kindA;
        const ua = a.assessment ? URGENCY_WEIGHT[a.assessment.urgency] : 1;
        const ub = b.assessment ? URGENCY_WEIGHT[b.assessment.urgency] : 1;
        if (ua !== ub) return ub - ua;
        return b.rank - a.rank || a.thread_id.localeCompare(b.thread_id);
      })
      .slice(0, limit);
  });
}

/** The newest unsent draft per thread, for the threads given. */
async function unmatchedDraftsByThread(
  tx: TransactionSql,
  threadIds: readonly string[],
): Promise<Map<string, PendingDraft>> {
  const out = new Map<string, PendingDraft>();
  if (threadIds.length === 0) return out;
  const rows = await db(tx)
    .select({
      id: schema.drafts.id,
      thread_id: schema.drafts.thread_id,
      gmail_draft_id: schema.drafts.gmail_draft_id,
      gmail_message_id: schema.drafts.gmail_message_id,
      composer: schema.drafts.composer,
      mode: schema.drafts.mode,
      created_at: schema.drafts.created_at,
    })
    .from(schema.drafts)
    .where(and(isNull(schema.drafts.matched_at), inArray(schema.drafts.thread_id, [...threadIds])))
    .orderBy(desc(schema.drafts.created_at));
  for (const r of rows) {
    if (out.has(r.thread_id)) continue;
    out.set(r.thread_id, {
      id: r.id,
      gmail_draft_id: r.gmail_draft_id,
      gmail_message_id: r.gmail_message_id,
      composer: r.composer,
      mode: r.mode,
      created_at: new Date(r.created_at).toISOString(),
    });
  }
  return out;
}

/** The detector's bands, so urgency reorders within a band and never across one. */
function kindWeight(kind: PendingObligationRow["kind"]): number {
  return kind === "awaiting_you" ? 3 : kind === "unsent_followup" ? 2 : 1;
}

/** Records the agent's judgment for the thread state it was made against. */
export async function upsertThreadAssessment(
  sql: Sql,
  ctx: UserContext,
  input: {
    thread_id: string;
    assessed_last_message_at: string;
    assessment: ThreadAssessment;
    model_alias: string;
  },
): Promise<void> {
  await withUser(sql, ctx, async (tx) => {
    await db(tx)
      .insert(schema.thread_assessments)
      .values({
        id: uuidv7(),
        organization_id: ctx.organizationId,
        owner_user_id: ctx.userId,
        thread_id: input.thread_id,
        assessed_last_message_at: input.assessed_last_message_at,
        assessment: input.assessment,
        model_alias: input.model_alias,
      })
      .onConflictDoUpdate({
        target: schema.thread_assessments.thread_id,
        set: {
          assessed_last_message_at: input.assessed_last_message_at,
          assessment: input.assessment,
          model_alias: input.model_alias,
          assessed_at: rawSql`now()`,
          updated_at: rawSql`now()`,
        },
      });
  });
}

// ---------- user connections (the per-user vault rows) ----------

export type UserConnectionRow = {
  id: string;
  provider: string;
  external_account_label: string;
  /** Packed envelope. Opaque here; the worker unpacks and decrypts it. */
  encrypted_credentials: Uint8Array;
  scopes: string[];
  status: "active" | "expired" | "revoked" | "error";
};

/** This user's active connection for a provider, or null. Never another user's. */
export async function getUserConnection(
  sql: Sql,
  ctx: UserContext,
  provider: string,
): Promise<UserConnectionRow | null> {
  return withUser(sql, ctx, async (tx) => {
    const [row] = await db(tx)
      .select()
      .from(schema.user_connections)
      .where(
        and(
          eq(schema.user_connections.provider, provider),
          eq(schema.user_connections.status, "active"),
        ),
      )
      .limit(1);
    if (!row) return null;
    return {
      id: row.id,
      provider: row.provider,
      external_account_label: row.external_account_label,
      encrypted_credentials: row.encrypted_credentials,
      scopes: row.scopes,
      status: row.status,
    };
  });
}

/** Re-persists a rotated credential envelope after a refresh. */
export async function updateUserConnectionCredentials(
  sql: Sql,
  ctx: UserContext,
  connectionId: string,
  encrypted: Uint8Array,
): Promise<void> {
  await withUser(sql, ctx, async (tx) => {
    await db(tx)
      .update(schema.user_connections)
      .set({
        encrypted_credentials: encrypted,
        status: "active",
        last_error: null,
        updated_at: rawSql`now()`,
      })
      .where(eq(schema.user_connections.id, connectionId));
  });
}

/** Records a sync outcome on the connection — success timestamp or the error. */
export async function markUserConnectionSync(
  sql: Sql,
  ctx: UserContext,
  connectionId: string,
  outcome: { ok: true; at: Date } | { ok: false; error: string; expired?: boolean },
): Promise<void> {
  await withUser(sql, ctx, async (tx) => {
    await db(tx)
      .update(schema.user_connections)
      .set(
        outcome.ok
          ? {
              last_synced_at: outcome.at.toISOString(),
              last_error: null,
              updated_at: rawSql`now()`,
            }
          : {
              last_error: outcome.error,
              status: outcome.expired ? "expired" : "error",
              updated_at: rawSql`now()`,
            },
      )
      .where(eq(schema.user_connections.id, connectionId));
  });
}

/** Creates a connection row. Credentials arrive already envelope-encrypted and packed. */
export async function createUserConnection(
  sql: Sql,
  ctx: UserContext,
  input: {
    provider: string;
    external_account_label: string;
    encrypted_credentials: Uint8Array;
    scopes: string[];
  },
): Promise<{ id: string }> {
  return withUser(sql, ctx, async (tx) => {
    const id = uuidv7();
    // One connection per (user, provider, label). Reconnecting replaces the
    // credentials rather than stacking a second row the sync would ignore.
    await db(tx)
      .insert(schema.user_connections)
      .values({
        id,
        organization_id: ctx.organizationId,
        owner_user_id: ctx.userId,
        provider: input.provider,
        external_account_label: input.external_account_label,
        encrypted_credentials: input.encrypted_credentials,
        scopes: input.scopes,
        status: "active",
      })
      .onConflictDoUpdate({
        target: [
          schema.user_connections.organization_id,
          schema.user_connections.owner_user_id,
          schema.user_connections.provider,
          schema.user_connections.external_account_label,
        ],
        set: {
          encrypted_credentials: input.encrypted_credentials,
          scopes: input.scopes,
          status: "active",
          last_error: null,
          updated_at: rawSql`now()`,
        },
      });
    const [row] = await db(tx)
      .select({ id: schema.user_connections.id })
      .from(schema.user_connections)
      .where(
        and(
          eq(schema.user_connections.provider, input.provider),
          eq(schema.user_connections.external_account_label, input.external_account_label),
        ),
      )
      .limit(1);
    return { id: row!.id };
  });
}

export type UserConnectionView = {
  id: string;
  provider: string;
  external_account_label: string;
  scopes: string[];
  status: "active" | "expired" | "revoked" | "error";
  last_synced_at: string | null;
  last_error: string | null;
};

/** Status views only. There is no function that returns a credential to a caller. */
export async function listUserConnections(
  sql: Sql,
  ctx: UserContext,
): Promise<UserConnectionView[]> {
  return withUser(sql, ctx, async (tx) => {
    const rows = await db(tx)
      .select({
        id: schema.user_connections.id,
        provider: schema.user_connections.provider,
        external_account_label: schema.user_connections.external_account_label,
        scopes: schema.user_connections.scopes,
        status: schema.user_connections.status,
        last_synced_at: schema.user_connections.last_synced_at,
        last_error: schema.user_connections.last_error,
      })
      .from(schema.user_connections)
      .orderBy(schema.user_connections.provider);
    return rows.map((r) => ({
      ...r,
      last_synced_at: r.last_synced_at ? new Date(r.last_synced_at).toISOString() : null,
    }));
  });
}

export type ObligationOutcome = "drafted" | "snoozed" | "dismissed" | "resolved";

/**
 * Records what the user did about an obligation. Returns false when no such
 * pending row is visible to this user — which is the same answer for "does
 * not exist" and "belongs to someone else", on purpose.
 */
export async function setObligationOutcome(
  sql: Sql,
  ctx: UserContext,
  obligationId: string,
  outcome: ObligationOutcome,
  snoozedUntil?: Date,
): Promise<boolean> {
  return withUser(sql, ctx, async (tx) => {
    const rows = await db(tx)
      .update(schema.obligations)
      .set({
        outcome,
        snoozed_until: outcome === "snoozed" && snoozedUntil ? snoozedUntil.toISOString() : null,
        updated_at: rawSql`now()`,
      })
      .where(
        and(eq(schema.obligations.id, obligationId), eq(schema.obligations.outcome, "pending")),
      )
      .returning({ id: schema.obligations.id });
    return rows.length === 1;
  });
}

export type ObligationForDraft = {
  obligation_id: string;
  kind: "awaiting_you" | "awaiting_them" | "unsent_followup";
  reason: unknown;
  thread: {
    id: string;
    external_id: string;
    subject: string;
    last_direction: "inbound" | "outbound";
  };
  contact: { id: string; external_id: string; display_name: string; account_name: string | null };
  connection_id: string;
  facts: {
    has_open_deal: boolean | null;
    open_deal_value: number | null;
    last_meeting_at: string | null;
    last_meeting_title: string | null;
    next_meeting_at: string | null;
    next_meeting_title: string | null;
  };
  assessment: ThreadAssessment | null;
};

/**
 * Everything a draft needs about ONE pending obligation, joined. Null when it
 * is missing, already decided, or someone else's — one answer for all three.
 */
export async function getObligationForDraft(
  sql: Sql,
  ctx: UserContext,
  obligationId: string,
): Promise<ObligationForDraft | null> {
  return withUser(sql, ctx, async (tx) => {
    const [row] = await db(tx)
      .select({
        obligation_id: schema.obligations.id,
        kind: schema.obligations.kind,
        reason: schema.obligations.reason,
        thread_id: schema.threads.id,
        thread_external_id: schema.threads.external_id,
        subject: schema.threads.subject,
        last_direction: schema.threads.last_direction,
        contact_id: schema.contacts.id,
        contact_external_id: schema.contacts.external_id,
        display_name: schema.contacts.display_name,
        account_name: schema.contacts.account_name,
        connection_id: schema.threads.connection_id,
        thread_last_message_at: schema.threads.last_message_at,
        has_open_deal: schema.contacts.has_open_deal,
        open_deal_value: schema.contacts.open_deal_value,
        last_meeting_at: schema.contacts.last_meeting_at,
        last_meeting_title: schema.contacts.last_meeting_title,
        next_meeting_at: schema.contacts.next_meeting_at,
        next_meeting_title: schema.contacts.next_meeting_title,
        assessment: schema.thread_assessments.assessment,
        assessed_last_message_at: schema.thread_assessments.assessed_last_message_at,
      })
      .from(schema.obligations)
      .innerJoin(schema.threads, eq(schema.threads.id, schema.obligations.thread_id))
      .innerJoin(schema.contacts, eq(schema.contacts.id, schema.obligations.contact_id))
      .leftJoin(
        schema.thread_assessments,
        eq(schema.thread_assessments.thread_id, schema.obligations.thread_id),
      )
      .where(
        and(eq(schema.obligations.id, obligationId), eq(schema.obligations.outcome, "pending")),
      )
      .limit(1);
    if (!row) return null;
    const fresh =
      row.assessment !== null &&
      row.assessed_last_message_at !== null &&
      new Date(row.assessed_last_message_at).getTime() >=
        new Date(row.thread_last_message_at).getTime();
    return {
      obligation_id: row.obligation_id,
      kind: row.kind,
      reason: row.reason,
      thread: {
        id: row.thread_id,
        external_id: row.thread_external_id,
        subject: row.subject,
        last_direction: row.last_direction,
      },
      contact: {
        id: row.contact_id,
        external_id: row.contact_external_id,
        display_name: row.display_name,
        account_name: row.account_name,
      },
      connection_id: row.connection_id,
      facts: {
        has_open_deal: row.has_open_deal,
        open_deal_value: row.open_deal_value !== null ? Number(row.open_deal_value) : null,
        last_meeting_at: row.last_meeting_at ? new Date(row.last_meeting_at).toISOString() : null,
        last_meeting_title: row.last_meeting_title,
        next_meeting_at: row.next_meeting_at ? new Date(row.next_meeting_at).toISOString() : null,
        next_meeting_title: row.next_meeting_title,
      },
      assessment: fresh ? (row.assessment as ThreadAssessment) : null,
    };
  });
}

// ---- the event stream: what the person did, derived from every source ----

/**
 * The facts the sweep derives events from. Ids and times only; the bodies
 * stay where they are. `since` narrows to rows written or changed after a
 * point, so a sweep re-derives only what moved; absent, it is a backfill
 * over the window.
 */
export type EventFacts = {
  messages: Array<{
    message_external_id: string;
    thread_external_id: string;
    direction: "inbound" | "outbound";
    sent_at: string;
    /** Position in the thread, 1-based, by time. */
    position: number;
    /** Direction of the message before it, when there is one. */
    previous_direction: "inbound" | "outbound" | null;
    contact_address: string;
  }>;
  meetings: Array<{
    external_id: string;
    starts_at: string;
    ends_at: string;
    status: "confirmed" | "tentative" | "cancelled";
    self_response: "accepted" | "tentative" | "declined" | "needsAction";
    attendee_count: number;
    /** Attendees who are this person's contacts, sorted. The case(s) the meeting belongs to. */
    contact_addresses: string[];
  }>;
  actions: Array<{
    id: string;
    kind: string;
    status: string;
    approved_by: "user" | "promotion" | null;
    approved_at: string | null;
    verified_at: string | null;
    reverted_at: string | null;
    field_names: string[];
    contact_address: string | null;
  }>;
  decisions: Array<{
    obligation_id: string;
    kind: "awaiting_you" | "awaiting_them" | "unsent_followup";
    outcome: "drafted" | "snoozed" | "dismissed" | "resolved";
    decided_at: string;
    contact_address: string;
  }>;
  intents: Array<{
    id: string;
    source: "stated" | "observed" | "inferred";
    scope_kind: "global" | "contact" | "account" | "situation";
    created_at: string;
    /** The contact the sentence is about, when its scope is one. */
    contact_address: string | null;
  }>;
};

export async function loadEventFacts(
  sql: Sql,
  ctx: UserContext,
  opts: { since: Date | null; window_start: Date },
): Promise<EventFacts> {
  return withUser(sql, ctx, async (tx) => {
    const since = opts.since ? opts.since.toISOString() : null;
    const from = opts.window_start.toISOString();
    const messages = await tx<
      Array<{
        message_external_id: string;
        thread_external_id: string;
        direction: "inbound" | "outbound";
        sent_at: Date;
        position: number;
        previous_direction: "inbound" | "outbound" | null;
        contact_address: string;
      }>
    >`
      SELECT m.external_id AS message_external_id,
             t.external_id AS thread_external_id,
             m.direction,
             m.sent_at,
             (ROW_NUMBER() OVER (PARTITION BY m.thread_id ORDER BY m.sent_at, m.external_id))::int AS position,
             LAG(m.direction) OVER (PARTITION BY m.thread_id ORDER BY m.sent_at, m.external_id) AS previous_direction,
             c.external_id AS contact_address
      FROM messages m
      JOIN threads t ON t.id = m.thread_id
      JOIN contacts c ON c.id = t.contact_id
      WHERE m.sent_at >= ${from}
      ORDER BY m.sent_at, m.external_id
    `;
    const meetings = await tx<
      Array<{
        external_id: string;
        starts_at: Date;
        ends_at: Date;
        status: "confirmed" | "tentative" | "cancelled";
        self_response: "accepted" | "tentative" | "declined" | "needsAction";
        attendee_count: number;
        contact_addresses: string[];
      }>
    >`
      SELECT m.external_id, m.starts_at, m.ends_at, m.status, m.self_response,
             jsonb_array_length(m.attendees)::int AS attendee_count,
             ARRAY(
               SELECT c.external_id FROM contacts c
               WHERE c.external_id IN (
                 SELECT lower(a->>'address') FROM jsonb_array_elements(m.attendees) a
               )
               ORDER BY c.external_id
             ) AS contact_addresses
      FROM meetings m
      WHERE m.ends_at >= ${from}
        AND (${since}::timestamptz IS NULL OR updated_at >= ${since}::timestamptz)
      ORDER BY starts_at, external_id
    `;
    const actions = await tx<
      Array<{
        id: string;
        kind: string;
        status: string;
        approved_by: "user" | "promotion" | null;
        approved_at: Date | null;
        verified_at: Date | null;
        reverted_at: Date | null;
        diff: unknown;
        contact_address: string | null;
      }>
    >`
      SELECT a.id, a.kind, a.status, a.approved_by, a.approved_at, a.verified_at, a.reverted_at,
             a.diff, c.external_id AS contact_address
      FROM actions a
      LEFT JOIN contacts c ON c.id = a.contact_id
      WHERE a.created_at >= ${from}
        AND (${since}::timestamptz IS NULL OR a.updated_at >= ${since}::timestamptz)
      ORDER BY a.created_at, a.id
    `;
    const decisions = await tx<
      Array<{
        obligation_id: string;
        kind: "awaiting_you" | "awaiting_them" | "unsent_followup";
        outcome: "drafted" | "snoozed" | "dismissed" | "resolved";
        decided_at: Date;
        contact_address: string;
      }>
    >`
      SELECT o.id AS obligation_id, o.kind, o.outcome, o.updated_at AS decided_at,
             c.external_id AS contact_address
      FROM obligations o
      JOIN contacts c ON c.id = o.contact_id
      WHERE o.outcome IN ('drafted', 'snoozed', 'dismissed', 'resolved')
        AND o.updated_at >= ${from}
        AND (${since}::timestamptz IS NULL OR o.updated_at >= ${since}::timestamptz)
      ORDER BY o.updated_at, o.id
    `;
    const intents = await tx<
      Array<{
        id: string;
        source: "stated" | "observed" | "inferred";
        scope_kind: "global" | "contact" | "account" | "situation";
        created_at: Date;
        contact_address: string | null;
      }>
    >`
      SELECT id, source, scope_kind, created_at,
             CASE WHEN scope_kind = 'contact' THEN scope_value ELSE NULL END AS contact_address
      FROM intents
      WHERE created_at >= ${from}
        AND (${since}::timestamptz IS NULL OR created_at >= ${since}::timestamptz)
      ORDER BY created_at, id
    `;
    // Messages are re-read whole when anything moved: position and the
    // previous direction depend on the thread, not the row.
    const iso = (d: Date) => new Date(d).toISOString();
    return {
      messages: messages.map((m) => ({
        message_external_id: m.message_external_id,
        thread_external_id: m.thread_external_id,
        direction: m.direction,
        sent_at: iso(m.sent_at),
        position: Number(m.position),
        previous_direction: m.previous_direction,
        contact_address: m.contact_address,
      })),
      meetings: meetings.map((m) => ({
        external_id: m.external_id,
        starts_at: iso(m.starts_at),
        ends_at: iso(m.ends_at),
        status: m.status,
        self_response: m.self_response,
        attendee_count: Number(m.attendee_count),
        contact_addresses: m.contact_addresses ?? [],
      })),
      actions: actions.map((a) => ({
        id: a.id,
        kind: a.kind,
        status: a.status,
        approved_by: a.approved_by,
        approved_at: a.approved_at ? iso(a.approved_at) : null,
        verified_at: a.verified_at ? iso(a.verified_at) : null,
        reverted_at: a.reverted_at ? iso(a.reverted_at) : null,
        field_names: fieldNamesOf(a.diff),
        contact_address: a.contact_address,
      })),
      decisions: decisions.map((d) => ({
        obligation_id: d.obligation_id,
        kind: d.kind,
        outcome: d.outcome,
        decided_at: iso(d.decided_at),
        contact_address: d.contact_address,
      })),
      intents: intents.map((i) => ({
        id: i.id,
        source: i.source,
        scope_kind: i.scope_kind,
        created_at: iso(i.created_at),
        contact_address: i.contact_address,
      })),
    };
  });
}

/** The field names a write touched, from its diff. Names only, never values. */
function fieldNamesOf(diff: unknown): string[] {
  if (!diff || typeof diff !== "object") return [];
  const d = diff as { changes?: Record<string, unknown>; fields?: Record<string, unknown> };
  if (d.changes && typeof d.changes === "object") return Object.keys(d.changes).sort();
  if (d.fields && typeof d.fields === "object") return Object.keys(d.fields).sort();
  return [];
}

/**
 * Writes derived events, exactly once per fact. Every event is checked
 * against the contract and scanned for forbidden field names first; one bad
 * event refuses the whole batch, so nothing partial lands.
 */
export async function recordWorkflowEvents(
  sql: Sql,
  ctx: UserContext,
  events: ReadonlyArray<{ event: WorkflowEvent; dedupe_key: string }>,
): Promise<{ written: number; refused: string | null }> {
  for (const { event } of events) {
    const parsed = workflowEventSchema.safeParse(event);
    if (!parsed.success) {
      return { written: 0, refused: `contract: ${parsed.error.issues[0]?.path.join(".")}` };
    }
    const forbidden = containsForbiddenEventField(event);
    if (forbidden) return { written: 0, refused: `forbidden field: ${forbidden}` };
    if (event.organization_id !== ctx.organizationId || event.user_id !== ctx.userId) {
      return { written: 0, refused: "event names another person" };
    }
  }
  if (events.length === 0) return { written: 0, refused: null };
  return withUser(sql, ctx, async (tx) => {
    let written = 0;
    for (const { event, dedupe_key } of events) {
      const rows = await tx`
        INSERT INTO workflow_events
          (id, organization_id, owner_user_id, occurred_at, source, event_type, dedupe_key, event)
        VALUES (${event.event_id}, ${ctx.organizationId}, ${ctx.userId}, ${event.occurred_at},
                ${event.source}, ${event.event_type}, ${dedupe_key}, ${JSON.stringify(event)}::jsonb)
        ON CONFLICT (owner_user_id, dedupe_key) DO NOTHING
        RETURNING id
      `;
      written += rows.length;
    }
    return { written, refused: null };
  });
}

/** The stream, oldest first, as the contract shapes it. */
export async function listWorkflowEvents(
  sql: Sql,
  ctx: UserContext,
  opts: { since?: Date | undefined; limit?: number | undefined } = {},
): Promise<WorkflowEvent[]> {
  return withUser(sql, ctx, async (tx) => {
    const rows = await tx<Array<{ event: unknown }>>`
      SELECT event FROM workflow_events
      WHERE (${opts.since ? opts.since.toISOString() : null}::timestamptz IS NULL
             OR occurred_at >= ${opts.since ? opts.since.toISOString() : null}::timestamptz)
      ORDER BY occurred_at, id
      LIMIT ${opts.limit ?? 5000}
    `;
    return rows.map((r) => workflowEventSchema.parse(r.event));
  });
}

/** When the stream was last written to, so a sweep derives only what moved. */
export async function latestWorkflowEventWrite(sql: Sql, ctx: UserContext): Promise<Date | null> {
  return withUser(sql, ctx, async (tx) => {
    const rows = await tx<Array<{ at: Date | null }>>`
      SELECT max(created_at) AS at FROM workflow_events
    `;
    const at = rows[0]?.at ?? null;
    return at ? new Date(at) : null;
  });
}

export async function countWorkflowEvents(sql: Sql, ctx: UserContext): Promise<number> {
  return withUser(sql, ctx, async (tx) => {
    const rows = await tx<Array<{ n: number }>>`SELECT count(*)::int AS n FROM workflow_events`;
    return Number(rows[0]?.n ?? 0);
  });
}

// ---- routines discovery found ----

/** The one decision kept here. Accepted and never live in the intent store. */
export type RoutineDecision = "dismissed";

export type RoutineEvidence = {
  started_at: string;
  ended_at: string;
  case_ref: string | null;
  events: number;
};

export type RoutineCandidateRow = {
  id: string;
  signature: string;
  status: "candidate" | "eligible";
  decision: RoutineDecision | null;
  decided_at: string | null;
  title: string;
  summary: string;
  occurrence_count: number;
  distinct_day_count: number;
  first_seen_at: string;
  last_seen_at: string;
  candidate: unknown;
  naming: unknown;
  verdict: unknown;
  evidence: RoutineEvidence[];
  agent_id: string | null;
  evaluated_at: string;
};

export type RoutineCandidateInput = Omit<
  RoutineCandidateRow,
  "id" | "decision" | "decided_at" | "evaluated_at" | "agent_id"
> & { id: string };

function toRoutineRow(r: typeof schema.routine_candidates.$inferSelect): RoutineCandidateRow {
  return {
    id: r.id,
    signature: r.signature,
    status: r.status,
    decision: r.decision,
    decided_at: r.decided_at ? new Date(r.decided_at).toISOString() : null,
    title: r.title,
    summary: r.summary,
    occurrence_count: r.occurrence_count,
    distinct_day_count: r.distinct_day_count,
    first_seen_at: new Date(r.first_seen_at).toISOString(),
    last_seen_at: new Date(r.last_seen_at).toISOString(),
    candidate: r.candidate,
    naming: r.naming,
    verdict: r.verdict,
    evidence: Array.isArray(r.evidence) ? (r.evidence as RoutineEvidence[]) : [],
    agent_id: r.agent_id,
    evaluated_at: new Date(r.evaluated_at).toISOString(),
  };
}

/**
 * Writes what discovery found this sweep. Keyed by signature: a routine seen
 * again is the same row with fresh counts, scores and verdict. The person's
 * decision and when they made it are never touched here.
 */
export async function upsertRoutineCandidates(
  sql: Sql,
  ctx: UserContext,
  rows: readonly RoutineCandidateInput[],
  evaluatedAt: Date,
): Promise<{ written: number }> {
  if (rows.length === 0) return { written: 0 };
  return withUser(sql, ctx, async (tx) => {
    let written = 0;
    for (const r of rows) {
      const out = await tx`
        INSERT INTO routine_candidates
          (id, organization_id, owner_user_id, signature, status, title, summary,
           occurrence_count, distinct_day_count, first_seen_at, last_seen_at,
           candidate, naming, verdict, evidence, evaluated_at)
        VALUES (${r.id}, ${ctx.organizationId}, ${ctx.userId}, ${r.signature}, ${r.status},
                ${r.title}, ${r.summary}, ${r.occurrence_count}, ${r.distinct_day_count},
                ${r.first_seen_at}, ${r.last_seen_at},
                ${JSON.stringify(r.candidate)}::jsonb, ${JSON.stringify(r.naming)}::jsonb,
                ${JSON.stringify(r.verdict)}::jsonb, ${JSON.stringify(r.evidence)}::jsonb,
                ${evaluatedAt.toISOString()})
        ON CONFLICT (owner_user_id, signature) DO UPDATE SET
          status = EXCLUDED.status,
          title = EXCLUDED.title,
          summary = EXCLUDED.summary,
          occurrence_count = EXCLUDED.occurrence_count,
          distinct_day_count = EXCLUDED.distinct_day_count,
          first_seen_at = EXCLUDED.first_seen_at,
          last_seen_at = EXCLUDED.last_seen_at,
          candidate = EXCLUDED.candidate,
          naming = EXCLUDED.naming,
          verdict = EXCLUDED.verdict,
          evidence = EXCLUDED.evidence,
          evaluated_at = EXCLUDED.evaluated_at,
          updated_at = now()
        RETURNING id
      `;
      written += out.length;
    }
    return { written };
  });
}

export async function listRoutineCandidates(
  sql: Sql,
  ctx: UserContext,
  opts: { limit?: number | undefined } = {},
): Promise<RoutineCandidateRow[]> {
  return withUser(sql, ctx, async (tx) => {
    const rows = await db(tx)
      .select()
      .from(schema.routine_candidates)
      .orderBy(desc(schema.routine_candidates.last_seen_at), schema.routine_candidates.signature)
      .limit(opts.limit ?? 100);
    return rows.map(toRoutineRow);
  });
}

export async function getRoutineCandidate(
  sql: Sql,
  ctx: UserContext,
  id: string,
): Promise<RoutineCandidateRow | null> {
  return withUser(sql, ctx, async (tx) => {
    const rows = await db(tx)
      .select()
      .from(schema.routine_candidates)
      .where(eq(schema.routine_candidates.id, id))
      .limit(1);
    return rows[0] ? toRoutineRow(rows[0]) : null;
  });
}

/** "Not now", kept here with when it was said so the cooldown can be counted. */
export async function dismissRoutine(
  sql: Sql,
  ctx: UserContext,
  id: string,
  at: Date,
): Promise<RoutineCandidateRow | null> {
  return withUser(sql, ctx, async (tx) => {
    const rows = await db(tx)
      .update(schema.routine_candidates)
      .set({ decision: "dismissed", decided_at: at.toISOString(), updated_at: rawSql`now()` })
      .where(eq(schema.routine_candidates.id, id))
      .returning();
    return rows[0] ? toRoutineRow(rows[0]) : null;
  });
}

/** Links a routine to the agent compiled from it. */
export async function setRoutineAgent(
  sql: Sql,
  ctx: UserContext,
  id: string,
  agentId: string | null,
): Promise<boolean> {
  return withUser(sql, ctx, async (tx) => {
    const rows = await db(tx)
      .update(schema.routine_candidates)
      .set({ agent_id: agentId, updated_at: rawSql`now()` })
      .where(eq(schema.routine_candidates.id, id))
      .returning({ id: schema.routine_candidates.id });
    return rows.length === 1;
  });
}

/** Signatures the person said "not now" to inside the cooldown. */
export async function recentlyDismissedRoutines(
  sql: Sql,
  ctx: UserContext,
  now: Date,
  cooldownDays: number,
): Promise<string[]> {
  return withUser(sql, ctx, async (tx) => {
    const cutoff = new Date(now.getTime() - cooldownDays * 86_400_000).toISOString();
    const rows = await tx<Array<{ signature: string }>>`
      SELECT signature FROM routine_candidates
      WHERE decision = 'dismissed' AND decided_at >= ${cutoff}::timestamptz
      ORDER BY signature
    `;
    return rows.map((r) => r.signature);
  });
}

// ---- runs of an accepted routine ----

export type RoutineRunRow = {
  id: string;
  routine_id: string;
  agent_id: string;
  agent_version_id: string;
  trigger_event_id: string;
  triggered_at: string;
  case_ref: string | null;
  mode: "shadow" | "supervised";
  status: "watching" | "completed" | "skipped" | "failed";
  proposed: unknown;
  actual: unknown;
  comparison: unknown;
  outputs: unknown;
  detail: string | null;
  created_at: string;
  completed_at: string | null;
};

function toRunRow(r: typeof schema.routine_runs.$inferSelect): RoutineRunRow {
  return {
    id: r.id,
    routine_id: r.routine_id,
    agent_id: r.agent_id,
    agent_version_id: r.agent_version_id,
    trigger_event_id: r.trigger_event_id,
    triggered_at: new Date(r.triggered_at).toISOString(),
    case_ref: r.case_ref,
    mode: r.mode,
    status: r.status,
    proposed: r.proposed,
    actual: r.actual,
    comparison: r.comparison,
    outputs: r.outputs,
    detail: r.detail,
    created_at: new Date(r.created_at).toISOString(),
    completed_at: r.completed_at ? new Date(r.completed_at).toISOString() : null,
  };
}

/** One run per trigger event. A trigger seen again returns null, and nothing runs twice. */
export async function createRoutineRun(
  sql: Sql,
  ctx: UserContext,
  input: {
    id: string;
    routine_id: string;
    agent_id: string;
    agent_version_id: string;
    trigger_event_id: string;
    triggered_at: string;
    case_ref: string | null;
    mode: "shadow" | "supervised";
    status: "watching" | "completed" | "skipped" | "failed";
    proposed: unknown;
  },
): Promise<RoutineRunRow | null> {
  return withUser(sql, ctx, async (tx) => {
    const rows = await db(tx)
      .insert(schema.routine_runs)
      .values({
        id: input.id,
        organization_id: ctx.organizationId,
        owner_user_id: ctx.userId,
        routine_id: input.routine_id,
        agent_id: input.agent_id,
        agent_version_id: input.agent_version_id,
        trigger_event_id: input.trigger_event_id,
        triggered_at: input.triggered_at,
        case_ref: input.case_ref,
        mode: input.mode,
        status: input.status,
        proposed: input.proposed,
      })
      .onConflictDoNothing()
      .returning();
    return rows[0] ? toRunRow(rows[0]) : null;
  });
}

export async function completeRoutineRun(
  sql: Sql,
  ctx: UserContext,
  id: string,
  patch: {
    status: "completed" | "skipped" | "failed";
    actual?: unknown;
    comparison?: unknown;
    outputs?: unknown;
    detail?: string | null;
    completed_at: string;
  },
): Promise<RoutineRunRow | null> {
  return withUser(sql, ctx, async (tx) => {
    const rows = await db(tx)
      .update(schema.routine_runs)
      .set({
        status: patch.status,
        ...(patch.actual !== undefined ? { actual: patch.actual } : {}),
        ...(patch.comparison !== undefined ? { comparison: patch.comparison } : {}),
        ...(patch.outputs !== undefined ? { outputs: patch.outputs } : {}),
        ...(patch.detail !== undefined ? { detail: patch.detail } : {}),
        completed_at: patch.completed_at,
      })
      .where(and(eq(schema.routine_runs.id, id), eq(schema.routine_runs.status, "watching")))
      .returning();
    return rows[0] ? toRunRow(rows[0]) : null;
  });
}

export async function listRoutineRuns(
  sql: Sql,
  ctx: UserContext,
  opts: { routine_id?: string | undefined; status?: RoutineRunRow["status"] | undefined } = {},
): Promise<RoutineRunRow[]> {
  return withUser(sql, ctx, async (tx) => {
    const rows = await db(tx)
      .select()
      .from(schema.routine_runs)
      .where(
        and(
          ...(opts.routine_id ? [eq(schema.routine_runs.routine_id, opts.routine_id)] : []),
          ...(opts.status ? [eq(schema.routine_runs.status, opts.status)] : []),
        ),
      )
      .orderBy(desc(schema.routine_runs.triggered_at), schema.routine_runs.id);
    return rows.map(toRunRow);
  });
}

// ---- corrections: what the agent proposed against what the person did ----

export type CorrectionKind = "draft" | "crm_field" | "routine_step";

export type CorrectionRow = {
  id: string;
  kind: CorrectionKind;
  ref_id: string;
  contact_address: string | null;
  signals: string[];
  summary: unknown;
  created_at: string;
};

/** One correction per thing. A second write for the same draft, action or run changes nothing. */
export async function recordCorrection(
  sql: Sql,
  ctx: UserContext,
  input: {
    kind: CorrectionKind;
    ref_id: string;
    contact_address: string | null;
    signals: string[];
    summary: unknown;
  },
): Promise<boolean> {
  return withUser(sql, ctx, async (tx) => {
    const rows = await tx`
      INSERT INTO corrections (id, organization_id, owner_user_id, kind, ref_id, contact_address, signals, summary)
      VALUES (${uuidv7()}, ${ctx.organizationId}, ${ctx.userId}, ${input.kind}, ${input.ref_id},
              ${input.contact_address}, ${input.signals}, ${JSON.stringify(input.summary)}::jsonb)
      ON CONFLICT (owner_user_id, kind, ref_id) DO NOTHING
      RETURNING id
    `;
    return rows.length === 1;
  });
}

export async function listCorrections(
  sql: Sql,
  ctx: UserContext,
  opts: { since: Date; kind?: CorrectionKind | undefined },
): Promise<CorrectionRow[]> {
  return withUser(sql, ctx, async (tx) => {
    const rows = await db(tx)
      .select()
      .from(schema.corrections)
      .where(
        and(
          gte(schema.corrections.created_at, opts.since.toISOString()),
          ...(opts.kind ? [eq(schema.corrections.kind, opts.kind)] : []),
        ),
      )
      .orderBy(desc(schema.corrections.created_at));
    return rows.map((r) => ({
      id: r.id,
      kind: r.kind,
      ref_id: r.ref_id,
      contact_address: r.contact_address,
      signals: r.signals,
      summary: r.summary,
      created_at: new Date(r.created_at).toISOString(),
    }));
  });
}

/** The contact a thread is with, for a correction to be about someone. */
export async function threadContactAddress(
  sql: Sql,
  ctx: UserContext,
  threadId: string,
): Promise<string | null> {
  return withUser(sql, ctx, async (tx) => {
    const rows = await tx<Array<{ external_id: string }>>`
      SELECT c.external_id FROM threads t JOIN contacts c ON c.id = t.contact_id WHERE t.id = ${threadId}
    `;
    return rows[0]?.external_id ?? null;
  });
}

/**
 * Messages the person sent after editing one of the agent's drafts: the best
 * examples there are of what they wanted, newest first. For one contact when
 * asked, otherwise anyone.
 */
export async function listSentAfterDrafts(
  sql: Sql,
  ctx: UserContext,
  opts: { contact_id?: string | undefined; limit?: number } = {},
): Promise<StoredMessageRow[]> {
  return withUser(sql, ctx, async (tx) => {
    const rows = await tx<
      Array<{
        external_id: string;
        from_address: string;
        from_display_name: string | null;
        direction: "inbound" | "outbound";
        sent_at: Date;
        body_ciphertext: Uint8Array;
        body_chars: number;
      }>
    >`
      SELECT m.external_id, m.from_address, m.from_display_name, m.direction, m.sent_at,
             m.body_ciphertext, m.body_chars
      FROM drafts d
      JOIN messages m ON m.external_id = d.sent_external_id AND m.thread_id = d.thread_id
      JOIN threads t ON t.id = d.thread_id
      WHERE d.matched_at IS NOT NULL
        AND d.edit_ratio IS NOT NULL AND d.edit_ratio < 0.9
        AND (${opts.contact_id ?? null}::uuid IS NULL OR t.contact_id = ${opts.contact_id ?? null}::uuid)
      ORDER BY m.sent_at DESC
      LIMIT ${opts.limit ?? 2}
    `;
    return rows.map((r) => ({ ...r, sent_at: new Date(r.sent_at).toISOString() }));
  });
}
