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
  scope: { kind: "global" | "contact" | "account" | "situation"; value?: string };
  is_rule: boolean;
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
  stateIntent: (text: string) => call<{ intent: IntentView }>("POST", "/v1/me/intents", { text }),
  retireIntent: (id: string) => call<{ id: string }>("POST", `/v1/me/intents/${id}/retire`),
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

export { draftsLine, explain, gmailDraftUrl, nextMeetingLine } from "./explain.js";
