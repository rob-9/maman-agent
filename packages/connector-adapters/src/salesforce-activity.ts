import { PermanentAdapterError } from "@maman/agent-runtime";
import type { HttpResponse, HttpTransport } from "./http.js";
import { throwForStatus, throwTransientNetwork, type CredentialProvider } from "./credentials.js";
import { SF_API_VERSION, soqlLiteral } from "./salesforce.js";

/**
 * Salesforce, written to: an activity (a Task) logged against a contact and,
 * when there is one, their open opportunity. The first write in the product
 * that touches a system of record, so every part is separable and checkable:
 * find the records, create the task, READ IT BACK through a different call,
 * find it again by marker after an unknown result, delete it to undo.
 *
 * The organization's connected Salesforce (org vault). No field is written
 * that this file does not name.
 */

export type SalesforceActivityConfig = {
  credentials: CredentialProvider;
  transport: HttpTransport;
};

export type ActivityTask = {
  /** The Contact the activity is with. */
  who_id: string;
  /** The Opportunity it relates to, when there is one. */
  what_id?: string | undefined;
  subject: string;
  /** A short description. Ends with the idempotency marker. */
  description: string;
  /** YYYY-MM-DD. */
  activity_date: string;
};

export type TaskRecord = {
  id: string;
  who_id: string | null;
  what_id: string | null;
  subject: string;
  description: string;
  activity_date: string | null;
  status: string;
};

export interface SalesforceActivityWriter {
  findContact(
    organizationId: string,
    email: string,
  ): Promise<{ id: string; account_id: string | null } | null>;
  findOpenOpportunity(organizationId: string, contactId: string): Promise<string | null>;
  findTaskByMarker(organizationId: string, marker: string): Promise<TaskRecord | null>;
  createTask(organizationId: string, task: ActivityTask): Promise<{ id: string }>;
  readTask(organizationId: string, id: string): Promise<TaskRecord | null>;
  deleteTask(organizationId: string, id: string): Promise<void>;
}

const PROVIDER = "salesforce";
const TASK_FIELDS = "Id, WhoId, WhatId, Subject, Description, ActivityDate, Status";

export function salesforceActivityWriter(
  config: SalesforceActivityConfig,
): SalesforceActivityWriter {
  async function authed(
    organizationId: string,
    capability: string,
    build: (instance: string) => { method: "GET" | "POST" | "DELETE"; url: string; body?: unknown },
  ): Promise<HttpResponse> {
    let creds = await config.credentials.load({
      organization_id: organizationId,
      provider: PROVIDER,
    });
    if (!creds) throw new PermanentAdapterError(`${capability}: no linked Salesforce connector`);
    const run = async (token: string, instance: string): Promise<HttpResponse> => {
      const req = build(instance.replace(/\/$/, ""));
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
  const base = (i: string) => `${i}/services/data/${SF_API_VERSION}`;
  const query = async (organizationId: string, capability: string, soql: string) => {
    const res = await authed(organizationId, capability, (i) => ({
      method: "GET",
      url: `${base(i)}/query?q=${encodeURIComponent(soql)}`,
    }));
    if (res.status < 200 || res.status >= 300) throwForStatus(capability, res.status);
    return ((res.body as { records?: Record<string, unknown>[] }).records ?? []) as Record<
      string,
      unknown
    >[];
  };
  const str = (v: unknown): string | null => (typeof v === "string" && v ? v : null);
  const toTask = (r: Record<string, unknown>): TaskRecord => ({
    id: String(r["Id"]),
    who_id: str(r["WhoId"]),
    what_id: str(r["WhatId"]),
    subject: str(r["Subject"]) ?? "",
    description: str(r["Description"]) ?? "",
    activity_date: str(r["ActivityDate"]),
    status: str(r["Status"]) ?? "",
  });

  return {
    async findContact(organizationId, email) {
      const rows = await query(
        organizationId,
        "salesforce.log_activity.find_contact",
        `SELECT Id, AccountId FROM Contact WHERE Email = '${soqlLiteral(email)}' LIMIT 1`,
      );
      const r = rows[0];
      return r ? { id: String(r["Id"]), account_id: str(r["AccountId"]) } : null;
    },
    async findOpenOpportunity(organizationId, contactId) {
      const rows = await query(
        organizationId,
        "salesforce.log_activity.find_opportunity",
        `SELECT OpportunityId FROM OpportunityContactRole WHERE ContactId = '${soqlLiteral(contactId)}' AND Opportunity.IsClosed = false ORDER BY Opportunity.CloseDate ASC LIMIT 1`,
      );
      return rows[0] ? str(rows[0]["OpportunityId"]) : null;
    },
    async findTaskByMarker(organizationId, marker) {
      const rows = await query(
        organizationId,
        "salesforce.log_activity.find_by_marker",
        `SELECT ${TASK_FIELDS} FROM Task WHERE Description LIKE '%${soqlLiteral(marker)}%' LIMIT 1`,
      );
      return rows[0] ? toTask(rows[0]) : null;
    },
    async createTask(organizationId, task) {
      const res = await authed(organizationId, "salesforce.log_activity", (i) => ({
        method: "POST",
        url: `${base(i)}/sobjects/Task`,
        body: {
          WhoId: task.who_id,
          ...(task.what_id ? { WhatId: task.what_id } : {}),
          Subject: task.subject,
          Description: task.description,
          ActivityDate: task.activity_date,
          Status: "Completed",
          TaskSubtype: "Email",
        },
      }));
      if (res.status < 200 || res.status >= 300)
        throwForStatus("salesforce.log_activity", res.status);
      const id = (res.body as { id?: string }).id;
      if (!id)
        throw new PermanentAdapterError("salesforce.log_activity: created task carried no id");
      return { id };
    },
    async readTask(organizationId, id) {
      const res = await authed(organizationId, "salesforce.log_activity.verify", (i) => ({
        method: "GET",
        url: `${base(i)}/sobjects/Task/${encodeURIComponent(id)}?fields=${encodeURIComponent(TASK_FIELDS)}`,
      }));
      if (res.status === 404) return null;
      if (res.status < 200 || res.status >= 300)
        throwForStatus("salesforce.log_activity.verify", res.status);
      return toTask(res.body as Record<string, unknown>);
    },
    async deleteTask(organizationId, id) {
      const res = await authed(organizationId, "salesforce.log_activity.revert", (i) => ({
        method: "DELETE",
        url: `${base(i)}/sobjects/Task/${encodeURIComponent(id)}`,
      }));
      if (res.status === 404) return;
      if (res.status < 200 || res.status >= 300)
        throwForStatus("salesforce.log_activity.revert", res.status);
    },
  };
}
