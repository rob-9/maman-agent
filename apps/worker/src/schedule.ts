import {
  ScheduleAlreadyRunning,
  ScheduleOverlapPolicy,
  type Client,
  type ScheduleOptions,
} from "@temporalio/client";
import { workspaceSweepWorkflow } from "@maman/sync/workflow";

/**
 * The one schedule this worker owns. Created on startup if absent, brought
 * up to date if present, so the interval in configuration is the interval
 * that runs — an operator changes the variable and restarts, nothing else.
 *
 * OVERLAP = SKIP: if a sweep is still running when the next tick arrives,
 * the tick is dropped rather than queued. Two sweeps of the same mailboxes
 * at once would only race each other for the same rows.
 */
export const SWEEP_SCHEDULE_ID = "workspace-sweep";
/** Fifteen minutes: current enough for a follow-up, gentle on Gmail quotas. */
export const DEFAULT_SWEEP_INTERVAL_MINUTES = 15;

export type SweepScheduleOptions = { taskQueue: string; everyMinutes: number };

export function sweepScheduleOptions(opts: SweepScheduleOptions): ScheduleOptions {
  if (!Number.isInteger(opts.everyMinutes) || opts.everyMinutes < 1) {
    throw new Error(
      `sweep interval must be a whole number of minutes >= 1, got ${opts.everyMinutes}`,
    );
  }
  return {
    scheduleId: SWEEP_SCHEDULE_ID,
    spec: { intervals: [{ every: `${opts.everyMinutes}m` }] },
    action: {
      type: "startWorkflow",
      workflowType: workspaceSweepWorkflow,
      taskQueue: opts.taskQueue,
      args: [],
    },
    policies: {
      overlap: ScheduleOverlapPolicy.SKIP,
      // A worker that was down for an hour should not run four catch-up
      // sweeps on return; the next tick sees everything the missed ones would.
      catchupWindow: "1 minute",
    },
  };
}

export async function ensureSweepSchedule(
  client: Client,
  opts: SweepScheduleOptions,
): Promise<"created" | "updated"> {
  const desired = sweepScheduleOptions(opts);
  try {
    await client.schedule.create(desired);
    return "created";
  } catch (e) {
    if (!(e instanceof ScheduleAlreadyRunning)) throw e;
  }
  await client.schedule.getHandle(SWEEP_SCHEDULE_ID).update((previous) => ({
    ...previous,
    spec: desired.spec,
    action: desired.action,
    policies: { ...previous.policies, ...desired.policies },
  }));
  return "updated";
}
