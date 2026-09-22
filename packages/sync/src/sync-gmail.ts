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
  listThreadHistoryIds,
  loadDetectionInputs,
  markUserConnectionSync,
  replacePendingObligations,
  upsertSyncedThreads,
  type UserContext,
} from "@maman/db";
import {
  applyIntentRules,
  detectObligations,
  type DetectionConfig,
} from "@maman/obligation-engine";
import { activeRules } from "./intents.js";
import type { DealSourceResolver } from "./deal-source.js";
import { runAgentPass, type AgentDeps, type AgentPassResult } from "./assess.js";
import { runPredraft, type PredraftResult } from "./predraft.js";
import { autoActions, sentFromMatchedDrafts, type ActionDeps } from "./actions.js";
import { runOpportunityPass, type OpportunityPassResult } from "./opportunity-pass.js";
import { runEventStep, type EventStepResult } from "./events.js";
import type { ContextComposer } from "@maman/voice-engine";
import { toSyncedMessage } from "./content.js";
import { matchSentDrafts } from "./voice.js";
import { runCalendarStep, type CalendarStepResult } from "./sync-calendar.js";

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
  /** Encrypts stored message bodies to the person (content.ts). */
  contentKey: Buffer;
  /**
   * Finds the organization's CRM, when one is connected. Absent, or resolving
   * to nothing → deal state stays unknown and the list still works (0009).
   * Otherwise the CRM is asked about THIS person's contacts only, between the
   * mailbox write and detection, so the ranking that lands is the one it
   * informed.
   */
  deals?: DealSourceResolver | undefined;
  /**
   * The agent pass, when AGENT_MODE=assist. Absent → the list is the
   * deterministic ranking. Present → runs after detection over the top
   * candidates; see assess.ts for what it may and may not do.
   */
  agent?: AgentDeps | undefined;
  /** Drafts written before being asked, after the agent pass. Absent → none. */
  predraft?: { composer: ContextComposer; max: number } | undefined;
  /**
   * Writes to the organization's CRM for what the person sent. Absent → no
   * action is ever proposed. Present → proposed for every draft matched to a
   * sent message, and applied without asking only under a promotion.
   */
  actions?: Pick<ActionDeps, "writer" | "opportunities" | "orgPolicy"> | undefined;
  /**
   * The event stream (EVENT_STREAM=on, the default). Absent → nothing is
   * derived and nothing else changes. Present → every synced fact and every
   * click becomes an event in the person's store, after the rest of the
   * sweep so this sweep's own writes are included.
   */
  events?: { window_days?: number | undefined } | undefined;
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
      /** Listed but unchanged since last sync: not fetched, not rewritten. */
      unchanged: number;
      contacts_upserted: number;
      threads_upserted: number;
      messages_upserted: number;
      /** Drafts matched to what the person actually sent, this sync. */
      drafts_matched: number;
      calendar: CalendarStepResult;
      obligations_written: number;
      obligations_kept_decided: number;
      /** Set aside by the person's own rules this sweep. */
      obligations_skipped: number;
      deals: DealStepResult;
      agent: AgentPassResult | null;
      predraft: PredraftResult | null;
      actions: { proposed: number; auto_applied: number; auto_failed: number } | null;
      opportunity: OpportunityPassResult | null;
      events: EventStepResult | null;
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

  // What we already hold, so an unchanged thread costs no fetch.
  const known = await listThreadHistoryIds(deps.sql, ctx, conn.id);

  let synced;
  try {
    synced = await syncGmailThreads(
      { credentials: deps.credentials, transport: deps.transport },
      { organization_id: ctx.organizationId, user_id: ctx.userId },
      {
        known,
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

  // Bodies are encrypted to the person before they reach the database.
  const upserted = await upsertSyncedThreads(deps.sql, ctx, {
    connection_id: conn.id,
    threads: synced.threads.map((t) => ({
      ...t,
      messages: t.messages.map((m) => toSyncedMessage(m, deps.contentKey, ctx)),
    })),
  });

  // Meetings, on the same Google grant. Before detection: a booked call
  // cancels a chase, and a follow-up is counted from a real meeting.
  const calendar = await runCalendarStep(
    {
      sql: deps.sql,
      credentials: deps.credentials,
      transport: deps.transport,
      contentKey: deps.contentKey,
      now: deps.now,
    },
    ctx,
    { id: conn.id, scopes: conn.scopes },
    synced.self_addresses,
  );

  // What the person sent from a draft is now in the store; record how close it was.
  const matchedDrafts = await matchSentDrafts({ sql: deps.sql, contentKey: deps.contentKey }, ctx);

  // What the person sent is worth recording where the team can see it. A
  // proposal each; applied without asking only under their own promotion.
  const actions = deps.actions
    ? await autoActions(
        { ...deps.actions, sql: deps.sql, contentKey: deps.contentKey, now: deps.now },
        ctx,
        await sentFromMatchedDrafts({ sql: deps.sql }, ctx, matchedDrafts.items),
      )
    : null;

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
  // The person's own rules, enforced here, before the agent and with it off.
  const rules = await activeRules(deps.sql, ctx);
  const applied = applyIntentRules(
    detected,
    rules,
    new Map(
      inputs.contacts.map((c) => [
        c.contact_id,
        { address: c.address, display_name: c.display_name, account_name: c.account_name ?? null },
      ]),
    ),
    new Map(inputs.threads.map((t) => [t.thread_id, t])),
  );
  const replaced = await replacePendingObligations(
    deps.sql,
    ctx,
    applied.kept,
    now,
    applied.skipped,
  );

  // The agent looks at what the detector found, after the rows are in place
  // so its judgments key to real obligations. Never before, never instead.
  const agent = deps.agent
    ? await runAgentPass(
        { ...deps.agent, sql: deps.sql, contentKey: deps.contentKey, now: deps.now },
        ctx,
        synced.self_addresses,
      )
    : null;

  // What the thread says about the deal, read after judgment and proposed
  // with the sentence attached. Applied without asking only where the
  // organization allows a medium-risk write unattended and the person asked.
  const opportunity =
    deps.agent && deps.actions
      ? await runOpportunityPass(
          {
            ...deps.actions,
            sql: deps.sql,
            contentKey: deps.contentKey,
            now: deps.now,
            provider: deps.agent.provider,
          },
          ctx,
        )
      : null;

  // Then the drafts, for what the agent judged owed. After judgment, never
  // instead of it: a draft written for a thread nobody read is noise in
  // the person's own Drafts folder.
  const predraft =
    deps.agent && deps.predraft
      ? await runPredraft(
          {
            sql: deps.sql,
            contentKey: deps.contentKey,
            credentials: deps.credentials,
            transport: deps.transport,
            composer: deps.predraft.composer,
            now: deps.now,
            max: deps.predraft.max,
          },
          ctx,
        )
      : null;

  // What happened, as events, last: this sweep's own writes and decisions
  // are facts too. A refused batch is reported, never thrown; the stream is
  // an input to discovery, not a step the mailbox depends on.
  const events = deps.events
    ? await runEventStep({ sql: deps.sql, now: deps.now }, ctx, deps.events).catch((e) => ({
        backfill: false,
        derived: 0,
        written: 0,
        refused: e instanceof Error ? e.message : String(e),
      }))
    : null;

  await markUserConnectionSync(deps.sql, ctx, conn.id, { ok: true, at: now });

  return {
    ok: true,
    connection_id: conn.id,
    listed: synced.listed,
    truncated: synced.truncated,
    unchanged: synced.unchanged.length,
    contacts_upserted: upserted.contacts,
    threads_upserted: upserted.threads,
    messages_upserted: upserted.messages,
    drafts_matched: matchedDrafts.matched,
    calendar,
    obligations_written: replaced.written,
    obligations_kept_decided: replaced.kept_decided,
    obligations_skipped: replaced.skipped,
    deals,
    agent,
    predraft,
    actions,
    opportunity,
    events,
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
