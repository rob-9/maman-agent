import "server-only";
import { DevIdentityError, identityHeaders } from "./session.js";
import type { ObligationView } from "./explain.js";

/**
 * The person's workspace client — server-side only.
 *
 * Identity never reaches the browser: every read is a server component and
 * every mutation is a server action, so the browser only ever sees rendered
 * HTML and the results of actions it triggered. How the person is identified
 * (a WorkOS bearer, or dev headers) is session.ts's business.
 */

const API_BASE = process.env["MAMAN_API_BASE_URL"] ?? "http://localhost:4000";

async function call<T>(
  method: "GET" | "POST",
  path: string,
  body?: unknown,
): Promise<{ ok: true; data: T } | { ok: false; status: number; detail?: string }> {
  let identity: Record<string, string>;
  try {
    identity = await identityHeaders();
  } catch (e) {
    // Only the dev fallback fails softly. A missing WorkOS session is a
    // redirect to sign-in, thrown by Next, and must propagate.
    if (e instanceof DevIdentityError) return { ok: false, status: 503, detail: e.message };
    throw e;
  }
  const res = await fetch(`${API_BASE}${path}`, {
    method,
    headers: {
      ...identity,
      ...(body !== undefined ? { "content-type": "application/json" } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    cache: "no-store",
  });
  if (!res.ok) {
    const j = (await res.json().catch(() => ({}))) as { detail?: string; reason?: string };
    return {
      ok: false,
      status: res.status,
      ...((j.detail ?? j.reason) ? { detail: j.detail ?? j.reason } : {}),
    };
  }
  return { ok: true, data: (await res.json()) as T };
}

export type { ObligationView } from "./explain.js";

export type ConnectionView = {
  id: string;
  provider: string;
  external_account_label: string;
  status: "active" | "expired" | "revoked" | "error";
  last_synced_at: string | null;
  last_error: string | null;
};

/** An entry in the intent store, in the person's own words. */
export type IntentView = {
  id: string;
  text: string;
  source: "stated" | "observed" | "inferred";
  status: "active" | "proposed" | "retired";
  scope: { kind: "global" | "contact" | "account" | "situation"; value?: string };
  is_rule: boolean;
  evidence: string | null;
  created_at: string;
};

/** A detection the person's own rule set aside. */
export type SkippedView = {
  id: string;
  subject: string;
  contact_display_name: string;
  kind: string;
  intent_text: string | null;
};

/** A write to the CRM, at whatever point it has reached. */
export type ActionView = {
  id: string;
  kind: string;
  status:
    "proposed" | "approved" | "applied" | "verified" | "failed" | "stale" | "declined" | "reverted";
  diff_sha256: string;
  summary: string;
  detail: string;
  quotes: string[];
  approved_by: "user" | "promotion" | null;
  external_id: string | null;
  verified: boolean;
  error: string | null;
  created_at: string;
  can_revert: boolean;
  can_promote: boolean;
  record: string;
  contact_display_name: string;
  changes: Array<{
    field: "next_step" | "close_date" | "subject" | "date" | "to";
    from: string | null;
    to: string;
  }>;
  message: string | null;
};

/** A routine the agent found in what the person did. */
export type RoutineView = {
  id: string;
  title: string;
  summary: string;
  status: "candidate" | "eligible";
  decision: "dismissed" | "accepted" | "never" | null;
  intent_id: string | null;
  occurrence_count: number;
  distinct_day_count: number;
  first_seen_at: string;
  last_seen_at: string;
  steps: Array<{
    order: number;
    observed: string;
    app: string;
    repeats: number;
    automation: "automated" | "context" | "manual";
    mode: "read" | "propose_write" | "write" | null;
  }>;
  evidence: Array<{
    started_at: string;
    ended_at: string;
    contact_display_name: string | null;
    events: number;
  }>;
  why_not: string[];
  required_capabilities: string[];
  agent_id: string | null;
  plan: string[];
  compile_problem: string | null;
  runs: {
    mode: "shadow" | "supervised" | null;
    shadow_completed: number;
    shadow_successful: number;
    required: number;
    ready_to_start: boolean;
    latest_agreement: number | null;
    supervised_completed: number;
    recent: Array<{
      triggered_at: string;
      mode: "shadow" | "supervised";
      status: "watching" | "completed" | "skipped" | "failed";
      agreement: number | null;
      missing_rules: string[];
      case_ref: string | null;
    }>;
  } | null;
};

export type OrgConnectorView = {
  id: string;
  provider: string;
  display_label: string;
  status: "connected" | "degraded" | "revoked";
  expires_at: string | null;
  last_verified_at: string | null;
};

export const me = {
  obligations: () =>
    call<{
      obligations: ObligationView[];
      skipped: SkippedView[];
      drafts_this_week: { drafted: number; sent: number; sent_as_written: number };
      agent_mode: "off" | "assist";
    }>("GET", "/v1/me/obligations"),
  intents: () => call<{ intents: IntentView[] }>("GET", "/v1/me/intents"),
  actions: () => call<{ actions: ActionView[] }>("GET", "/v1/me/actions"),
  proposeCrmUpdate: (obligationId: string) =>
    call<{ result: { proposed: number; nothing_to_change: number } }>(
      "POST",
      `/v1/me/obligations/${obligationId}/update-crm`,
    ),
  proposeSend: (obligationId: string) =>
    call<{ action: { id: string; diff_sha256: string } }>(
      "POST",
      `/v1/me/obligations/${obligationId}/send`,
    ),
  proposeLog: (obligationId: string) =>
    call<{ action: { id: string; diff_sha256: string } }>(
      "POST",
      `/v1/me/obligations/${obligationId}/log`,
    ),
  approveAction: (id: string, diff_sha256: string) =>
    call<{ id: string; status: string; verified: boolean }>(
      "POST",
      `/v1/me/actions/${id}/approve`,
      { diff_sha256 },
    ),
  declineAction: (id: string) => call<{ id: string }>("POST", `/v1/me/actions/${id}/decline`),
  revertAction: (id: string) => call<{ id: string }>("POST", `/v1/me/actions/${id}/revert`),
  alwaysAction: (id: string) => call<{ id: string }>("POST", `/v1/me/actions/${id}/always`),
  routines: () => call<{ routines: RoutineView[] }>("GET", "/v1/me/routines"),
  decideRoutine: (id: string, decision: "dismissed" | "never" | "accepted") =>
    call<{ routine: RoutineView }>("POST", `/v1/me/routines/${id}/decide`, { decision }),
  startRoutine: (id: string) =>
    call<{ routine: RoutineView }>("POST", `/v1/me/routines/${id}/start`),
  stateIntent: (text: string) => call<{ intent: IntentView }>("POST", "/v1/me/intents", { text }),
  retireIntent: (id: string) => call<{ id: string }>("POST", `/v1/me/intents/${id}/retire`),
  keepIntent: (id: string) => call<{ id: string }>("POST", `/v1/me/intents/${id}/keep`),
  connections: () => call<{ connections: ConnectionView[] }>("GET", "/v1/me/connections"),
  authorize: (provider: string) =>
    call<{ authorization_url: string }>("POST", `/v1/me/connections/${provider}/authorize`),
  sync: () => call<{ ok: true; obligations_written: number }>("POST", "/v1/me/sync"),
  outcome: (
    id: string,
    outcome: "snoozed" | "dismissed" | "resolved",
    opts: { snoozed_until?: string; note?: string } = {},
  ) =>
    call<{ id: string }>("POST", `/v1/me/obligations/${id}/outcome`, {
      outcome,
      ...(opts.snoozed_until ? { snoozed_until: opts.snoozed_until } : {}),
      ...(opts.note ? { note: opts.note } : {}),
    }),
  /** The ORGANIZATION's connectors (CRM). Status views only, like everything here. */
  connectors: () =>
    call<{ providers: { id: string; display_name: string }[]; connected: OrgConnectorView[] }>(
      "GET",
      "/v1/connectors",
    ),
  connectOrg: (provider: string) =>
    call<{ authorization_url: string }>("POST", `/v1/connectors/${provider}/authorize`),
  disconnectOrg: (provider: string) =>
    call<{ disconnected: boolean }>("POST", `/v1/connectors/${provider}/disconnect`),
  draft: (id: string) =>
    call<{ draft_id: string; to: string; subject: string }>(
      "POST",
      `/v1/me/obligations/${id}/draft`,
    ),
};

export {
  draftsLine,
  explain,
  formingLine,
  gmailDraftUrl,
  nextMeetingLine,
  routineEvidenceLine,
  routineRunsLine,
  initials,
  longDate,
  checkedLine,
  stepLine,
} from "./explain.js";
