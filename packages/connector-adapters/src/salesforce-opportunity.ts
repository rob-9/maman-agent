import { PermanentAdapterError } from "@maman/agent-runtime";
import type { HttpResponse, HttpTransport } from "./http.js";
import { throwForStatus, throwTransientNetwork, type CredentialProvider } from "./credentials.js";
import { SF_API_VERSION } from "./salesforce.js";

/**
 * Salesforce opportunities, read and updated: the two fields the thread can
 * tell us, next step and close date. Nothing else is written here; the
 * stage is a judgment and has its own path later. Read before write and
 * read after write are separate calls, so a hand edit is seen before it is
 * overwritten and a write is confirmed by something other than its own
 * answer.
 */

export type SalesforceOpportunityConfig = {
  credentials: CredentialProvider;
  transport: HttpTransport;
};

export type OpportunityRecord = {
  id: string;
  name: string;
  stage: string | null;
  next_step: string | null;
  close_date: string | null;
  is_closed: boolean;
};

export type OpportunityFields = { next_step?: string | null; close_date?: string | null };

export interface SalesforceOpportunityWriter {
  readOpportunity(organizationId: string, id: string): Promise<OpportunityRecord | null>;
  updateOpportunity(organizationId: string, id: string, fields: OpportunityFields): Promise<void>;
}

const PROVIDER = "salesforce";
const FIELDS = "Id, Name, StageName, NextStep, CloseDate, IsClosed";

export function salesforceOpportunityWriter(
  config: SalesforceOpportunityConfig,
): SalesforceOpportunityWriter {
  async function authed(
    organizationId: string,
    capability: string,
    build: (base: string) => { method: "GET" | "PATCH"; url: string; body?: unknown },
  ): Promise<HttpResponse> {
    let creds = await config.credentials.load({
      organization_id: organizationId,
      provider: PROVIDER,
    });
    if (!creds) throw new PermanentAdapterError(`${capability}: no linked Salesforce connector`);
    const run = async (token: string, instance: string): Promise<HttpResponse> => {
      const req = build(`${instance.replace(/\/$/, "")}/services/data/${SF_API_VERSION}`);
      try {
        return await config.transport({
          method: req.method,
          url: req.url,
          headers: {
            authorization: `Bearer ${token}`,
            accept: "application/json",
            ...(req.body !== undefined ? { "content-type": "application/json" } : {}),
          },
          ...(req.body !== undefined ? { body: JSON.stringify(req.body) } : {}),
        });
      } catch (e) {
        throwTransientNetwork(capability, e);
      }
    };
    const instance = creds.instance_url;
    if (!instance)
      throw new PermanentAdapterError(`${capability}: missing Salesforce instance_url`);
    let res = await run(creds.access_token, instance);
    if (res.status === 401) {
      creds = await config.credentials.refresh({
        organization_id: organizationId,
        provider: PROVIDER,
      });
      res = await run(creds.access_token, creds.instance_url ?? instance);
      if (res.status === 401)
        throw new PermanentAdapterError(`${capability}: unauthorized after refresh`);
    }
    return res;
  }
  const str = (v: unknown): string | null => (typeof v === "string" && v ? v : null);

  return {
    async readOpportunity(organizationId, id) {
      const res = await authed(organizationId, "salesforce.update_opportunity.read", (base) => ({
        method: "GET",
        url: `${base}/sobjects/Opportunity/${encodeURIComponent(id)}?fields=${encodeURIComponent(FIELDS)}`,
      }));
      if (res.status === 404) return null;
      if (res.status < 200 || res.status >= 300)
        throwForStatus("salesforce.update_opportunity.read", res.status);
      const r = res.body as Record<string, unknown>;
      return {
        id: String(r["Id"]),
        name: str(r["Name"]) ?? "",
        stage: str(r["StageName"]),
        next_step: str(r["NextStep"]),
        close_date: str(r["CloseDate"]),
        is_closed: r["IsClosed"] === true,
      };
    },
    async updateOpportunity(organizationId, id, fields) {
      const body: Record<string, unknown> = {};
      if ("next_step" in fields) body["NextStep"] = fields.next_step;
      if ("close_date" in fields) body["CloseDate"] = fields.close_date;
      if (Object.keys(body).length === 0) return;
      const res = await authed(organizationId, "salesforce.update_opportunity", (base) => ({
        method: "PATCH",
        url: `${base}/sobjects/Opportunity/${encodeURIComponent(id)}`,
        body,
      }));
      if (res.status < 200 || res.status >= 300)
        throwForStatus("salesforce.update_opportunity", res.status);
    },
  };
}
