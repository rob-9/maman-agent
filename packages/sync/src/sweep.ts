import type { Sql } from "postgres";
import { globalListActiveOrganizations, listMemberships, listUserConnections } from "@maman/db";
import { runGmailSyncJob, type GmailSyncJobDeps } from "./sync-gmail.js";
import type { SweepActivities, SweepTarget } from "./workflow.js";

/**
 * The Node side of the scheduled sweep: the activity implementations.
 *
 * Finding whom to sweep is the one place the product looks across tenants,
 * and it does so WITHOUT bypassing row-level security: the only global read
 * is the list of active organization ids; memberships are read under each
 * organization's scope and connections under each person's. A person is a
 * target only if their membership is active AND they hold an active mailbox
 * connection — a suspended member's mailbox is not swept, whatever their row
 * says.
 */
export async function listSweepTargets(sql: Sql): Promise<SweepTarget[]> {
  const targets: SweepTarget[] = [];
  for (const org of await globalListActiveOrganizations(sql)) {
    const members = (await listMemberships(sql, { organizationId: org.id }))
      .filter((m) => m.status === "active")
      .sort((a, b) => (a.user_id < b.user_id ? -1 : a.user_id > b.user_id ? 1 : 0));
    for (const m of members) {
      const connections = await listUserConnections(sql, {
        organizationId: org.id,
        userId: m.user_id,
      });
      if (connections.some((c) => c.provider === "gmail" && c.status === "active")) {
        targets.push({ organization_id: org.id, user_id: m.user_id, provider: "gmail" });
      }
    }
  }
  return targets;
}

export function createSweepActivities(deps: GmailSyncJobDeps): SweepActivities {
  return {
    listSweepTargets: () => listSweepTargets(deps.sql),
    async syncWorkspace(target) {
      // The job records failures on the person's connection itself and
      // answers with a reason; a bad mailbox is an outcome, not an exception.
      const result = await runGmailSyncJob(deps, {
        organizationId: target.organization_id,
        userId: target.user_id,
      });
      return result.ok
        ? { ok: true, obligations_written: result.obligations_written }
        : { ok: false, reason: result.reason };
    },
  };
}
