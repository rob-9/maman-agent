import { PermanentAdapterError } from "@maman/agent-runtime";
import type { HttpResponse, HttpTransport } from "./http.js";
import {
  throwForStatus,
  throwTransientNetwork,
  type UserCredentialKey,
  type UserCredentialProvider,
} from "./credentials.js";
import { projectThreads, type GmailThread, type ProjectedThread } from "./gmail-project.js";

/**
 * Gmail sync — the HTTP half. Everything that needs a network lives here;
 * everything that needs a brain lives in gmail-project.ts and is tested
 * without one.
 *
 * READ-ONLY. Every request is a GET. Threads are fetched in full, because
 * the conversation is the agent's input, and only when they have changed:
 * Gmail's per-thread historyId is compared with what the caller already
 * holds, so an unchanged thread costs one list entry and no fetch. That is
 * what makes a full-content sync affordable every fifteen minutes.
 *
 * Per-USER credentials. See UserCredentialProvider — an org-keyed provider
 * here would give every rep the same mailbox.
 */

const PROVIDER = "gmail";
const GMAIL_BASE = "https://gmail.googleapis.com/gmail/v1/users/me";

/** A page size Gmail accepts; also the floor for `max_threads`. */
const PAGE_SIZE = 100;

export type GmailSyncConfig = {
  credentials: UserCredentialProvider;
  transport: HttpTransport;
};

export type GmailSyncOptions = {
  /**
   * Upper bound on threads fetched in one sync. A mailbox can hold hundreds
   * of thousands; detection cares about the recent ones. Defaults to 300.
   */
  max_threads?: number;
  /** Only threads with activity in the last N days. Defaults to 60. */
  newer_than_days?: number;
  /**
   * external_id → history_id already held. A listed thread whose history id
   * matches is reported as unchanged and not fetched.
   */
  known?: ReadonlyMap<string, string>;
};

export type GmailSyncResult = {
  /** The user's own addresses, as Gmail reports them. */
  self_addresses: string[];
  threads: ProjectedThread[];
  /** How many thread ids were listed before projection dropped the unusable. */
  listed: number;
  /** True when the bound stopped the list before Gmail ran out of pages. */
  truncated: boolean;
  /** Listed, held already, and unchanged: not fetched. */
  unchanged: string[];
};

type Profile = { emailAddress?: string };
type ThreadList = {
  threads?: Array<{ id: string; historyId?: string }>;
  nextPageToken?: string;
};

export async function syncGmailThreads(
  config: GmailSyncConfig,
  key: Omit<UserCredentialKey, "provider">,
  options: GmailSyncOptions = {},
): Promise<GmailSyncResult> {
  const credKey: UserCredentialKey = { ...key, provider: PROVIDER };
  const maxThreads = Math.max(PAGE_SIZE, options.max_threads ?? 300);
  const newerThanDays = Math.max(1, options.newer_than_days ?? 60);

  let creds = await config.credentials.load(credKey);
  if (!creds) throw new PermanentAdapterError("gmail.sync: no linked Gmail connection");

  const run = async (token: string, url: string): Promise<HttpResponse> => {
    try {
      return await config.transport({
        method: "GET",
        url,
        headers: { authorization: `Bearer ${token}`, accept: "application/json" },
      });
    } catch (e) {
      throwTransientNetwork("gmail.sync", e);
    }
  };

  /** GET with the same 401 → refresh → single retry discipline as the other adapters. */
  const get = async (url: string): Promise<unknown> => {
    let res = await run(creds!.access_token, url);
    if (res.status === 401) {
      creds = await config.credentials.refresh(credKey);
      res = await run(creds.access_token, url);
      if (res.status === 401)
        throw new PermanentAdapterError("gmail.sync: unauthorized after refresh");
    }
    if (res.status < 200 || res.status >= 300) {
      throwForStatus("gmail.sync", res.status, summarizeGoogleError(res.body));
    }
    return res.body;
  };

  // 1. Who am I. Direction — whose turn it is — depends entirely on this.
  const profile = (await get(`${GMAIL_BASE}/profile`)) as Profile;
  if (!profile.emailAddress) {
    throw new PermanentAdapterError("gmail.sync: profile carried no email address");
  }
  const selfAddresses = [profile.emailAddress];

  // 2. Which threads. Bounded and recency-filtered server-side.
  const listed: Array<{ id: string; historyId?: string }> = [];
  let pageToken: string | undefined;
  let truncated = false;
  do {
    const params = new URLSearchParams({
      maxResults: String(Math.min(PAGE_SIZE, maxThreads - listed.length)),
      q: `newer_than:${newerThanDays}d`,
    });
    if (pageToken) params.set("pageToken", pageToken);
    const page = (await get(`${GMAIL_BASE}/threads?${params.toString()}`)) as ThreadList;
    for (const t of page.threads ?? []) listed.push(t);
    pageToken = page.nextPageToken;
    if (listed.length >= maxThreads && pageToken) {
      truncated = true;
      break;
    }
  } while (pageToken);

  // 3. Full content, one request per CHANGED thread. Sequential on purpose: a
  // burst of a few hundred concurrent requests is how a connector gets
  // rate-limited on its first sync and then reported as "broken".
  const raw: GmailThread[] = [];
  const unchanged: string[] = [];
  for (const t of listed) {
    const held = options.known?.get(t.id);
    if (held !== undefined && t.historyId !== undefined && held === t.historyId) {
      unchanged.push(t.id);
      continue;
    }
    const params = new URLSearchParams({ format: "full" });
    const fetched = (await get(
      `${GMAIL_BASE}/threads/${encodeURIComponent(t.id)}?${params}`,
    )) as GmailThread;
    // The list is authoritative for the id we compare against next time.
    const historyId = fetched.historyId ?? t.historyId;
    raw.push(historyId !== undefined ? { ...fetched, historyId } : fetched);
  }

  return {
    self_addresses: selfAddresses,
    threads: projectThreads(raw, selfAddresses),
    listed: listed.length,
    truncated,
    unchanged,
  };
}

/** Google's error envelope, reduced to a message; never the whole body. */
function summarizeGoogleError(body: unknown): string {
  if (body && typeof body === "object" && "error" in body) {
    const err = (body as { error?: { message?: string } }).error;
    if (err?.message) return err.message;
  }
  return "request failed";
}
