import { describe, expect, it, vi } from "vitest";
import { PermanentAdapterError, TransientAdapterError } from "@maman/agent-runtime";
import {
  salesforceDealSource,
  SF_DEAL_QUERY_CHUNK,
  type CredentialProvider,
  type HttpRequest,
  type HttpResponse,
  type ProviderCredentials,
} from "../src/index.js";
import { dealQuery } from "../src/salesforce-deals.js";

/**
 * Salesforce answering "is there an open deal with this person?" — pinned on
 * the REQUESTS it makes (read-only, this org's instance, the token as a
 * bearer and nowhere else) and on the exact mapping of rows to the tri-state.
 */

const ctx = { organization_id: "org-1", user_id: "user-1" };
const creds: ProviderCredentials = {
  access_token: "tok-1",
  instance_url: "https://na1.example.com/",
};

function credentials(initial: ProviderCredentials | null, refreshed?: ProviderCredentials) {
  let current = initial;
  const refresh = vi.fn(async () => {
    if (!refreshed) throw new PermanentAdapterError("no refresh");
    current = refreshed;
    return current;
  });
  const provider: CredentialProvider = { load: async () => current, refresh };
  return { provider, refresh };
}

function transport(handler: (req: HttpRequest, n: number) => HttpResponse | Promise<HttpResponse>) {
  const calls: HttpRequest[] = [];
  return {
    calls,
    transport: async (req: HttpRequest): Promise<HttpResponse> => {
      const res = await handler(req, calls.length);
      calls.push(req);
      return res;
    },
  };
}

const row = (email: string, amount: number | null, closed: boolean, account = "Client Co") => ({
  Contact: { Email: email, Account: { Name: account } },
  Opportunity: { Amount: amount, IsClosed: closed },
});
const page = (records: unknown[], more?: string): HttpResponse => ({
  status: 200,
  headers: {},
  body: { records, done: !more, ...(more ? { nextRecordsUrl: more } : {}) },
});
const soqlOf = (req: HttpRequest) => new URL(req.url).searchParams.get("q");

describe("the query", () => {
  it("reads deals THIS person is on, by exact address list, with literals escaped", () => {
    expect(dealQuery(["a@x.com", "o'brien@x.com"])).toBe(
      "SELECT Contact.Email, Contact.Account.Name, Opportunity.Amount, Opportunity.IsClosed " +
        "FROM OpportunityContactRole WHERE Contact.Email IN ('a@x.com', 'o\\'brien@x.com')",
    );
  });

  it("goes to this org's instance, as a GET, with the vault token as bearer and nothing else", async () => {
    const t = transport(() => page([]));
    await salesforceDealSource({
      credentials: credentials(creds).provider,
      transport: t.transport,
    }).lookup(ctx, ["a@x.com"]);
    expect(t.calls).toHaveLength(1);
    const req = t.calls[0]!;
    expect(req.method).toBe("GET");
    expect(req.url.startsWith("https://na1.example.com/services/data/v60.0/query?q=")).toBe(true);
    expect(req.headers).toEqual({ authorization: "Bearer tok-1", accept: "application/json" });
    expect(req.body).toBeUndefined();
  });

  it("chunks long address lists so no single query outgrows Salesforce's limits", async () => {
    const t = transport(() => page([]));
    const addresses = Array.from({ length: SF_DEAL_QUERY_CHUNK + 1 }, (_, i) => `p${i}@x.com`);
    await salesforceDealSource({
      credentials: credentials(creds).provider,
      transport: t.transport,
    }).lookup(ctx, addresses);
    expect(t.calls).toHaveLength(2);
    expect(soqlOf(t.calls[1]!)).toContain(`IN ('p${SF_DEAL_QUERY_CHUNK}@x.com')`);
  });

  it("follows pagination so a person with many deals is not read as having few", async () => {
    const t = transport((req, n) =>
      n === 0
        ? page([row("bob@client.com", 10, false)], "/services/data/v60.0/query/01gXX-2000")
        : page([row("bob@client.com", 5, false)]),
    );
    const answer = await salesforceDealSource({
      credentials: credentials(creds).provider,
      transport: t.transport,
    }).lookup(ctx, ["bob@client.com"]);
    expect(t.calls[1]!.url).toBe("https://na1.example.com/services/data/v60.0/query/01gXX-2000");
    expect(answer.signals).toEqual([
      {
        address: "bob@client.com",
        has_open_deal: true,
        open_deal_value: 15,
        account_name: "Client Co",
      },
    ]);
  });
});

