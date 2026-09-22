import { proxyActivities } from "@temporalio/workflow";

/**
 * workspaceSweepWorkflow — the scheduled sweep.
 *
 * Runs inside the Temporal workflow sandbox: no Node APIs, no database, no
 * network. It decides the ORDER and the ACCOUNTING; every side effect is an
 * activity implemented in `sweep.ts` and registered by the worker.
 *
 * Started on a schedule (see apps/worker/src/schedule.ts), never by a user.
 * One mailbox at a time, deliberately: a team is tens of people, not
 * thousands, and Gmail's per-user quotas are kinder to a queue than a burst.
 * A mailbox that fails is COUNTED and skipped — never allowed to stop the
 * people after it from being swept.
 */

export type SweepTarget = { organization_id: string; user_id: string; provider: "gmail" };

export type SweepOutcome =
  { ok: true; obligations_written: number } | { ok: false; reason: string };

export interface SweepActivities {
  /** Who has an active mailbox connection right now, in a stable order. */
  listSweepTargets(): Promise<SweepTarget[]>;
  /** One person's sync, under their own tenant scope. Never throws for a bad mailbox. */
  syncWorkspace(target: SweepTarget): Promise<SweepOutcome>;
}

export type WorkspaceSweepResult = {
  targets: number;
  synced: number;
  failed: number;
  obligations_written: number;
};

const activities = proxyActivities<SweepActivities>({
  startToCloseTimeout: "5 minutes",
  // Infrastructure hiccups (database, network) are retried; a mailbox that
  // answers with an error is a non-ok OUTCOME, not an activity failure.
  retry: { maximumAttempts: 3, initialInterval: "5 seconds" },
});

export async function workspaceSweepWorkflow(): Promise<WorkspaceSweepResult> {
  const targets = await activities.listSweepTargets();
  const result: WorkspaceSweepResult = {
    targets: targets.length,
    synced: 0,
    failed: 0,
    obligations_written: 0,
  };
  for (const target of targets) {
    let outcome: SweepOutcome;
    try {
      outcome = await activities.syncWorkspace(target);
    } catch {
      // Retries exhausted for THIS person. Their connection row already
      // carries the error if the job got that far; the sweep moves on.
      outcome = { ok: false, reason: "activity_failed" };
    }
    if (outcome.ok) {
      result.synced += 1;
      result.obligations_written += outcome.obligations_written;
    } else {
      result.failed += 1;
    }
  }
  return result;
}
