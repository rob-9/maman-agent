import { and, desc, eq, sql as rawSql } from "drizzle-orm";
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

/** A thread as a connector projected it. Mirrors ProjectedThread, structurally. */
export type SyncedThread = {
  external_id: string;
  subject: string;
  last_message_at: string;
  last_direction: "inbound" | "outbound";
  message_count: number;
  contact: { address: string; display_name?: string | undefined };
};

export type UpsertResult = { contacts: number; threads: number };

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
    for (const t of input.threads) {
      await d
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
        })
        .onConflictDoUpdate({
          target: [schema.threads.connection_id, schema.threads.external_id],
          set: {
            subject: t.subject,
            last_message_at: t.last_message_at,
            last_direction: t.last_direction,
            message_count: t.message_count,
            updated_at: rawSql`now()`,
          },
        });
      threadsWritten += 1;
    }

    return { contacts: contactIds.size, threads: threadsWritten };
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

export type PendingObligationRow = {
  id: string;
  thread_id: string;
  contact_id: string;
  kind: "awaiting_you" | "awaiting_them" | "unsent_followup";
  rank: number;
  reason: unknown;
  detected_at: string;
  subject: string;
  contact_display_name: string;
  contact_account_name: string | null;
};

/** The ranked list the UI shows. Most urgent first. */
export async function listPendingObligations(
  sql: Sql,
  ctx: UserContext,
  limit = 50,
): Promise<PendingObligationRow[]> {
  return withUser(sql, ctx, async (tx) => {
    const d = db(tx);
    const rows = await d
      .select({
        id: schema.obligations.id,
        thread_id: schema.obligations.thread_id,
        contact_id: schema.obligations.contact_id,
        kind: schema.obligations.kind,
        rank: schema.obligations.rank,
        reason: schema.obligations.reason,
        detected_at: schema.obligations.detected_at,
        subject: schema.threads.subject,
        contact_display_name: schema.contacts.display_name,
        contact_account_name: schema.contacts.account_name,
      })
      .from(schema.obligations)
      .innerJoin(schema.threads, eq(schema.threads.id, schema.obligations.thread_id))
      .innerJoin(schema.contacts, eq(schema.contacts.id, schema.obligations.contact_id))
      .where(and(eq(schema.obligations.outcome, "pending")))
      .orderBy(desc(schema.obligations.rank), schema.obligations.thread_id)
      .limit(limit);
    return rows.map((r) => ({
      ...r,
      rank: Number(r.rank),
      detected_at: new Date(r.detected_at).toISOString(),
    }));
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