describe("the mapping", () => {
  it("open = any open opportunity, summed; closed = deals but none open; unknown = not returned", async () => {
    const t = transport(() =>
      page([
        row("bob@client.com", 30_000, false),
        row("bob@client.com", 10_000, false),
        row("bob@client.com", 5_000, true),
        row("carol@client.com", 8_000, true, "Carol Inc"),
        row("carol@client.com", null, true, "Carol Inc"),
        // Not asked about: must not appear.
        row("stranger@else.com", 1, false),
      ]),
    );
    const answer = await salesforceDealSource({
      credentials: credentials(creds).provider,
      transport: t.transport,
    }).lookup(ctx, ["bob@client.com", "carol@client.com", "dan@client.com"]);
    expect(answer.asked).toEqual(["bob@client.com", "carol@client.com", "dan@client.com"]);
    expect(answer.signals).toEqual([
      {
        address: "bob@client.com",
        has_open_deal: true,
        open_deal_value: 40_000,
        account_name: "Client Co",
      },
      { address: "carol@client.com", has_open_deal: false, account_name: "Carol Inc" },
    ]);
  });

  it("matches addresses case-insensitively and answers with the spelling that was asked", async () => {
    const t = transport(() => page([row("Bob@Client.COM", 100, false)]));
    const answer = await salesforceDealSource({
      credentials: credentials(creds).provider,
      transport: t.transport,
    }).lookup(ctx, ["bob@client.com"]);
    expect(answer.signals[0]).toMatchObject({ address: "bob@client.com", has_open_deal: true });
  });

  it("an open opportunity with no amount is still open, worth 0", async () => {
    const t = transport(() => page([row("bob@client.com", null, false)]));
    const answer = await salesforceDealSource({
      credentials: credentials(creds).provider,
      transport: t.transport,
    }).lookup(ctx, ["bob@client.com"]);
    expect(answer.signals[0]).toMatchObject({ has_open_deal: true, open_deal_value: 0 });
  });
});

describe("credentials and failures", () => {
  it("refreshes ONCE on 401 and retries with the new token", async () => {
    const c = credentials(creds, {
      access_token: "tok-2",
      instance_url: "https://na1.example.com",
    });
    const t = transport((req) =>
      req.headers["authorization"] === "Bearer tok-2"
        ? page([])
        : { status: 401, headers: {}, body: {} },
    );
    await salesforceDealSource({ credentials: c.provider, transport: t.transport }).lookup(ctx, [
      "a@x.com",
    ]);
    expect(c.refresh).toHaveBeenCalledTimes(1);
    expect(t.calls.map((r) => r.headers["authorization"])).toEqual([
      "Bearer tok-1",
      "Bearer tok-2",
    ]);
  });

  it("a 401 after refresh is permanent — no loop", async () => {
    const c = credentials(creds, {
      access_token: "tok-2",
      instance_url: "https://na1.example.com",
    });
    const t = transport(() => ({ status: 401, headers: {}, body: {} }));
    await expect(
      salesforceDealSource({ credentials: c.provider, transport: t.transport }).lookup(ctx, [
        "a@x.com",
      ]),
    ).rejects.toBeInstanceOf(PermanentAdapterError);
    expect(t.calls).toHaveLength(2);
  });

  it("maps provider failures to the fault taxonomy: 5xx transient, 4xx permanent, network transient", async () => {
    const src = (h: (req: HttpRequest) => HttpResponse | Promise<HttpResponse>) =>
      salesforceDealSource({
        credentials: credentials(creds).provider,
        transport: transport(h).transport,
      });
    await expect(
      src(() => ({ status: 503, headers: {}, body: {} })).lookup(ctx, ["a@x.com"]),
    ).rejects.toBeInstanceOf(TransientAdapterError);
    await expect(
      src(() => ({ status: 403, headers: {}, body: {} })).lookup(ctx, ["a@x.com"]),
    ).rejects.toBeInstanceOf(PermanentAdapterError);
    await expect(
      src(() => {
        throw new Error("ECONNRESET");
      }).lookup(ctx, ["a@x.com"]),
    ).rejects.toBeInstanceOf(TransientAdapterError);
  });

  it("no linked connector, or a token without an instance URL, is permanent and makes no request", async () => {
    const t = transport(() => page([]));
    await expect(
      salesforceDealSource({
        credentials: credentials(null).provider,
        transport: t.transport,
      }).lookup(ctx, ["a@x.com"]),
    ).rejects.toBeInstanceOf(PermanentAdapterError);
    await expect(
      salesforceDealSource({
        credentials: credentials({ access_token: "tok" }).provider,
        transport: t.transport,
      }).lookup(ctx, ["a@x.com"]),
    ).rejects.toBeInstanceOf(PermanentAdapterError);
    expect(t.calls).toHaveLength(0);
  });

  it("asks nothing for an empty list", async () => {
    const t = transport(() => page([]));
    const answer = await salesforceDealSource({
      credentials: credentials(creds).provider,
      transport: t.transport,
    }).lookup(ctx, []);
    expect(answer).toEqual({ asked: [], signals: [] });
    expect(t.calls).toHaveLength(0);
  });
});
