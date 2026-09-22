import { PermanentAdapterError } from "@maman/agent-runtime";
import type { HttpResponse, HttpTransport } from "./http.js";
import {
  throwForStatus,
  throwTransientNetwork,
  type UserCredentialKey,
  type UserCredentialProvider,
} from "./credentials.js";
import { projectEvents, type CalendarEvent, type ProjectedMeeting } from "./calendar-project.js";

/**
 * Google Calendar sync. The HTTP half; calendar-project.ts is the brain.
 *
 * READ-ONLY, every request a GET, on the same Google grant as the mailbox
 * (one consent covers both). The first sync takes a window (past and
 * upcoming); every later sync sends Google's sync token and gets only what
 * changed, including cancellations. Google answers 410 when a token is too
 * old; that is a full window fetch again, not an error.
 */

const PROVIDER = "gmail";
const CAL_BASE = "https://www.googleapis.com/calendar/v3/calendars/primary/events";
const PAGE_SIZE = 250;

export type CalendarSyncConfig = {
  credentials: UserCredentialProvider;
  transport: HttpTransport;
};

export type CalendarSyncOptions = {
  /** Google's token from the last sync. Absent → full window. */
  sync_token?: string | undefined;
  /** Window for a full fetch. Defaults: 60 days back, 30 forward. */
  days_back?: number;
  days_forward?: number;
  now?: () => Date;
  /** The user's own addresses, to tell them from their attendees. */
  self_addresses: readonly string[];
};

export type CalendarSyncResult = {
  meetings: ProjectedMeeting[];
  /** Ids of events Google reported as cancelled (incremental only). */
  cancelled: string[];
  listed: number;
  /** For the next sync. */
  next_sync_token: string | null;
  /** True when the old token was refused and a full window was fetched instead. */
  resynced: boolean;
};

type EventsPage = {
  items?: CalendarEvent[];
  nextPageToken?: string;
  nextSyncToken?: string;
};

export async function syncCalendarEvents(
  config: CalendarSyncConfig,
  key: Omit<UserCredentialKey, "provider">,
  options: CalendarSyncOptions,
): Promise<CalendarSyncResult> {
  const credKey: UserCredentialKey = { ...key, provider: PROVIDER };
  const now = options.now ?? (() => new Date());
  let creds = await config.credentials.load(credKey);
  if (!creds) throw new PermanentAdapterError("calendar.sync: no linked Google connection");

  const run = async (token: string, url: string): Promise<HttpResponse> => {
    try {
      return await config.transport({
        method: "GET",
        url,
        headers: { authorization: `Bearer ${token}`, accept: "application/json" },
      });
    } catch (e) {
      throwTransientNetwork("calendar.sync", e);
    }
  };
  const get = async (url: string): Promise<HttpResponse> => {
    let res = await run(creds!.access_token, url);
    if (res.status === 401) {
      creds = await config.credentials.refresh(credKey);
      res = await run(creds.access_token, url);
      if (res.status === 401)
        throw new PermanentAdapterError("calendar.sync: unauthorized after refresh");
    }
    return res;
  };

  const fetchAll = async (
    base: URLSearchParams,
  ): Promise<{ items: CalendarEvent[]; nextSyncToken: string | null } | "gone"> => {
    const items: CalendarEvent[] = [];
    let pageToken: string | undefined;
    let nextSyncToken: string | null = null;
    do {
      const params = new URLSearchParams(base);
      if (pageToken) params.set("pageToken", pageToken);
      const res = await get(`${CAL_BASE}?${params.toString()}`);
      if (res.status === 410) return "gone";
      if (res.status < 200 || res.status >= 300) throwForStatus("calendar.sync", res.status);
      const page = res.body as EventsPage;
      items.push(...(page.items ?? []));
      pageToken = page.nextPageToken;
      if (page.nextSyncToken) nextSyncToken = page.nextSyncToken;
    } while (pageToken);
    return { items, nextSyncToken };
  };

  const windowParams = (): URLSearchParams => {
    const t = now().getTime();
    return new URLSearchParams({
      singleEvents: "true",
      maxResults: String(PAGE_SIZE),
      timeMin: new Date(t - (options.days_back ?? 60) * 86_400_000).toISOString(),
      timeMax: new Date(t + (options.days_forward ?? 30) * 86_400_000).toISOString(),
    });
  };

  let resynced = false;
  let fetched: { items: CalendarEvent[]; nextSyncToken: string | null } | "gone";
  if (options.sync_token) {
    fetched = await fetchAll(
      new URLSearchParams({
        singleEvents: "true",
        maxResults: String(PAGE_SIZE),
        syncToken: options.sync_token,
      }),
    );
    if (fetched === "gone") {
      resynced = true;
      fetched = await fetchAll(windowParams());
    }
  } else {
    fetched = await fetchAll(windowParams());
  }
  if (fetched === "gone") throw new PermanentAdapterError("calendar.sync: window fetch refused");

  const cancelled = fetched.items.filter((e) => e.status === "cancelled").map((e) => e.id);
  return {
    meetings: projectEvents(fetched.items, options.self_addresses),
    cancelled,
    listed: fetched.items.length,
    next_sync_token: fetched.nextSyncToken,
    resynced,
  };
}
