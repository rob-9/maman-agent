import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { uuidv7 } from "@maman/contracts";
import {
  createDbClient,
  globalCreateOrganization,
  loadMigrations,
  migrateUp,
  upsertConnectorAccount,
  type DbClient,
} from "@maman/db";
import type { CredentialProvider } from "@maman/connector-adapters";
import { resolveDealSource } from "../../src/deal-source.js";

/**
 * WHICH CRM ANSWERS for an organization — decided from its connector
 * accounts on a real database. No adapter is exercised here; the question
 * is only whether one is chosen, and which.
 */

const migrationsDir = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "..",
  "..",
  "packages",
  "db",
  "migrations",
);

let container: StartedPostgreSqlContainer;
let client: DbClient;
const credentials: CredentialProvider = {
  load: async () => null,
  refresh: async () => {
    throw new Error("unused");
  },
};

async function org(): Promise<string> {
  const id = uuidv7();
  await globalCreateOrganization(client.sql, {
    id,
    workos_organization_id: `wk_${id}`,
    name: "Co",
    status: "active",
    default_timezone: "UTC",
  });
  return id;
}

async function connector(
  orgId: string,
  provider: string,
  status: "connected" | "revoked" | "degraded",
) {
  await upsertConnectorAccount(
    client.sql,
    { organizationId: orgId },
    {
      id: uuidv7(),
      organization_id: orgId,
      provider,
      external_account_id_hash: `h-${provider}`,
      display_label: provider,
      scopes: ["api"],
      status,
      encrypted_token_ciphertext: Buffer.from("ct"),
      encrypted_data_key: Buffer.from("dk"),
      token_key_version: 1,
    },
  );
}

beforeAll(async () => {
  container = await new PostgreSqlContainer("postgres:17-alpine").start();
  client = createDbClient(container.getConnectionUri(), { max: 4 });
  await migrateUp(client.sql, loadMigrations(migrationsDir));
}, 240_000);

afterAll(async () => {
  await client?.close();
  await container?.stop();
});

const resolve = () =>
  resolveDealSource({
    sql: client.sql,
    credentials,
    transport: async () => ({ status: 500, headers: {}, body: {} }),
  });

describe("resolveDealSource", () => {
  it("an organization with no CRM gets no source — deal state stays unknown", async () => {
    expect(await resolve()(await org())).toBeUndefined();
  });

  it("a connected Salesforce is the source", async () => {
    const o = await org();
    await connector(o, "salesforce", "connected");
    expect((await resolve()(o))?.provider).toBe("salesforce");
  });

  it("a revoked or degraded connector is not consulted", async () => {
    const o = await org();
    await connector(o, "salesforce", "revoked");
    expect(await resolve()(o)).toBeUndefined();
    const o2 = await org();
    await connector(o2, "salesforce", "degraded");
    expect(await resolve()(o2)).toBeUndefined();
  });

  it("a connector we have no deal adapter for is not a source", async () => {
    const o = await org();
    await connector(o, "google_sheets", "connected");
    expect(await resolve()(o)).toBeUndefined();
  });

  it("one organization's CRM is not another's", async () => {
    const withCrm = await org();
    await connector(withCrm, "salesforce", "connected");
    const without = await org();
    expect((await resolve()(withCrm))?.provider).toBe("salesforce");
    expect(await resolve()(without)).toBeUndefined();
  });
});
