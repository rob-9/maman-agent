import { describe, expect, it } from "vitest";
import { PermanentAdapterError } from "@maman/agent-runtime";
import type { HttpRequest, HttpResponse } from "../src/http.js";
import type { ProviderCredentials, UserCredentialProvider } from "../src/credentials.js";
import { syncGmailThreads } from "../src/gmail.js";

const KEY = { organization_id: "org-1", user_id: "user-1" };
const at = (iso: string) => String(Date.parse(iso));

function thread(id: string, from: string, to: string, when: string) {
  return {
    id,
    messages: [
      {
        id: `${id}-m`,
        internalDate: at(when),
        payload: {
          headers: [
            { name: "From", value: from },
            { name: "To", value: to },
            { name: "Subject", value: `Re: ${id}` },
          ],
        },
      },
    ],
  };
}

/**
 * A scripted Gmail. Records every request so tests can assert on what was
 * asked for — the header allowlist and the absence of any non-GET are the
 * privacy properties, and they live in the request, not the response.
 */
function fakeGmail(opts: {
  self?: string;
  pages?: Array<{ ids: string[]; next?: string }>;
  threads?: Record<string, unknown>;
  unauthorizedUntilRefresh?: boolean;
}) {
  const requests: HttpRequest[] = [];
  let refreshed = false;
  const pages = opts.pages ?? [{ ids: [] }];

  const transport = async (req: HttpRequest): Promise<HttpResponse> => {
    requests.push(req);
    if (opts.unauthorizedUntilRefresh && !req.headers["authorization"]?.endsWith("fresh")) {
      return { status: 401, headers: {}, body: { error: { message: "expired" } } };
    }
    const url = new URL(req.url);
    if (url.pathname.endsWith("/profile")) {
      return { status: 200, headers: {}, body: { emailAddress: opts.self ?? "me@acme.com" } };
    }
    if (url.pathname.endsWith("/threads")) {
      const token = url.searchParams.get("pageToken");
      const idx = token ? Number(token) : 0;
      const page = pages[idx] ?? { ids: [] };
      return {
        status: 200,
        headers: {},
        body: {
          threads: page.ids.map((id) => ({ id })),
          ...(page.next ? { nextPageToken: page.next } : {}),
        },
      };
    }
    const id = decodeURIComponent(url.pathname.split("/").pop()!);
    const body = opts.threads?.[id];
    return body
      ? { status: 200, headers: {}, body }
      : { status: 404, headers: {}, body: { error: { message: "not found" } } };
  };

  const credentials: UserCredentialProvider = {
    load: async () => ({ access_token: "stale" }) as ProviderCredentials,
    refresh: async () => {
      refreshed = true;
      return { access_token: "fresh" } as ProviderCredentials;
    },
  };

  return { transport, credentials, requests, wasRefreshed: () => refreshed };
}

