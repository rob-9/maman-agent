import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { randomBytes } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { uuidv7 } from "@maman/contracts";
import {
  addMembership,
  createDbClient,
  globalCreateOrganization,
  globalCreateUser,
  listPendingObligations,
  loadMigrations,
  migrateUp,
  withUser,
  type DbClient,
} from "@maman/db";
import { envelopeEncrypt, packEnvelope } from "@maman/connector-auth";
import type { HttpRequest, HttpResponse } from "@maman/connector-adapters";
import { createUserVaultCredentialProvider } from "../../src/user-vault-credentials.js";
import { createSweepActivities, listSweepTargets } from "../../src/sweep.js";

/**
 * WHOM THE SWEEP TOUCHES, on a real database under real RLS.
 *
 * Two organizations, several people, several states. The list of targets is
 * the product's answer to "whose mailbox do we read on a schedule" — so every
 * exclusion here is a promise: a suspended member, a suspended organization,
 * an expired or revoked connection, a person with no connection at all.
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
const master = randomBytes(32);
const NOW = new Date("2026-09-21T12:00:00.000Z");
const ago = (days: number) => String(NOW.getTime() - days * 86_400_000);

// Organization A: active. Organization B: suspended.
const orgA = uuidv7();
const orgB = uuidv7();
// Deliberately NOT in id order of creation, so ordering is proven, not lucky.
const alice = uuidv7(); // active member, active gmail → target
const bob = uuidv7(); // active member, no connection → not a target
const carol = uuidv7(); // active member, EXPIRED gmail → not a target
const dave = uuidv7(); // SUSPENDED member, active gmail → not a target
const erin = uuidv7(); // member of the suspended org, active gmail → not a target
const frank = uuidv7(); // active member, active gmail, Gmail answers 500 → target that fails

async function seedUser(orgId: string, id: string, email: string, status = "active") {
  await globalCreateUser(client.sql, {
    id,
    workos_user_id: `wu_${id}`,
    email,
    display_name: email,
  });
  await addMembership(client.sql, { organizationId: orgId }, { user_id: id, role: "member" });
  if (status !== "active") {
    await client.sql`UPDATE memberships SET status = ${status} WHERE user_id = ${id}`;
  }
}

async function linkGmail(orgId: string, userId: string, status = "active") {
  const packed = packEnvelope(
    envelopeEncrypt({ access_token: "tok", refresh_token: "ref" }, master, {
      organization_id: orgId,
      user_id: userId,
      provider: "gmail",
    }),
  );
  await withUser(client.sql, { organizationId: orgId, userId }, async (tx) => {
    await tx`
      INSERT INTO user_connections
        (id, organization_id, owner_user_id, provider, external_account_label,
         encrypted_credentials, scopes, status)
      VALUES (${uuidv7()}, ${orgId}, ${userId}, 'gmail', ${`u-${userId}`}, ${packed},
              ARRAY['gmail.metadata'], ${status})
    `;
  });
}

function thread(id: string, from: string, to: string, whenMs: string, subject: string) {
  return {
    id,
    messages: [
      {
        id: `${id}-m`,
        internalDate: whenMs,
        payload: {
          headers: [
            { name: "From", value: from },
            { name: "To", value: to },
            { name: "Subject", value: subject },
          ],
        },
      },
    ],
  };
}

/** Which mailbox is being asked for is known only from the bearer we minted per user. */
const MAILBOXES: Record<string, Record<string, unknown>> = {
  [alice]: {
    owed: thread("owed", "Sarah <sarah@acme.com>", "alice@co.example", ago(4), "Pricing"),
    quiet: thread("quiet", "alice@co.example", "bob@client.com", ago(9), "Proposal"),
  },
};

const transport = async (req: HttpRequest): Promise<HttpResponse> => {
  const url = new URL(req.url);
  const who = url.searchParams.get("_who") ?? "";
  if (who === "frank") return { status: 500, headers: {}, body: { error: "boom" } };
  const box = MAILBOXES[who] ?? {};
  if (url.pathname.endsWith("/profile")) {
    return { status: 200, headers: {}, body: { emailAddress: "alice@co.example" } };
  }
  if (url.pathname.endsWith("/threads")) {
    return { status: 200, headers: {}, body: { threads: Object.keys(box).map((id) => ({ id })) } };
  }
  const id = decodeURIComponent(url.pathname.split("/").pop()!);
  return { status: 200, headers: {}, body: box[id] };
};

