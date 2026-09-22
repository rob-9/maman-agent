import { PermanentAdapterError } from "@maman/agent-runtime";
import type { HttpResponse, HttpTransport } from "./http.js";
import { throwForStatus, throwTransientNetwork, type CredentialProvider } from "./credentials.js";
import type { DealAnswer, DealSignal, DealSource } from "./deals.js";
import { SF_API_VERSION, soqlLiteral } from "./salesforce.js";

/**
 * Salesforce as a DealSource: "is there an open Opportunity with this person?"
 *
 * READ-ONLY. One SOQL query per chunk of addresses, over
 * OpportunityContactRole — the object that ties a Contact to an Opportunity —
 * so the answer is "deals this person is on", not "deals at their company".
 * The credentials are the organization's connected Salesforce (org vault);
 * the token is a Bearer header for the life of one request and nothing else.
 *
 * Mapping, per address, from the rows that came back:
 *   any Opportunity with IsClosed=false  → open,  value = sum of open Amounts
 *   rows, all closed                     → closed (has_open_deal: false)
 *   no rows                              → NOT RETURNED — unknown, not closed
 * Salesforce matches Email case-insensitively; so do we, and the signal
 * carries the address exactly as it was asked.
 */

export type SalesforceDealSourceConfig = {
  credentials: CredentialProvider;
  transport: HttpTransport;
};

/** Addresses per SOQL query. Keeps the URL well inside Salesforce's limits. */
export const SF_DEAL_QUERY_CHUNK = 200;

const PROVIDER = "salesforce";
const CAPABILITY = "salesforce.open_deals";

type Row = {
  Contact?: { Email?: string | null; Account?: { Name?: string | null } | null } | null;
  Opportunity?: { Amount?: number | null; IsClosed?: boolean | null } | null;
};

type QueryPage = { records?: Row[]; done?: boolean; nextRecordsUrl?: string };

export function dealQuery(addresses: readonly string[]): string {
  const list = addresses.map((a) => `'${soqlLiteral(a)}'`).join(", ");
  return (
    "SELECT Contact.Email, Contact.Account.Name, Opportunity.Amount, Opportunity.IsClosed " +
    `FROM OpportunityContactRole WHERE Contact.Email IN (${list})`
  );
}

export function salesforceDealSource(config: SalesforceDealSourceConfig): DealSource {
  /** GET against the org's instance, refreshing the token once on 401. */
  async function authedGet(organizationId: string, pathOf: (instance: string) => string) {
    let creds = await config.credentials.load({
      organization_id: organizationId,
      provider: PROVIDER,
    });
    if (!creds) throw new PermanentAdapterError(`${CAPABILITY}: no linked Salesforce connector`);
    const run = async (token: string, instance: string): Promise<HttpResponse> => {
      try {
        return await config.transport({
          method: "GET",
          url: pathOf(instance.replace(/\/$/, "")),
          headers: { authorization: `Bearer ${token}`, accept: "application/json" },
        });
      } catch (e) {
        throwTransientNetwork(CAPABILITY, e);
      }
    };
    const instance = creds.instance_url;
    if (!instance)
      throw new PermanentAdapterError(`${CAPABILITY}: missing Salesforce instance_url`);
    let res = await run(creds.access_token, instance);
    if (res.status === 401) {
      creds = await config.credentials.refresh({
        organization_id: organizationId,
        provider: PROVIDER,
      });
      res = await run(creds.access_token, creds.instance_url ?? instance);
      if (res.status === 401) {
        throw new PermanentAdapterError(`${CAPABILITY}: unauthorized after refresh`);
      }
    }
    if (res.status < 200 || res.status >= 300) throwForStatus(CAPABILITY, res.status);
    return res.body as QueryPage;
  }

  async function queryAll(organizationId: string, soql: string): Promise<Row[]> {
    const rows: Row[] = [];
    let page = await authedGet(
      organizationId,
      (i) => `${i}/services/data/${SF_API_VERSION}/query?q=${encodeURIComponent(soql)}`,
    );
    rows.push(...(page.records ?? []));
    // Salesforce pages large results; follow until done so a person with
    // many deals is not read as having few.
    while (page.done === false && page.nextRecordsUrl) {
      const next = page.nextRecordsUrl;
      page = await authedGet(organizationId, (i) => `${i}${next}`);
      rows.push(...(page.records ?? []));
    }
    return rows;
  }

  return {
    provider: PROVIDER,
    async lookup(ctx, addresses): Promise<DealAnswer> {
      const asked = [...new Set(addresses)];
      // Rows keyed by lower-cased email; the answer keyed by the asked spelling.
      const askedByLower = new Map(asked.map((a) => [a.toLowerCase(), a]));
      const seen = new Map<string, { open: boolean; value: number; account?: string }>();

      for (let i = 0; i < asked.length; i += SF_DEAL_QUERY_CHUNK) {
        const chunk = asked.slice(i, i + SF_DEAL_QUERY_CHUNK);
        for (const row of await queryAll(ctx.organization_id, dealQuery(chunk))) {
          const email = row.Contact?.Email?.toLowerCase();
          if (!email || !askedByLower.has(email)) continue;
          const entry = seen.get(email) ?? { open: false, value: 0 };
          if (row.Opportunity && row.Opportunity.IsClosed === false) {
            entry.open = true;
            entry.value += Number(row.Opportunity.Amount ?? 0);
          }
          const account = row.Contact?.Account?.Name;
          if (account && !entry.account) entry.account = account;
          seen.set(email, entry);
        }
      }

      const signals: DealSignal[] = [];
      for (const [lower, entry] of seen) {
        signals.push({
          address: askedByLower.get(lower)!,
          has_open_deal: entry.open,
          ...(entry.open ? { open_deal_value: entry.value } : {}),
          ...(entry.account ? { account_name: entry.account } : {}),
        });
      }
      return { asked, signals };
    },
  };
}
