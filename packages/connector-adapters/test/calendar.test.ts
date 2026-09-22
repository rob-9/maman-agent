import { describe, expect, it } from "vitest";
import type { HttpRequest, HttpResponse } from "../src/http.js";
import type { ProviderCredentials, UserCredentialProvider } from "../src/credentials.js";
import { syncCalendarEvents } from "../src/calendar.js";

const KEY = { organization_id: "org-1", user_id: "user-1" };
const NOW = new Date("2026-09-21T12:00:00Z");
const event = (id: string, when: string, who = "sarah@acme.com") => ({
  id,
  status: "confirmed",
  summary: `Meeting ${id}`,
  start: { dateTime: when },
  end: { dateTime: when },
  attendees: [{ email: "me@acme.com", self: true }, { email: who }],
});

function fakeCalendar(script: (req: HttpRequest, n: number) => HttpResponse) {
  const requests: HttpRequest[] = [];
  const transport = async (req: HttpRequest): Promise<HttpResponse> => {
    const res = script(req, requests.length);
    requests.push(req);
    return res;
  };
  const credentials: UserCredentialProvider = {
    load: async () => ({ access_token: "tok" }) as ProviderCredentials,
    refresh: async () => ({ access_token: "fresh" }) as ProviderCredentials,
  };
  return { transport, credentials, requests };
}
const page = (items: unknown[], extra: Record<string, unknown> = {}): HttpResponse => ({
  status: 200,
  headers: {},
  body: { items, ...extra },
});

describe("syncCalendarEvents", () => {
  it("first sync: a bounded window of single events, every request a GET, and a token for next time", async () => {
    const g = fakeCalendar(() =>
      page([event("a", "2026-09-17T15:00:00Z")], { nextSyncToken: "tok-1" }),
    );
    const r = await syncCalendarEvents(g, KEY, { self_addresses: ["me@acme.com"], now: () => NOW });
    expect(g.requests).toHaveLength(1);
    const p = new URL(g.requests[0]!.url).searchParams;
    expect(g.requests[0]!.method).toBe("GET");
    expect(
      g.requests[0]!.url.startsWith(
        "https://www.googleapis.com/calendar/v3/calendars/primary/events?",
      ),
    ).toBe(true);
    expect(p.get("singleEvents")).toBe("true");
    expect(p.get("timeMin")).toBe("2026-07-23T12:00:00.000Z");
    expect(p.get("timeMax")).toBe("2026-10-21T12:00:00.000Z");
    expect(p.get("syncToken")).toBeNull();
    expect(r.next_sync_token).toBe("tok-1");
    expect(r.meetings.map((m) => m.external_id)).toEqual(["a"]);
    expect(r.resynced).toBe(false);
  });

  it("later syncs send the token and no window, follow pages, and report cancellations", async () => {
    const g = fakeCalendar((req, n) =>
      n === 0
        ? page([event("a", "2026-09-17T15:00:00Z")], { nextPageToken: "p2" })
        : page([{ id: "b", status: "cancelled" }], { nextSyncToken: "tok-2" }),
    );
    const r = await syncCalendarEvents(g, KEY, {
      sync_token: "tok-1",
      self_addresses: ["me@acme.com"],
      now: () => NOW,
    });
    expect(g.requests).toHaveLength(2);
    const first = new URL(g.requests[0]!.url).searchParams;
    expect(first.get("syncToken")).toBe("tok-1");
    expect(first.get("timeMin")).toBeNull();
    expect(new URL(g.requests[1]!.url).searchParams.get("pageToken")).toBe("p2");
    expect(r.cancelled).toEqual(["b"]);
    expect(r.listed).toBe(2);
    expect(r.next_sync_token).toBe("tok-2");
  });

  it("a stale token (410) means a full window again, not an error", async () => {
    const g = fakeCalendar((req, n) =>
      n === 0
        ? { status: 410, headers: {}, body: {} }
        : page([event("a", "2026-09-17T15:00:00Z")], { nextSyncToken: "tok-3" }),
    );
    const r = await syncCalendarEvents(g, KEY, {
      sync_token: "old",
      self_addresses: ["me@acme.com"],
      now: () => NOW,
    });
    expect(r.resynced).toBe(true);
    expect(new URL(g.requests[1]!.url).searchParams.get("timeMin")).not.toBeNull();
    expect(r.next_sync_token).toBe("tok-3");
  });

  it("refreshes once on 401 and retries", async () => {
    const g = fakeCalendar((req) =>
      req.headers["authorization"] === "Bearer fresh"
        ? page([], { nextSyncToken: "t" })
        : { status: 401, headers: {}, body: {} },
    );
    await syncCalendarEvents(g, KEY, { self_addresses: [], now: () => NOW });
    expect(g.requests.map((r) => r.headers["authorization"])).toEqual([
      "Bearer tok",
      "Bearer fresh",
    ]);
  });
});
