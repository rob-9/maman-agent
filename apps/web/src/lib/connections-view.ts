/**
 * What the Connections page says about each integration. Pure functions
 * over the API's status views, so the words are testable without a browser
 * and cannot drift from the states the API reports.
 */

export type Tone = "ok" | "warn" | "bad" | "none";
export type Presentation = { tone: Tone; label: string; detail: string };

export type PersonalConnection = {
  status: "active" | "expired" | "revoked" | "error";
  last_synced_at: string | null;
  last_error: string | null;
};

export type OrgConnector = {
  provider: string;
  status: "connected" | "degraded" | "revoked";
  last_verified_at: string | null;
};

/** "just now", "12 min ago", "3 h ago", "2 d ago". Coarse on purpose. */
export function relative(iso: string, now: Date = new Date()): string {
  const ms = now.getTime() - Date.parse(iso);
  if (!Number.isFinite(ms) || ms < 60_000) return "just now";
  const min = Math.floor(ms / 60_000);
  if (min < 60) return `${min} min ago`;
  const h = Math.floor(min / 60);
  if (h < 24) return `${h} h ago`;
  return `${Math.floor(h / 24)} d ago`;
}

export function describeGmail(c: PersonalConnection | undefined, now?: Date): Presentation {
  if (!c) {
    return { tone: "none", label: "Not connected", detail: "Nothing is read until you connect." };
  }
  switch (c.status) {
    case "active":
      return {
        tone: "ok",
        label: "Connected",
        detail: c.last_synced_at ? `Checked ${relative(c.last_synced_at, now)}` : "Not checked yet",
      };
    case "expired":
      return {
        tone: "warn",
        label: "Needs reconnecting",
        detail: "Google access has expired. Reconnect to resume.",
      };
    case "revoked":
      return { tone: "bad", label: "Access revoked", detail: "Reconnect to resume." };
    case "error":
      return {
        tone: "bad",
        label: "Needs attention",
        detail: c.last_error ? `Last check failed: ${c.last_error}` : "The last check failed.",
      };
  }
}

export function describeCrm(c: OrgConnector | undefined): Presentation {
  if (!c) {
    return {
      tone: "none",
      label: "Not connected",
      detail: "Nothing is read until an admin connects it.",
    };
  }
  switch (c.status) {
    case "connected":
      return {
        tone: "ok",
        label: "Connected for your team",
        detail: c.last_verified_at ? `Verified ${relative(c.last_verified_at)}` : "Verified",
      };
    case "degraded":
      return {
        tone: "warn",
        label: "Needs attention",
        detail: "The last check reported a problem.",
      };
    case "revoked":
      return {
        tone: "bad",
        label: "Disconnected",
        detail: "Reconnect to rank by deal value again.",
      };
  }
}

export type Notice = { tone: "ok" | "bad"; text: string };

/** The one-line banner after an OAuth round-trip, from the callback's landing URL. */
export function noticeFrom(params: {
  provider?: string;
  connected?: string;
  error?: string;
}): Notice | null {
  const names: Record<string, string> = { gmail: "Gmail", salesforce: "Salesforce" };
  const name = params.provider ? (names[params.provider] ?? params.provider) : "";
  if (params.connected) return { tone: "ok", text: `${name} connected.` };
  if (params.error) {
    const why =
      params.error === "exchange_failed"
        ? `${name} sign-in did not complete. Try again.`
        : params.error === "state_reused"
          ? `That ${name} sign-in link was already used. Start again from this page.`
          : `Could not connect ${name} (${params.error}).`;
    return { tone: "bad", text: why };
  }
  return null;
}
