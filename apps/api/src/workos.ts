import type { Sql } from "postgres";
import {
  createLocalJWKSet,
  createRemoteJWKSet,
  jwtVerify,
  type JSONWebKeySet,
  type JWTVerifyGetKey,
} from "jose";
import { uuidv7, type OrganizationRole, type Principal } from "@maman/contracts";
import {
  ensureMembership,
  globalEnsureOrganizationByWorkosId,
  globalEnsureUserByWorkosId,
  globalGetOrganizationByWorkosId,
  globalGetUserByWorkosId,
  getMembership,
} from "@maman/db";
import type { WorkosIdentityResolver, WorkosTokenVerifier } from "./auth.js";

/**
 * REAL AUTH: WorkOS AuthKit.
 *
 * The web app signs the person in with AuthKit (Google sign-in for a Gmail
 * team, SSO later) and forwards the session's access token as a bearer. The
 * API trusts NOTHING from the web app: it verifies the token's signature
 * against WorkOS's published keys itself, then maps the WorkOS identity to
 * our own rows. The web app cannot mint a principal; only WorkOS can.
 *
 * Two pieces, each replaceable in tests without the other:
 *   - JwksWorkosVerifier: token → { workos_user_id, workos_organization_id }
 *   - DbWorkosIdentityResolver: that identity → Principal, provisioning the
 *     user / organization / membership rows on first sight (JIT).
 */

export const WORKOS_ISSUER = "https://api.workos.com";
const WORKOS_API_BASE = "https://api.workos.com";

export function workosJwksUrl(clientId: string): URL {
  return new URL(`${WORKOS_API_BASE}/sso/jwks/${encodeURIComponent(clientId)}`);
}

export class JwksWorkosVerifier implements WorkosTokenVerifier {
  constructor(
    private readonly getKey: JWTVerifyGetKey,
    private readonly now: () => number = () => Date.now(),
  ) {}

  /** Production: keys fetched (and cached by jose) from WorkOS for this client. */
  static forClient(clientId: string): JwksWorkosVerifier {
    return new JwksWorkosVerifier(createRemoteJWKSet(workosJwksUrl(clientId)));
  }

  /** Tests: a fixed key set, no network. */
  static forKeySet(jwks: JSONWebKeySet, now?: () => number): JwksWorkosVerifier {
    return new JwksWorkosVerifier(createLocalJWKSet(jwks), now);
  }

  async verifyAccessToken(
    token: string,
  ): Promise<{ workos_user_id: string; workos_organization_id: string } | null> {
    let payload;
    try {
      ({ payload } = await jwtVerify(token, this.getKey, {
        issuer: WORKOS_ISSUER,
        algorithms: ["RS256"],
        currentDate: new Date(this.now()),
      }));
    } catch {
      // Bad signature, expired, wrong issuer, not a JWT: all one answer. The
      // reason is not reported to the caller, who is unauthenticated.
      return null;
    }
    const sub = payload.sub;
    const orgId = payload["org_id"];
    // A session with no organization cannot be a principal: every row in this
    // system lives under an organization, and RLS would return nothing. The
    // web app shows "you are not in a team yet" for this case.
    if (typeof sub !== "string" || !sub || typeof orgId !== "string" || !orgId) return null;
    return { workos_user_id: sub, workos_organization_id: orgId };
  }
}

// ---- the directory: what WorkOS knows about a person we have not seen ----

export type WorkosUser = {
  id: string;
  email: string;
  first_name: string | null;
  last_name: string | null;
};
export type WorkosOrganization = { id: string; name: string };
export type WorkosMembership = {
  status: "active" | "inactive" | "pending";
  role_slug: string | null;
};

export interface WorkosDirectory {
  getUser(workosUserId: string): Promise<WorkosUser | null>;
  getOrganization(workosOrganizationId: string): Promise<WorkosOrganization | null>;
  getMembership(
    workosUserId: string,
    workosOrganizationId: string,
  ): Promise<WorkosMembership | null>;
}

type FetchLike = (
  input: string,
  init: { headers: Record<string, string> },
) => Promise<{
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
}>;

