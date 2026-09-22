import { beforeAll, describe, expect, it } from "vitest";
import { exportJWK, generateKeyPair, SignJWT, type JSONWebKeySet, type CryptoKey } from "jose";
import {
  createWorkosDirectory,
  JwksWorkosVerifier,
  roleFromWorkosSlug,
  WORKOS_ISSUER,
  workosJwksUrl,
} from "../src/workos.js";

/**
 * The verifier is the trust boundary between the web app and the API: the
 * API believes a bearer token only because WorkOS signed it. Every way a
 * token can be wrong is one test, and every one answers null — the caller
 * is unauthenticated and learns nothing about why.
 */

const NOW = Date.parse("2026-09-21T12:00:00Z");
let privateKey: CryptoKey;
let otherPrivateKey: CryptoKey;
let jwks: JSONWebKeySet;

beforeAll(async () => {
  const pair = await generateKeyPair("RS256");
  const other = await generateKeyPair("RS256");
  privateKey = pair.privateKey;
  otherPrivateKey = other.privateKey;
  jwks = { keys: [{ ...(await exportJWK(pair.publicKey)), kid: "k1", alg: "RS256", use: "sig" }] };
});

async function token(
  claims: Record<string, unknown>,
  opts: { key?: CryptoKey; issuer?: string; expiresInS?: number } = {},
): Promise<string> {
  const iat = Math.floor(NOW / 1000);
  return new SignJWT(claims)
    .setProtectedHeader({ alg: "RS256", kid: "k1" })
    .setIssuer(opts.issuer ?? WORKOS_ISSUER)
    .setIssuedAt(iat)
    .setExpirationTime(iat + (opts.expiresInS ?? 300))
    .sign(opts.key ?? privateKey);
}

describe("JwksWorkosVerifier", () => {
  const verifier = () => JwksWorkosVerifier.forKeySet(jwks, () => NOW);

  it("accepts a token WorkOS signed and returns the user and organization", async () => {
    const t = await token({ sub: "user_01", org_id: "org_01", sid: "session_01" });
    await expect(verifier().verifyAccessToken(t)).resolves.toEqual({
      workos_user_id: "user_01",
      workos_organization_id: "org_01",
    });
  });

  it("rejects a token signed by another key", async () => {
    const t = await token({ sub: "user_01", org_id: "org_01" }, { key: otherPrivateKey });
    await expect(verifier().verifyAccessToken(t)).resolves.toBeNull();
  });

  it("rejects a tampered payload", async () => {
    const t = await token({ sub: "user_01", org_id: "org_01" });
    const [h, , sig] = t.split(".");
    const forged = Buffer.from(
      JSON.stringify({ sub: "user_02", org_id: "org_01", iss: WORKOS_ISSUER }),
    ).toString("base64url");
    await expect(verifier().verifyAccessToken(`${h}.${forged}.${sig}`)).resolves.toBeNull();
  });

  it("rejects an expired token, honouring the injected clock", async () => {
    const t = await token({ sub: "user_01", org_id: "org_01" }, { expiresInS: 60 });
    await expect(
      JwksWorkosVerifier.forKeySet(jwks, () => NOW + 61_000).verifyAccessToken(t),
    ).resolves.toBeNull();
    await expect(
      JwksWorkosVerifier.forKeySet(jwks, () => NOW + 59_000).verifyAccessToken(t),
    ).resolves.not.toBeNull();
  });

  it("rejects a token from another issuer", async () => {
    const t = await token({ sub: "user_01", org_id: "org_01" }, { issuer: "https://evil.example" });
    await expect(verifier().verifyAccessToken(t)).resolves.toBeNull();
  });

  it("rejects a session with no organization — nothing in this system lives outside one", async () => {
    const t = await token({ sub: "user_01", sid: "session_01" });
    await expect(verifier().verifyAccessToken(t)).resolves.toBeNull();
  });

  it("rejects things that are not JWTs", async () => {
    await expect(verifier().verifyAccessToken("some-token")).resolves.toBeNull();
    await expect(verifier().verifyAccessToken("")).resolves.toBeNull();
  });

  it("points production verification at WorkOS's key set for THIS client", () => {
    expect(workosJwksUrl("client_abc").toString()).toBe(
      "https://api.workos.com/sso/jwks/client_abc",
    );
  });
});

describe("createWorkosDirectory", () => {
  type Call = { url: string; headers: Record<string, string> };
  const fake = (routes: Record<string, { status: number; body?: unknown }>) => {
    const calls: Call[] = [];
    const directory = createWorkosDirectory({
      apiKey: "sk_test_secret",
      fetch: async (url, init) => {
        calls.push({ url, headers: init.headers });
        const path = new URL(url).pathname + new URL(url).search;
        const r = routes[path] ?? { status: 404 };
        return { ok: r.status < 400, status: r.status, json: async () => r.body };
      },
    });
    return { directory, calls };
  };

  it("reads a user, an organization and a membership with the API key as bearer", async () => {
    const { directory, calls } = fake({
      "/user_management/users/user_01": {
        status: 200,
        body: { id: "user_01", email: "a@co.example", first_name: "Ada", last_name: null },
      },
      "/organizations/org_01": { status: 200, body: { id: "org_01", name: "Co" } },
      "/user_management/organization_memberships?user_id=user_01&organization_id=org_01": {
        status: 200,
        body: { data: [{ id: "om_1", status: "active", role: { slug: "admin" } }] },
      },
    });
    await expect(directory.getUser("user_01")).resolves.toEqual({
      id: "user_01",
      email: "a@co.example",
      first_name: "Ada",
      last_name: null,
    });
    await expect(directory.getOrganization("org_01")).resolves.toEqual({
      id: "org_01",
      name: "Co",
    });
    await expect(directory.getMembership("user_01", "org_01")).resolves.toEqual({
      status: "active",
      role_slug: "admin",
    });
    expect(calls).toHaveLength(3);
    for (const c of calls) {
      expect(c.url.startsWith("https://api.workos.com/")).toBe(true);
      expect(c.headers["authorization"]).toBe("Bearer sk_test_secret");
    }
  });

  it("answers null for unknown ids and an empty membership list; throws on other failures", async () => {
    const { directory } = fake({
      "/user_management/organization_memberships?user_id=u&organization_id=o": {
        status: 200,
        body: { data: [] },
      },
      "/organizations/org_500": { status: 500 },
    });
    await expect(directory.getUser("nope")).resolves.toBeNull();
    await expect(directory.getMembership("u", "o")).resolves.toBeNull();
    await expect(directory.getOrganization("org_500")).rejects.toThrow(/HTTP 500/);
  });

  it("maps an unrecognised membership status to inactive rather than active", async () => {
    const { directory } = fake({
      "/user_management/organization_memberships?user_id=u&organization_id=o": {
        status: 200,
        body: { data: [{ status: "banned", role: { slug: "member" } }] },
      },
    });
    await expect(directory.getMembership("u", "o")).resolves.toEqual({
      status: "inactive",
      role_slug: "member",
    });
  });
});

describe("roleFromWorkosSlug", () => {
  it("grants org_admin only to the admin slug; everything else is a member", () => {
    expect(roleFromWorkosSlug("admin")).toBe("org_admin");
    expect(roleFromWorkosSlug("member")).toBe("member");
    expect(roleFromWorkosSlug("owner")).toBe("member");
    expect(roleFromWorkosSlug(null)).toBe("member");
  });
});
