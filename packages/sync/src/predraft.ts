import type { Sql } from "postgres";
import type { HttpTransport, UserCredentialProvider } from "@maman/connector-adapters";
import { listPendingObligations, type UserContext } from "@maman/db";
import { predraftAllowed } from "@maman/obligation-engine";
import type { ContextComposer } from "@maman/voice-engine";
import { runDraftJob } from "./draft-job.js";
import { activeRules } from "./intents.js";

/**
 * PRE-DRAFTING. The step where the product starts doing the work before
 * being asked: after judgment, the top items that are owed get a draft
 * written into Gmail Drafts, so the person opens the app and the drafts are
 * there. Bounded per sweep; one unsent draft per thread; only items the
 * agent judged owed; never when the person said not to. Still never sent.
 */

export type PredraftDeps = {
  sql: Sql;
  contentKey: Buffer;
  credentials: UserCredentialProvider;
  transport: HttpTransport;
  composer: ContextComposer;
  now: () => Date;
  /** Per sweep. 0 disables. */
  max: number;
};

export type PredraftResult = {
  considered: number;
  drafted: number;
  skipped_by_rule: number;
  failed: number;
};

export async function runPredraft(deps: PredraftDeps, ctx: UserContext): Promise<PredraftResult> {
  const result: PredraftResult = { considered: 0, drafted: 0, skipped_by_rule: 0, failed: 0 };
  if (deps.max <= 0) return result;
  const rules = await activeRules(deps.sql, ctx);
  const candidates = (await listPendingObligations(deps.sql, ctx, 50, { agent: true })).filter(
    (o) => o.assessment?.owed === true && o.draft === null,
  );
  result.considered = candidates.length;
  for (const c of candidates) {
    if (result.drafted >= deps.max) break;
    const contact = {
      address: c.contact_address,
      display_name: c.contact_display_name,
      account_name: c.contact_account_name,
    };
    if (!predraftAllowed(rules, contact, c.kind)) {
      result.skipped_by_rule += 1;
      continue;
    }
    try {
      const r = await runDraftJob(deps, ctx, c.id, "auto");
      if (r.ok) result.drafted += 1;
      else result.failed += 1;
    } catch {
      // Gmail refused, or the composer failed outright. The item stays as it
      // was; the next sweep tries again. Counted, not raised.
      result.failed += 1;
    }
  }
  return result;
}