/** The WorkOS REST directory. Read-only: this client has no write method. */
export function createWorkosDirectory(opts: {
  apiKey: string;
  fetch?: FetchLike;
}): WorkosDirectory {
  const doFetch: FetchLike = opts.fetch ?? ((url, init) => fetch(url, init));
  const get = async (path: string): Promise<unknown | null> => {
    const res = await doFetch(`${WORKOS_API_BASE}${path}`, {
      headers: { authorization: `Bearer ${opts.apiKey}`, accept: "application/json" },
    });
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`workos directory ${path}: HTTP ${res.status}`);
    return res.json();
  };
  const str = (v: unknown): string | null => (typeof v === "string" && v ? v : null);

  return {
    async getUser(id) {
      const u = (await get(`/user_management/users/${encodeURIComponent(id)}`)) as Record<
        string,
        unknown
      > | null;
      if (!u || !str(u["id"]) || !str(u["email"])) return null;
      return {
        id: u["id"] as string,
        email: u["email"] as string,
        first_name: str(u["first_name"]),
        last_name: str(u["last_name"]),
      };
    },
    async getOrganization(id) {
      const o = (await get(`/organizations/${encodeURIComponent(id)}`)) as Record<
        string,
        unknown
      > | null;
      if (!o || !str(o["id"])) return null;
      return { id: o["id"] as string, name: str(o["name"]) ?? (o["id"] as string) };
    },
    async getMembership(userId, orgId) {
      const q = new URLSearchParams({ user_id: userId, organization_id: orgId });
      const list = (await get(`/user_management/organization_memberships?${q}`)) as {
        data?: Array<Record<string, unknown>>;
      } | null;
      const m = list?.data?.[0];
      if (!m) return null;
      const status = m["status"];
      const role = m["role"] as Record<string, unknown> | undefined;
      return {
        status: status === "active" || status === "pending" ? status : "inactive",
        role_slug: str(role?.["slug"]),
      };
    },
  };
}

/**
 * WorkOS role slug → our role, used ONLY when a membership row is created.
 * The organization's admins own roles after that (org.members.manage); a
 * sign-in never promotes or demotes anyone.
 */
export function roleFromWorkosSlug(slug: string | null): OrganizationRole {
  return slug === "admin" ? "org_admin" : "member";
}

export type ResolverOptions = {
  now?: () => number;
  /** How long a resolved principal is reused before the DB is consulted again. */
  cacheTtlMs?: number;
};

/**
 * Identity → Principal, against OUR database.
 *
 * First sight of a person provisions their user row, their organization's
 * row, and an active membership — after confirming with WorkOS that the
 * membership is active there. After that, the rows are the truth: a
 * membership an admin suspended here stays suspended regardless of WorkOS.
 *
 * Resolved principals are cached briefly (default 60s) so an authenticated
 * request costs one signature check, not three queries. The consequence —
 * a suspension takes up to the TTL to bite — is deliberate and documented.
 */
export class DbWorkosIdentityResolver implements WorkosIdentityResolver {
  private readonly cache = new Map<string, { principal: Principal; expires_at: number }>();
  private readonly now: () => number;
  private readonly ttl: number;

  constructor(
    private readonly sql: Sql,
    private readonly directory: WorkosDirectory,
    opts: ResolverOptions = {},
  ) {
    this.now = opts.now ?? (() => Date.now());
    this.ttl = opts.cacheTtlMs ?? 60_000;
  }

  async resolvePrincipal(identity: {
    workos_user_id: string;
    workos_organization_id: string;
  }): Promise<Principal | null> {
    const key = `${identity.workos_user_id}\u0000${identity.workos_organization_id}`;
    const hit = this.cache.get(key);
    if (hit && hit.expires_at > this.now()) return hit.principal;
    this.cache.delete(key);

    const principal = await this.resolveUncached(identity);
    if (principal) this.cache.set(key, { principal, expires_at: this.now() + this.ttl });
    return principal;
  }

  private async resolveUncached(identity: {
    workos_user_id: string;
    workos_organization_id: string;
  }): Promise<Principal | null> {
    // Known rows first: the common case touches the directory not at all.
    let user = await globalGetUserByWorkosId(this.sql, identity.workos_user_id);
    let org = await globalGetOrganizationByWorkosId(this.sql, identity.workos_organization_id);

    if (!user) {
      const remote = await this.directory.getUser(identity.workos_user_id);
      if (!remote) return null;
      const name = [remote.first_name, remote.last_name].filter(Boolean).join(" ");
      user = await globalEnsureUserByWorkosId(this.sql, {
        id: uuidv7(),
        workos_user_id: remote.id,
        email: remote.email,
        display_name: name || remote.email,
      });
    }
    if (!org) {
      const remote = await this.directory.getOrganization(identity.workos_organization_id);
      if (!remote) return null;
      org = await globalEnsureOrganizationByWorkosId(this.sql, {
        id: uuidv7(),
        workos_organization_id: remote.id,
        name: remote.name,
        status: "active",
        default_timezone: "UTC",
      });
    }
    if (org.status !== "active") return null;

    const ctx = { organizationId: org.id };
    let membership = await getMembership(this.sql, ctx, user.id);
    if (!membership) {
      // WorkOS says whether this person belongs to this organization; a token
      // carrying org_id already implies it, but the membership's status and
      // initial role come from the record, not the claim.
      const remote = await this.directory.getMembership(
        identity.workos_user_id,
        identity.workos_organization_id,
      );
      if (!remote || remote.status !== "active") return null;
      membership = await ensureMembership(this.sql, ctx, {
        user_id: user.id,
        role: roleFromWorkosSlug(remote.role_slug),
      });
    }
    if (membership.status !== "active") return null;

    return {
      user_id: user.id,
      organization_id: org.id,
      role: membership.role,
      auth_mode: "workos",
    };
  }
}
