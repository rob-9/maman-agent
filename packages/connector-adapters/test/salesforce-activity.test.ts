import { describe, expect, it, vi } from "vitest";
import { PermanentAdapterError, TransientAdapterError } from "@maman/agent-runtime";
import {
  salesforceActivityWriter,
  type CredentialProvider,
  type HttpRequest,
  type HttpResponse,
  type ProviderCredentials,
} from "../src/index.js";

const ORG = "org-1";
const creds: ProviderCredentials = { access_token: "tok", instance_url: "https://na1.example.com" };
function provider(initial: ProviderCredentials | null = creds, refreshed?: ProviderCredentials) {
  let current = initial;
  const refresh = vi.fn(async () => {
    if (!refreshed) throw new PermanentAdapterError("no refresh");
    current = refreshed;
    return current;
  });
  const p: CredentialProvider = { load: async () => current, refresh };
  return { p, refresh };
}
function script(handler: (req: HttpRequest, n: number) => HttpResponse) {
  const calls: HttpRequest[] = [];
  return {
    calls,
    transport: async (req: HttpRequest) => {
      const res = handler(req, calls.length);
      calls.push(req);
      return res;
    },
  };
}
const ok = (body: unknown): HttpResponse => ({ status: 200, headers: {}, body });
const soqlOf = (req: HttpRequest) => new URL(req.url).searchParams.get("q") ?? "";

describe("finding the records", () => {
  it("looks the contact up by email, and their open opportunity by role, with literals escaped", async () => {
    const t = script((req) =>
      soqlOf(req).includes("FROM Contact")
        ? ok({ records: [{ Id: "003A", AccountId: "001A" }] })
        : ok({ records: [{ OpportunityId: "006A" }] }),
    );
    const w = salesforceActivityWriter({ credentials: provider().p, transport: t.transport });
    expect(await w.findContact(ORG, "o'brien@acme.com")).toEqual({
      id: "003A",
      account_id: "001A",
    });
    expect(soqlOf(t.calls[0]!)).toBe(
      "SELECT Id, AccountId FROM Contact WHERE Email = 'o\\'brien@acme.com' LIMIT 1",
    );
    expect(await w.findOpenOpportunity(ORG, "003A")).toBe("006A");
    expect(soqlOf(t.calls[1]!)).toContain("Opportunity.IsClosed = false");
    const none = script(() => ok({ records: [] }));
    const w2 = salesforceActivityWriter({ credentials: provider().p, transport: none.transport });
    expect(await w2.findContact(ORG, "nobody@x.com")).toBeNull();
    expect(await w2.findOpenOpportunity(ORG, "003A")).toBeNull();
  });
});

describe("the task", () => {
  it("creates it as a completed email activity on the contact and opportunity, with no field this file does not name", async () => {
    const t = script(() => ({ status: 201, headers: {}, body: { id: "00TA", success: true } }));
    const w = salesforceActivityWriter({ credentials: provider().p, transport: t.transport });
    const r = await w.createTask(ORG, {
      who_id: "003A",
      what_id: "006A",
      subject: "Email: Pricing",
      description: "Emailed Sarah. [maman:a1]",
      activity_date: "2026-09-22",
    });
    expect(r).toEqual({ id: "00TA" });
    const req = t.calls[0]!;
    expect(req.method).toBe("POST");
    expect(req.url).toBe("https://na1.example.com/services/data/v60.0/sobjects/Task");
    expect(JSON.parse(req.body!)).toEqual({
      WhoId: "003A",
      WhatId: "006A",
      Subject: "Email: Pricing",
      Description: "Emailed Sarah. [maman:a1]",
      ActivityDate: "2026-09-22",
      Status: "Completed",
      TaskSubtype: "Email",
    });
  });

  it("reads it back through a separate GET, finds it by marker, and deletes it to undo", async () => {
    const t = script((req) => {
      if (req.method === "DELETE") return { status: 204, headers: {}, body: "" };
      if (req.url.includes("/sobjects/Task/00TA"))
        return ok({
          Id: "00TA",
          WhoId: "003A",
          WhatId: null,
          Subject: "S",
          Description: "d [maman:a1]",
          ActivityDate: "2026-09-22",
          Status: "Completed",
        });
      if (soqlOf(req).includes("Description LIKE"))
        return ok({ records: [{ Id: "00TA", Subject: "S", Description: "d [maman:a1]" }] });
      return { status: 404, headers: {}, body: {} };
    });
    const w = salesforceActivityWriter({ credentials: provider().p, transport: t.transport });
    expect(await w.readTask(ORG, "00TA")).toMatchObject({
      id: "00TA",
      who_id: "003A",
      what_id: null,
      activity_date: "2026-09-22",
    });
    expect(t.calls[0]!.method).toBe("GET");
    expect(new URL(t.calls[0]!.url).searchParams.get("fields")).toContain("WhoId");
    expect(await w.findTaskByMarker(ORG, "[maman:a1]")).toMatchObject({ id: "00TA" });
    expect(soqlOf(t.calls[1]!)).toContain("Description LIKE '%[maman:a1]%'");
    await w.deleteTask(ORG, "00TA");
    expect(t.calls[2]!.method).toBe("DELETE");
    expect(await w.readTask(ORG, "gone")).toBeNull();
    await w.deleteTask(ORG, "gone"); // already gone is fine
  });

  it("refreshes once on 401; maps 5xx transient and 4xx permanent; refuses with no connector", async () => {
    const { p, refresh } = provider(creds, {
      access_token: "tok2",
      instance_url: "https://na1.example.com",
    });
    const t = script((req) =>
      req.headers["authorization"] === "Bearer tok2"
        ? ok({ records: [] })
        : { status: 401, headers: {}, body: {} },
    );
    await salesforceActivityWriter({ credentials: p, transport: t.transport }).findContact(
      ORG,
      "a@b.c",
    );
    expect(refresh).toHaveBeenCalledTimes(1);
    const down = salesforceActivityWriter({
      credentials: provider().p,
      transport: script(() => ({ status: 503, headers: {}, body: {} })).transport,
    });
    await expect(down.findContact(ORG, "a@b.c")).rejects.toBeInstanceOf(TransientAdapterError);
    const forbidden = salesforceActivityWriter({
      credentials: provider().p,
      transport: script(() => ({ status: 403, headers: {}, body: {} })).transport,
    });
    await expect(
      forbidden.createTask(ORG, {
        who_id: "x",
        subject: "s",
        description: "d",
        activity_date: "2026-01-01",
      }),
    ).rejects.toBeInstanceOf(PermanentAdapterError);
    const none = salesforceActivityWriter({
      credentials: provider(null).p,
      transport: script(() => ok({})).transport,
    });
    await expect(none.findContact(ORG, "a@b.c")).rejects.toBeInstanceOf(PermanentAdapterError);
  });
});