describe("syncGmailThreads", () => {
  it("identifies the user from the profile and projects their threads", async () => {
    const g = fakeGmail({
      self: "me@acme.com",
      pages: [{ ids: ["a", "b"] }],
      threads: {
        a: thread("a", "me@acme.com", "bob@client.com", "2026-09-10T09:00:00Z"),
        b: thread("b", "carol@client.com", "me@acme.com", "2026-09-11T09:00:00Z"),
      },
    });
    const out = await syncGmailThreads(g, KEY);
    expect(out.self_addresses).toEqual(["me@acme.com"]);
    expect(out.listed).toBe(2);
    expect(out.truncated).toBe(false);
    expect(out.threads.map((t) => [t.external_id, t.last_direction])).toEqual([
      ["a", "outbound"],
      ["b", "inbound"],
    ]);
  });

  it("only ever issues GET requests", async () => {
    // The read-only property lives in the requests, not in any promise. A
    // sync that could POST is a sync that could send.
    const g = fakeGmail({
      pages: [{ ids: ["a"] }],
      threads: { a: thread("a", "x@y.com", "me@acme.com", "2026-09-10T09:00:00Z") },
    });
    await syncGmailThreads(g, KEY);
    expect(g.requests.length).toBeGreaterThan(0);
    expect(g.requests.every((r) => r.method === "GET")).toBe(true);
  });

  it("asks for metadata with an explicit header allowlist, never a body", async () => {
    // format=metadata + metadataHeaders is what keeps content out of the
    // response. gmail.metadata would refuse format=full anyway; this pins that
    // the request and the scope agree.
    const g = fakeGmail({
      pages: [{ ids: ["a"] }],
      threads: { a: thread("a", "x@y.com", "me@acme.com", "2026-09-10T09:00:00Z") },
    });
    await syncGmailThreads(g, KEY);
    const fetches = g.requests.filter((r) => /\/threads\/[^?]+\?/.test(r.url));
    expect(fetches).toHaveLength(1);
    const params = new URL(fetches[0]!.url).searchParams;
    expect(params.get("format")).toBe("metadata");
    expect(params.getAll("metadataHeaders").sort()).toEqual(["From", "Subject", "To"]);
  });

  it("filters by recency server-side", async () => {
    const g = fakeGmail({});
    await syncGmailThreads(g, KEY, { newer_than_days: 14 });
    const list = g.requests.find((r) => new URL(r.url).pathname.endsWith("/threads"))!;
    expect(new URL(list.url).searchParams.get("q")).toBe("newer_than:14d");
  });

  it("follows pages up to the bound, then reports truncation honestly", async () => {
    const ids = (n: number, from: number) => Array.from({ length: n }, (_, i) => `t${from + i}`);
    const g = fakeGmail({
      pages: [
        { ids: ids(100, 0), next: "1" },
        { ids: ids(100, 100), next: "2" },
        { ids: ids(100, 200), next: "3" }, // a fourth page exists but is never fetched
      ],
      threads: Object.fromEntries(
        ids(300, 0).map((id) => [id, thread(id, "x@y.com", "me@acme.com", "2026-09-10T09:00:00Z")]),
      ),
    });
    const out = await syncGmailThreads(g, KEY, { max_threads: 300 });
    expect(out.listed).toBe(300);
    expect(out.truncated).toBe(true);
    // Three list calls, not four.
    expect(g.requests.filter((r) => new URL(r.url).pathname.endsWith("/threads"))).toHaveLength(3);
  });

  it("is not truncated when Gmail simply runs out", async () => {
    const g = fakeGmail({
      pages: [{ ids: ["a"] }],
      threads: { a: thread("a", "x@y.com", "me@acme.com", "2026-09-10T09:00:00Z") },
    });
    const out = await syncGmailThreads(g, KEY, { max_threads: 300 });
    expect(out.truncated).toBe(false);
  });

  it("refreshes once on 401 and retries with the new token", async () => {
    const g = fakeGmail({
      unauthorizedUntilRefresh: true,
      pages: [{ ids: ["a"] }],
      threads: { a: thread("a", "x@y.com", "me@acme.com", "2026-09-10T09:00:00Z") },
    });
    const out = await syncGmailThreads(g, KEY);
    expect(g.wasRefreshed()).toBe(true);
    expect(out.threads).toHaveLength(1);
    // Every request after the refresh carried the fresh token.
    const afterRefresh = g.requests.filter((r) => r.headers["authorization"] === "Bearer fresh");
    expect(afterRefresh.length).toBeGreaterThan(0);
  });

  it("refuses when no Gmail connection is linked", async () => {
    const g = fakeGmail({});
    const noCreds: UserCredentialProvider = {
      load: async () => null,
      refresh: async () => {
        throw new Error("unreachable");
      },
    };
    await expect(syncGmailThreads({ ...g, credentials: noCreds }, KEY)).rejects.toBeInstanceOf(
      PermanentAdapterError,
    );
    expect(g.requests).toHaveLength(0);
  });

  it("refuses a profile with no address rather than guessing who the user is", async () => {
    // Every direction decision depends on knowing self. An empty self set
    // would classify the user's own replies as inbound.
    const g = fakeGmail({ self: "" });
    await expect(syncGmailThreads(g, KEY)).rejects.toThrow(/no email address/);
  });

  it("passes the user key through, never the org alone", async () => {
    // The whole point of UserCredentialProvider: the lookup must carry user_id.
    const seen: unknown[] = [];
    const g = fakeGmail({});
    const spying: UserCredentialProvider = {
      load: async (k) => {
        seen.push(k);
        return { access_token: "t" } as ProviderCredentials;
      },
      refresh: async (k) => {
        seen.push(k);
        return { access_token: "t" } as ProviderCredentials;
      },
    };
    await syncGmailThreads({ ...g, credentials: spying }, KEY);
    expect(seen[0]).toEqual({ organization_id: "org-1", user_id: "user-1", provider: "gmail" });
  });
});
