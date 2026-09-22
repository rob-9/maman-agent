import type { Sql } from "postgres";
import {
  salesforceDealSource,
  type CredentialProvider,
  type DealSource,
  type HttpTransport,
} from "@maman/connector-adapters";
import { listConnectorAccounts } from "@maman/db";

/**
 * Which CRM answers for this organization, if any.
 *
 * The sync job runs per PERSON; the CRM is connected per ORGANIZATION. This is
 * the lookup between them: the org's connector accounts, the first connected
 * CRM we have an adapter for, or undefined — in which case deal state stays
 * unknown and the list still works. A revoked or degraded connector is not
 * consulted: asking it would only record an error the person cannot fix.
 */
export type DealSourceResolver = (organizationId: string) => Promise<DealSource | undefined>;

export type ResolveDealSourceDeps = {
  sql: Sql;
  credentials: CredentialProvider;
  transport: HttpTransport;
};

const ADAPTERS: Record<string, (deps: ResolveDealSourceDeps) => DealSource> = {
  salesforce: (deps) =>
    salesforceDealSource({ credentials: deps.credentials, transport: deps.transport }),
  // hubspot: pending the customer's answer.
};

export function resolveDealSource(deps: ResolveDealSourceDeps): DealSourceResolver {
  return async (organizationId) => {
    const accounts = await listConnectorAccounts(deps.sql, { organizationId });
    const crm = accounts
      .filter((a) => a.status === "connected" && a.provider in ADAPTERS)
      .sort((a, b) => a.provider.localeCompare(b.provider))[0];
    return crm ? ADAPTERS[crm.provider]!(deps) : undefined;
  };
}
