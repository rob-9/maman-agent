import { describe, expect, it } from "vitest";
import { PermanentAdapterError } from "@maman/agent-runtime";
import {
  salesforceOpportunityWriter,
  type CredentialProvider,
  type HttpRequest,
  type HttpResponse,
} from "../src/index.js";

const ORG = "org-1";
const creds: CredentialProvider = {
  load: async () => ({ access_token: "tok", instance_url: "https://na1.example.com" }),
  refresh: async () => ({ access_token: "tok", instance_url: "https://na1.example.com" }),
};
function script(handler: (req: HttpRequest) => HttpResponse) {
  const calls: HttpRequest[] = [];
  return {
    calls,
    transport: async (req: HttpRequest) => {
      calls.push(req);
      return handler(req);
    },
  };
}

describe("the opportunity, read and updated", () => {
  it("reads the fields through a GET; writes only next step and close date through a PATCH", async () => {
    const t = script((req) =>
      req.method === "GET"
        ? {
            status: 200,
            headers: {},
            body: {
              Id: "006A",
              Name: "Acme 50 seats",
              StageName: "Proposal",
              NextStep: null,
              CloseDate: "2026-10-31",
              IsClosed: false,
            },
          }
        : { status: 204, headers: {}, body: "" },
    );
    const w = salesforceOpportunityWriter({ credentials: creds, transport: t.transport });
    expect(await w.readOpportunity(ORG, "006A")).toEqual({
      id: "006A",
      name: "Acme 50 seats",
      stage: "Proposal",
      next_step: null,
      close_date: "2026-10-31",
      is_closed: false,
    });
    expect(t.calls[0]!.url).toBe(
      "https://na1.example.com/services/data/v60.0/sobjects/Opportunity/006A?fields=Id%2C%20Name%2C%20StageName%2C%20NextStep%2C%20CloseDate%2C%20IsClosed",
    );
    await w.updateOpportunity(ORG, "006A", { next_step: "send the MSA", close_date: "2026-09-30" });
    expect(t.calls[1]!.method).toBe("PATCH");
    expect(t.calls[1]!.url).toBe(
      "https://na1.example.com/services/data/v60.0/sobjects/Opportunity/006A",
    );
    expect(JSON.parse(t.calls[1]!.body!)).toEqual({
      NextStep: "send the MSA",
      CloseDate: "2026-09-30",
    });
    // Only what was asked: one field.
    await w.updateOpportunity(ORG, "006A", { next_step: null });
    expect(JSON.parse(t.calls[2]!.body!)).toEqual({ NextStep: null });
    // Nothing asked, nothing sent.
    await w.updateOpportunity(ORG, "006A", {});
    expect(t.calls).toHaveLength(3);
  });

  it("a missing record reads as null; a refused write is permanent", async () => {
    const w = salesforceOpportunityWriter({
      credentials: creds,
      transport: script(() => ({ status: 404, headers: {}, body: {} })).transport,
    });
    expect(await w.readOpportunity(ORG, "nope")).toBeNull();
    const refused = salesforceOpportunityWriter({
      credentials: creds,
      transport: script(() => ({
        status: 400,
        headers: {},
        body: [{ errorCode: "FIELD_CUSTOM_VALIDATION_EXCEPTION" }],
      })).transport,
    });
    await expect(refused.updateOpportunity(ORG, "006A", { next_step: "x" })).rejects.toBeInstanceOf(
      PermanentAdapterError,
    );
  });
});
