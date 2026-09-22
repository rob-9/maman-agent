import { and, desc, eq, gte, sql as rawSql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import type { Sql, TransactionSql } from "postgres";
import { uuidv7 } from "@maman/contracts";
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
          history_id: t.history_id ?? null,
        })
        .onConflictDoUpdate({
          target: [schema.threads.connection_id, schema.threads.external_id],
          set: {
            subject: t.subject,
            last_message_at: t.last_message_at,
            last_direction: t.last_direction,
            message_count: t.message_count,
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
  }>;
  contacts: Array<{
    contact_id: string;
    display_name: string;
    account_name?: string;
    open_deal_value?: number;
    has_open_deal: boolean | null;
    last_meeting_at?: string;
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
      })),
      contacts: contactRows.map((r) => ({
        contact_id: r.id,
        display_name: r.display_name,
        ...(r.account_name !== null ? { account_name: r.account_name } : {}),
        ...(r.open_deal_value !== null ? { open_deal_value: Number(r.open_deal_value) } : {}),
        has_open_deal: r.has_open_deal,
        ...(r.last_meeting_at !== null
          ? { last_meeting_at: new Date(r.last_meeting_at).toISOString() }
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
): Promise<{ written: number; kept_decided: number }> {
  return withUser(sql, ctx, async (tx) => {
    const d = db(tx);
    await d.delete(schema.obligations).where(eq(schema.obligations.outcome, "pending"));

    let written = 0;
    for (const o of detected) {
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
          outcome: "pending",
          detected_at: detectedAt.toISOString(),
        })
        .onConflictDoNothing({ target: schema.obligations.thread_id })
        .returning({ id: schema.obligations.id });
      written += rows.length;
    }
    return { written, kept_decided: detected.length - written };
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
  /** Present when the agent has judged this thread in its current state. */
  assessment: ThreadAssessment | null;
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
        assessment: fresh ? (r.assessment as ThreadAssessment) : null,
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
      })
      .from(schema.obligations)
      .innerJoin(schema.threads, eq(schema.threads.id, schema.obligations.thread_id))
      .innerJoin(schema.contacts, eq(schema.contacts.id, schema.obligations.contact_id))
      .where(
        and(eq(schema.obligations.id, obligationId), eq(schema.obligations.outcome, "pending")),
      )
      .limit(1);
    if (!row) return null;
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
    };
  });
}
