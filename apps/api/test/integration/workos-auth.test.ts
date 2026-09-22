import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { exportJWK, generateKeyPair, SignJWT, type JSONWebKeySet, type CryptoKey } from "jose";
import type { FastifyInstance } from "fastify";
import type { ServerEnv } from "@maman/config";
import {
  createDbClient,
  getMembership,
  globalGetOrganizationByWorkosId,
  globalGetUserByWorkosId,
  loadMigrations,
  migrateUp,
  type DbClient,
} from "@maman/db";
import { WorkosAuthenticator } from "../../src/auth.js";
import { buildServer } from "../../src/server.js";
import {
  DbWorkosIdentityResolver,
  JwksWorkosVerifier,
  WORKOS_ISSUER,
  type WorkosDirectory,
} from "../../src/workos.js";

/**
 * SIGN-IN, END TO END, ON A REAL DATABASE.
 *
 * A WorkOS-signed access token arrives as a bearer. First sight provisions
 * the person; every later request is served from our rows. The membership
 * our admins manage is the truth after that — not WorkOS's.
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

const NOW = Date.parse("2026-09-21T12:00:00Z");
let container: StartedPostgreSqlContainer;
let client: DbClient;
let app: FastifyInstance;
let privateKey: CryptoKey;
let jwks: JSONWebKeySet;

type Dir = WorkosDirectory & { calls: string[] };
const directory: Dir = {
  calls: [],
  async getUser(id) {
    this.calls.push(`user:${id}`);
    const known: Record<string, { email: string; first: string | null; last: string | null }> = {
      user_ada: { email: "ada@co.example", first: "Ada", last: "Lovelace" },
      user_bob: { email: "bob@co.example", first: null, last: null },
      user_eve: { email: "eve@other.example", first: "Eve", last: null },
    };
    const u = known[id];
    return u ? { id, email: u.email, first_name: u.first, last_name: u.last } : null;
  },
  async getOrganization(id) {
    this.calls.push(`org:${id}`);
    return id === "org_co" ? { id, name: "Co" } : null;
  },
  async getMembership(userId, orgId) {
    this.calls.push(`membership:${userId}:${orgId}`);
    if (orgId !== "org_co") return null;
    if (userId === "user_ada") return { status: "active", role_slug: "admin" };
    if (userId === "user_bob") return { status: "active", role_slug: "member" };
    if (userId === "user_eve") return { status: "inactive", role_slug: "member" };
    return null;
  },
};

const serverEnv: ServerEnv = {
  NODE_ENV: "test",
  AUTH_MODE: "workos",
  MODEL_PROVIDER: "demo",
  CONNECTOR_MODE: "demo",
  DATABASE_URL: "postgres://localhost/x",
  REDIS_URL: "redis://localhost:6379",
  TEMPORAL_ADDRESS: "localhost:7233",
  TEMPORAL_NAMESPACE: "default",
  API_BASE_URL: "http://localhost:4000",
  WEB_BASE_URL: "http://localhost:3000",
  DEVICE_TOKEN_SIGNING_SECRET: "d".repeat(48),
  OAUTH_STATE_SIGNING_SECRET: "o".repeat(48),
  CONNECTOR_ENCRYPTION_MASTER_KEY: "m".repeat(48),
  WORKOS_API_KEY: "sk_test",
  WORKOS_CLIENT_ID: "client_test",
};

async function bearer(sub: string, orgId?: string): Promise<string> {
  const iat = Math.floor(NOW / 1000);
  const jwt = new SignJWT({ sid: `session_${sub}`, ...(orgId ? { org_id: orgId } : {}) })
    .setProtectedHeader({ alg: "RS256", kid: "k1" })
    .setSubject(sub)
    .setIssuer(WORKOS_ISSUER)
    .setIssuedAt(iat)
    .setExpirationTime(iat + 300);
  return `Bearer ${await jwt.sign(privateKey)}`;
}

const me = (auth: string) =>
  app.inject({ method: "GET", url: "/v1/me", headers: { authorization: auth } });

beforeAll(async () => {
  container = await new PostgreSqlContainer("postgres:16-alpine").start();
  client = createDbClient(container.getConnectionUri(), { max: 4 });
  await migrateUp(client.sql, loadMigrations(migrationsDir));

  const pair = await generateKeyPair("RS256");
  privateKey = pair.privateKey;
  jwks = { keys: [{ ...(await exportJWK(pair.publicKey)), kid: "k1", alg: "RS256", use: "sig" }] };

  app = buildServer({
    env: serverEnv,
    sql: client.sql,
    authenticator: new WorkosAuthenticator(
      JwksWorkosVerifier.forKeySet(jwks, () => NOW),
      new DbWorkosIdentityResolver(client.sql, directory, { now: () => NOW, cacheTtlMs: 0 }),
    ),
  });
  await app.ready();
}, 120_000);

afterAll(async () => {
  await app?.close();
  await client?.close();
  await container?.stop();
});

describe("first sign-in provisions the person", () => {
  it("creates the user, the organization and an active membership, and answers a principal", async () => {
    const res = await me(await bearer("user_ada", "org_co"));
    expect(res.statusCode).toBe(200);
    const principal = res.json();
    expect(principal).toMatchObject({ role: "org_admin", auth_mode: "workos" });

    const user = await globalGetUserByWorkosId(client.sql, "user_ada");
    const org = await globalGetOrganizationByWorkosId(client.sql, "org_co");
    expect(user).toMatchObject({ email: "ada@co.example", display_name: "Ada Lovelace" });
    expect(org).toMatchObject({ name: "Co", status: "active" });
    expect(principal.user_id).toBe(user!.id);
    expect(principal.organization_id).toBe(org!.id);
    const membership = await getMembership(client.sql, { organizationId: org!.id }, user!.id);
    expect(membership).toMatchObject({ role: "org_admin", status: "active" });
  });

  it("serves the second request from our rows without asking WorkOS again", async () => {
    directory.calls.length = 0;
    const res = await me(await bearer("user_ada", "org_co"));
    expect(res.statusCode).toBe(200);
    expect(directory.calls).toEqual([]);
  });

  it("falls back to the address as display name when WorkOS has no name", async () => {
    const res = await me(await bearer("user_bob", "org_co"));
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ role: "member" });
    const user = await globalGetUserByWorkosId(client.sql, "user_bob");
    expect(user!.display_name).toBe("bob@co.example");
    // Same organization row as Ada's — a colleague, not a second tenant.
    expect(res.json().organization_id).toBe(
      (await globalGetOrganizationByWorkosId(client.sql, "org_co"))!.id,
    );
  });

  it("racing first requests for one person end with one row", async () => {
    // A directory that HOLDS every caller after the "no row yet" read, so all
    // three try to insert the same person at once. Without insert-if-absent
    // two of them would die on the unique index.
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const gated: WorkosDirectory = {
      getUser: async (id) => {
        await gate;
        return { id, email: "twin@co.example", first_name: null, last_name: null };
      },
      getOrganization: async (id) => ({ id, name: "Co" }),
      getMembership: async () => ({ status: "active", role_slug: "member" }),
    };
    const resolver = new DbWorkosIdentityResolver(client.sql, gated, {
      now: () => NOW,
      cacheTtlMs: 0,
    });
    const identity = { workos_user_id: "user_twin", workos_organization_id: "org_co" };
    const pending = Promise.all([
      resolver.resolvePrincipal(identity),
      resolver.resolvePrincipal(identity),
      resolver.resolvePrincipal(identity),
    ]);
    await new Promise((r) => setTimeout(r, 100)); // everyone is now waiting at the gate
    release();
    const results = await pending;
    expect(results.every((p) => p !== null)).toBe(true);
    expect(new Set(results.map((p) => p!.user_id)).size).toBe(1);
    const rows =
      await client.sql`SELECT count(*)::int AS n FROM users WHERE workos_user_id = 'user_twin'`;
    expect(rows[0]!.n).toBe(1);
  });
});

describe("what is refused", () => {
  it("a person WorkOS does not know", async () => {
    const res = await me(await bearer("user_ghost", "org_co"));
    expect(res.statusCode).toBe(401);
    expect(await globalGetUserByWorkosId(client.sql, "user_ghost")).toBeNull();
  });

  it("a person whose WorkOS membership is not active — no rows are created for them", async () => {
    const res = await me(await bearer("user_eve", "org_co"));
    expect(res.statusCode).toBe(401);
    // WorkOS knows her, so she has a user row — and NO membership.
    const user = (await globalGetUserByWorkosId(client.sql, "user_eve"))!;
    expect(user.email).toBe("eve@other.example");
    const org = (await globalGetOrganizationByWorkosId(client.sql, "org_co"))!;
    expect(await getMembership(client.sql, { organizationId: org.id }, user.id)).toBeNull();
  });

  it("an organization WorkOS does not know", async () => {
    const res = await me(await bearer("user_ada", "org_unknown"));
    expect(res.statusCode).toBe(401);
    expect(await globalGetOrganizationByWorkosId(client.sql, "org_unknown")).toBeNull();
  });

  it("a token with no organization", async () => {
    expect((await me(await bearer("user_ada"))).statusCode).toBe(401);
  });

  it("a membership our admins suspended, whatever WorkOS says", async () => {
    const user = (await globalGetUserByWorkosId(client.sql, "user_bob"))!;
    const org = (await globalGetOrganizationByWorkosId(client.sql, "org_co"))!;
    await client.sql`UPDATE memberships SET status = 'suspended' WHERE user_id = ${user.id} AND organization_id = ${org.id}`;
    expect((await me(await bearer("user_bob", "org_co"))).statusCode).toBe(401);
    await client.sql`UPDATE memberships SET status = 'active' WHERE user_id = ${user.id} AND organization_id = ${org.id}`;
    expect((await me(await bearer("user_bob", "org_co"))).statusCode).toBe(200);
  });

  it("dev identity headers, in workos mode", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/v1/me",
      headers: {
        "x-dev-user-id": "00000000-0000-7000-8000-000000000001",
        "x-dev-org-id": "00000000-0000-7000-8000-000000000002",
        "x-dev-role": "org_admin",
      },
    });
    expect(res.statusCode).toBe(401);
  });
});

describe("the principal reaches the workspace", () => {
  it("a signed-in person's /v1/me/* routes answer under their own identity", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/v1/me/obligations",
      headers: { authorization: await bearer("user_ada", "org_co") },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ obligations: [] });
  });
});

describe("the cache", () => {
  it("reuses a principal within the TTL and re-checks the rows after it", async () => {
    let now = NOW;
    const resolver = new DbWorkosIdentityResolver(client.sql, directory, {
      now: () => now,
      cacheTtlMs: 1_000,
    });
    const identity = { workos_user_id: "user_bob", workos_organization_id: "org_co" };
    const first = await resolver.resolvePrincipal(identity);
    expect(first).not.toBeNull();
    const user = (await globalGetUserByWorkosId(client.sql, "user_bob"))!;
    const org = (await globalGetOrganizationByWorkosId(client.sql, "org_co"))!;
    await client.sql`UPDATE memberships SET status = 'suspended' WHERE user_id = ${user.id} AND organization_id = ${org.id}`;
    // Within the TTL: still served. This is the documented cost of the cache.
    expect(await resolver.resolvePrincipal(identity)).toEqual(first);
    now += 1_001;
    expect(await resolver.resolvePrincipal(identity)).toBeNull();
    await client.sql`UPDATE memberships SET status = 'active' WHERE user_id = ${user.id} AND organization_id = ${org.id}`;
  });
});
