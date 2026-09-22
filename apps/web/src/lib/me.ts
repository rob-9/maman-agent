import "server-only";
import { DevIdentityError, identityHeaders } from "./session.js";

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

export type ObligationView = {
  id: string;
  thread_id: string;
  contact_id: string;
  kind: "awaiting_you" | "awaiting_them" | "unsent_followup";
  rank: number;
  reason: {
    days_elapsed: number;
    threshold_days: number;
    last_direction: "inbound" | "outbound";
    message_count: number;
    has_open_deal: boolean | null;
    open_deal_value?: number;
  };
  detected_at: string;
  subject: string;
  contact_display_name: string;
  contact_account_name: string | null;
};

export type ConnectionView = {
  id: string;
  provider: string;
  external_account_label: string;
  status: "active" | "expired" | "revoked" | "error";
  last_synced_at: string | null;
  last_error: string | null;
};

export const me = {
  obligations: () => call<{ obligations: ObligationView[] }>("GET", "/v1/me/obligations"),
  connections: () => call<{ connections: ConnectionView[] }>("GET", "/v1/me/connections"),
  authorize: (provider: string) =>
    call<{ authorization_url: string }>("POST", `/v1/me/connections/${provider}/authorize`),
  sync: () => call<{ ok: true; obligations_written: number }>("POST", "/v1/me/sync"),
  outcome: (id: string, outcome: "snoozed" | "dismissed" | "resolved", snoozed_until?: string) =>
    call<{ id: string }>("POST", `/v1/me/obligations/${id}/outcome`, {
      outcome,
      ...(snoozed_until ? { snoozed_until } : {}),
    }),
  draft: (id: string) =>
    call<{ draft_id: string; to: string; subject: string }>(
      "POST",
      `/v1/me/obligations/${id}/draft`,
    ),
};

/**
 * The sentence for a card. Written here, from the FACTS the detector carried,
 * so the API never renders copy and the copy can never disagree with the
 * arithmetic. Every number below came from `reason`.
 */
export function explain(o: ObligationView): { headline: string; detail: string } {
  const who = o.contact_display_name;
  const d = o.reason.days_elapsed;
  const days = d === 1 ? "1 day" : `${d} days`;
  switch (o.kind) {
    case "awaiting_you":
      return {
        headline: `${who} is waiting on you`,
        detail: `They wrote ${days} ago on "${o.subject}" and you haven't replied.`,
      };
    case "unsent_followup":
      return {
        headline: `No follow-up after meeting ${who}`,
        detail: `You met ${days} ago and nothing has gone out since.`,
      };
    case "awaiting_them":
      return {
        headline: `${who} has gone quiet`,
        detail: `You wrote ${days} ago on "${o.subject}" with no reply.`,
      };
  }
}
