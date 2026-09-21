import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { uuidv7 } from "@maman/contracts";
import { globalCreateOrganization, globalCreateUser, addMembership } from "../../src/index.js";
import { withTenant, withUser, MissingUserContextError } from "../../src/tenant.js";
import { startTestDb, type TestDb } from "./setup.js";

/**
 * TWO PEOPLE IN ONE ORGANIZATION.
 *
 * Ordinary multi-tenancy stops at the org boundary, and most B2B products treat
 * org membership as read permission. These tables hold one person's inbox and
 * pipeline, so that is not good enough: a colleague — including their manager —
 * must read nothing.
 *
 * Both users below are active members of the SAME org, which is what makes this
 * a real test. An org-level policy would pass every assertion here while
 * leaking every row.
 */

let db: TestDb;
const orgId = uuidv7();
const alice = uuidv7();
const bob = uuidv7();
const aliceConn = uuidv7();
const bobConn = uuidv7();

/** Inserts a connection row as `user`, returning nothing. */
async function seedConnection(userId: string, connId: string, label: string): Promise<void> {
  await withUser(db.client.sql, { organizationId: orgId, userId }, async (tx) => {
    await tx`
      INSERT INTO user_connections
        (id, organization_id, owner_user_id, provider, external_account_label,
         encrypted_credentials, scopes, status)
      VALUES (${connId}, ${orgId}, ${userId}, 'gmail', ${label},
              ${Buffer.from("ciphertext")}, ARRAY['read'], 'active')
    `;
  });
}

beforeAll(async () => {
  db = await startTestDb();
  const { sql } = db.client;
  await globalCreateOrganization(sql, {
    id: orgId,
    workos_organization_id: `wk_${orgId}`,
    name: "One Company",
    status: "active",
    default_timezone: "UTC",
  });
  for (const [id, email] of [
    [alice, "alice@t.example"],
    [bob, "bob@t.example"],
  ] as const) {
    await globalCreateUser(sql, {
      id,
      workos_user_id: `wu_${id}`,
      email,
      display_name: email,
    });
    await addMembership(sql, { organizationId: orgId }, { user_id: id, role: "member" });
  }
  await seedConnection(alice, aliceConn, "alice@gmail");
  await seedConnection(bob, bobConn, "bob@gmail");
}, 240_000);

afterAll(async () => {
  await db?.stop();
});

describe("user-level isolation inside one organization", () => {
  it("each user sees only their own connection", async () => {
    const forAlice = await withUser(
      db.client.sql,
      { organizationId: orgId, userId: alice },
      (tx) => tx`SELECT id, external_account_label FROM user_connections`,
    );
    expect(forAlice).toHaveLength(1);
    expect(forAlice[0]!["id"]).toBe(aliceConn);

    const forBob = await withUser(
      db.client.sql,
      { organizationId: orgId, userId: bob },
      (tx) => tx`SELECT id FROM user_connections`,
    );
    expect(forBob).toHaveLength(1);
    expect(forBob[0]!["id"]).toBe(bobConn);
  });

  it("a colleague in the same org cannot read the other's row by id", async () => {
    // The decisive assertion. Same tenant, valid membership, explicit id — and
    // still nothing. RLS filters rather than errors, which is what makes this a
    // non-existence result rather than a permission hint.
    const rows = await withUser(
      db.client.sql,
      { organizationId: orgId, userId: bob },
      (tx) => tx`SELECT id FROM user_connections WHERE id = ${aliceConn}`,
    );
    expect(rows).toHaveLength(0);
  });

  it("a colleague cannot update or delete the other's row", async () => {
    await withUser(db.client.sql, { organizationId: orgId, userId: bob }, async (tx) => {
      await tx`UPDATE user_connections SET status = 'revoked' WHERE id = ${aliceConn}`;
      await tx`DELETE FROM user_connections WHERE id = ${aliceConn}`;
    });
    const stillThere = await withUser(
      db.client.sql,
      { organizationId: orgId, userId: alice },
      (tx) => tx`SELECT status FROM user_connections WHERE id = ${aliceConn}`,
    );
    expect(stillThere).toHaveLength(1);
    expect(stillThere[0]!["status"]).toBe("active");
  });

  it("a user cannot write a row owned by someone else", async () => {
    // WITH CHECK, not just USING: without it a user could insert rows attributed
    // to a colleague and then be unable to see what they had created.
    await expect(
      withUser(db.client.sql, { organizationId: orgId, userId: bob }, async (tx) => {
        await tx`
          INSERT INTO user_connections
            (id, organization_id, owner_user_id, provider, external_account_label,
             encrypted_credentials, scopes, status)
          VALUES (${uuidv7()}, ${orgId}, ${alice}, 'gmail', 'forged',
                  ${Buffer.from("x")}, ARRAY['read'], 'active')
        `;
      }),
    ).rejects.toThrow();
  });

  it("an ORG-scoped transaction reads nothing — fail-closed, not fail-open", async () => {
    // THE BEHAVIOUR THE MIGRATION HEADER PROMISES. `withTenant` never sets
    // app.user_id, so `owner_user_id = NULL` matches no row. A forgotten
    // setting yields an empty result, never another person's mail.
    const rows = await withTenant(
      db.client.sql,
      { organizationId: orgId },
      (tx) => tx`SELECT id FROM user_connections`,
    );
    expect(rows).toHaveLength(0);
  });

  it("refuses a user-scoped transaction with no user", async () => {
    await expect(
      // Deliberately bypassing the type to reach the runtime guard, which is
      // what protects a JS caller or a value that arrived as undefined.
      withUser(db.client.sql, { organizationId: orgId, userId: "" }, async () => undefined),
    ).rejects.toBeInstanceOf(MissingUserContextError);
  });

  it.each(["contacts", "threads", "obligations", "user_connections"])(
    "%s has RLS enabled AND forced",
    async (table) => {
      // FORCE matters: without it the table owner bypasses the policy, and
      // migrations run as the owner.
      const [row] = await db.client.sql`
        SELECT relrowsecurity, relforcerowsecurity
        FROM pg_class WHERE relname = ${table}
      `;
      expect(row!["relrowsecurity"]).toBe(true);
      expect(row!["relforcerowsecurity"]).toBe(true);
    },
  );
});