beforeAll(async () => {
  container = await new PostgreSqlContainer("postgres:17-alpine").start();
  client = createDbClient(container.getConnectionUri(), { max: 4 });
  await migrateUp(client.sql, loadMigrations(migrationsDir));
  for (const [id, name, status] of [
    [orgA, "A", "active"],
    [orgB, "B", "suspended"],
  ] as const) {
    await globalCreateOrganization(client.sql, {
      id,
      workos_organization_id: `wk_${id}`,
      name,
      status,
      default_timezone: "UTC",
    });
  }
  await seedUser(orgA, frank, "frank@co.example");
  await seedUser(orgA, alice, "alice@co.example");
  await seedUser(orgA, bob, "bob@co.example");
  await seedUser(orgA, carol, "carol@co.example");
  await seedUser(orgA, dave, "dave@co.example", "suspended");
  await seedUser(orgB, erin, "erin@other.example");
  await linkGmail(orgA, alice);
  await linkGmail(orgA, carol, "expired");
  await linkGmail(orgA, dave);
  await linkGmail(orgB, erin);
  await linkGmail(orgA, frank);
}, 240_000);

afterAll(async () => {
  await client?.close();
  await container?.stop();
});

describe("listSweepTargets", () => {
  it("lists exactly the active members of active organizations with an active mailbox, in a stable order", async () => {
    const targets = await listSweepTargets(client.sql);
    expect(targets).toEqual(
      [alice, frank]
        .sort()
        .map((user_id) => ({ organization_id: orgA, user_id, provider: "gmail" })),
    );
  });

  it("drops a person the moment their membership is suspended", async () => {
    await client.sql`UPDATE memberships SET status = 'suspended' WHERE user_id = ${alice}`;
    expect((await listSweepTargets(client.sql)).map((t) => t.user_id)).toEqual([frank]);
    await client.sql`UPDATE memberships SET status = 'active' WHERE user_id = ${alice}`;
  });
});

describe("createSweepActivities", () => {
  // Each person's "token" is a marker the scripted transport reads back, so
  // the test knows whose mailbox a request claims to be for.
  const deps = () => ({
    sql: client.sql,
    credentials: createUserVaultCredentialProvider({
      sql: client.sql,
      masterKey: master,
      transport: async () => ({ status: 500, body: {} }),
      clientCredentials: () => ({ client_id: "x" }),
    }),
    transport: async (req: HttpRequest) => {
      const bearer = (req.headers?.["authorization"] ?? "").toString();
      const url = new URL(req.url);
      url.searchParams.set("_who", bearer === "Bearer tok" ? whoIsSyncing : "");
      return transport({ ...req, url: url.toString() });
    },
    now: () => NOW,
    contentKey: master,
  });
  let whoIsSyncing = "";

  it("syncs one person under their own scope and reports the outcome", async () => {
    whoIsSyncing = alice;
    const acts = createSweepActivities(deps());
    const outcome = await acts.syncWorkspace({
      organization_id: orgA,
      user_id: alice,
      provider: "gmail",
    });
    expect(outcome).toEqual({ ok: true, obligations_written: 2 });
    const list = await listPendingObligations(client.sql, { organizationId: orgA, userId: alice });
    expect(list.map((o) => o.subject)).toEqual(["Pricing", "Proposal"]);
    // Nothing of Alice's is visible to a colleague.
    expect(await listPendingObligations(client.sql, { organizationId: orgA, userId: bob })).toEqual(
      [],
    );
  });

  it("a mailbox that errors is an OUTCOME, recorded on the connection, not a thrown activity", async () => {
    whoIsSyncing = "frank";
    const acts = createSweepActivities(deps());
    const outcome = await acts.syncWorkspace({
      organization_id: orgA,
      user_id: frank,
      provider: "gmail",
    });
    expect(outcome).toEqual({ ok: false, reason: "sync_failed" });
    const rows = await withUser(
      client.sql,
      { organizationId: orgA, userId: frank },
      (tx) => tx`SELECT status, last_error FROM user_connections`,
    );
    expect(rows[0]!["status"]).toBe("error");
    // And he is no longer a target — until he reconnects.
    expect((await listSweepTargets(client.sql)).map((t) => t.user_id)).toEqual([alice]);
  });

  it("a person with no connection is a clear non-outcome", async () => {
    const acts = createSweepActivities(deps());
    await expect(
      acts.syncWorkspace({ organization_id: orgA, user_id: bob, provider: "gmail" }),
    ).resolves.toEqual({ ok: false, reason: "no_connection" });
  });
});
