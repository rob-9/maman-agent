import type { Sql } from "postgres";
import {
  syncGmailThreads,
  type HttpTransport,
  type UserCredentialProvider,
} from "@maman/connector-adapters";
import {
  applyDealAnswer,
  getUserConnection,
  listContactAddresses,
  loadDetectionInputs,
  markUserConnectionSync,
  replacePendingObligations,
  upsertSyncedThreads,
  type UserContext,
} from "@maman/db";
import { detectObligations, type DetectionConfig } from "@maman/obligation-engine";
import type { DealSourceResolver } from "./deal-source.js";

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
  /**
   * Finds the organization's CRM, when one is connected. Absent, or resolving
   * to nothing → deal state stays unknown and the list still works (0009).
   * Otherwise the CRM is asked about THIS person's contacts only, between the
   * mailbox write and detection, so the ranking that lands is the one it
   * informed.
   */
  deals?: DealSourceResolver | undefined;
};

export type DealStepResult =
  | { ok: true; provider: string; asked: number; open: number; closed: number; unknown: number }
  | { ok: false; provider: string; error: string }
  | { ok: false; provider: null; reason: "no_crm" };

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
      deals: DealStepResult;
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

  // The CRM's answer, if there is a CRM. A CRM that is down must not take the
  // mailbox down with it: the sync completes on whatever deal state the
  // contacts already hold, and the result says the CRM was not heard.
  const deals = await dealStep(deps, ctx);

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
    deals,
  };
}

async function dealStep(deps: GmailSyncJobDeps, ctx: UserContext): Promise<DealStepResult> {
  const source = deps.deals ? await deps.deals(ctx.organizationId) : undefined;
  if (!source) return { ok: false, provider: null, reason: "no_crm" };
  const provider = source.provider;
  const addresses = await listContactAddresses(deps.sql, ctx);
  if (addresses.length === 0) {
    return { ok: true, provider, asked: 0, open: 0, closed: 0, unknown: 0 };
  }
  let answer;
  try {
    answer = await source.lookup(
      { organization_id: ctx.organizationId, user_id: ctx.userId },
      addresses,
    );
  } catch (e) {
    return { ok: false, provider, error: e instanceof Error ? e.message : String(e) };
  }
  // Only what we asked may be written. A CRM cannot introduce a contact.
  const askedSet = new Set(addresses);
  const applied = await applyDealAnswer(deps.sql, ctx, {
    asked: addresses,
    signals: answer.signals.filter((s) => askedSet.has(s.address)),
  });
  return {
    ok: true,
    provider,
    asked: addresses.length,
    open: applied.open,
    closed: applied.closed,
    unknown: applied.unknown,
  };
}
