import type { Sql } from "postgres";
import {
  syncGmailThreads,
  type HttpTransport,
  type UserCredentialProvider,
} from "@maman/connector-adapters";
import {
  getUserConnection,
  loadDetectionInputs,
  markUserConnectionSync,
  replacePendingObligations,
  upsertSyncedThreads,
  type UserContext,
} from "@maman/db";
import { detectObligations, type DetectionConfig } from "@maman/obligation-engine";

/**
 * THE L1 VERTICAL SLICE: mailbox → rows → detector → ranked obligations.
 *
 * Composition only. Every part is tested on its own; this file exists so the
 * parts are wired in a real path (§10: a package built and never called is
 * how capability-router sat unused for months), and so the whole chain runs
 * under one person's `UserContext` from end to end.
 *
 * Every number in the result is MEASURED — counts of what this run actually
 * did — never estimated. A sync that reports "300 threads" must have written
 * 300 threads.
 */

export type GmailSyncJobDeps = {
  sql: Sql;
  credentials: UserCredentialProvider;
  transport: HttpTransport;
  now: () => Date;
};

export type GmailSyncJobResult =
  | {
      ok: true;
      connection_id: string;
      listed: number;
      truncated: boolean;
      contacts_upserted: number;
      threads_upserted: number;
      obligations_written: number;
      obligations_kept_decided: number;
    }
  | { ok: false; reason: "no_connection" | "sync_failed"; error?: string };

export async function runGmailSyncJob(
  deps: GmailSyncJobDeps,
  ctx: UserContext,
  options: {
    max_threads?: number;
    newer_than_days?: number;
    detection?: Partial<DetectionConfig>;
  } = {},
): Promise<GmailSyncJobResult> {
  const conn = await getUserConnection(deps.sql, ctx, "gmail");
  if (!conn) return { ok: false, reason: "no_connection" };

  let synced;
  try {
    synced = await syncGmailThreads(
      { credentials: deps.credentials, transport: deps.transport },
      { organization_id: ctx.organizationId, user_id: ctx.userId },
      {
        ...(options.max_threads !== undefined ? { max_threads: options.max_threads } : {}),
        ...(options.newer_than_days !== undefined
          ? { newer_than_days: options.newer_than_days }
          : {}),
      },
    );
  } catch (e) {
    // The failure is recorded ON THE CONNECTION, where the UI can show it and
    // ask the person to reconnect. A sync that fails silently is a list that
    // quietly stops updating, which the user reads as "it stopped working".
    const error = e instanceof Error ? e.message : String(e);
    await markUserConnectionSync(deps.sql, ctx, conn.id, { ok: false, error });
    return { ok: false, reason: "sync_failed", error };
  }

  const upserted = await upsertSyncedThreads(deps.sql, ctx, {
    connection_id: conn.id,
    threads: synced.threads,
  });

  const inputs = await loadDetectionInputs(deps.sql, ctx);
  const now = deps.now();
  const detected = detectObligations({
    threads: inputs.threads,
    contacts: inputs.contacts,
    now,
    ...(options.detection ? { config: options.detection } : {}),
  });
  const replaced = await replacePendingObligations(deps.sql, ctx, detected, now);

  await markUserConnectionSync(deps.sql, ctx, conn.id, { ok: true, at: now });

  return {
    ok: true,
    connection_id: conn.id,
    listed: synced.listed,
    truncated: synced.truncated,
    contacts_upserted: upserted.contacts,
    threads_upserted: upserted.threads,
    obligations_written: replaced.written,
    obligations_kept_decided: replaced.kept_decided,
  };
}
