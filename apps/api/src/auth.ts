import { createHash } from "node:crypto";
import type { FastifyReply, FastifyRequest } from "fastify";
import { principalSchema, type Principal } from "@maman/contracts";
import type { ServerEnv } from "@maman/config";
import type { Sql } from "postgres";
import { isDeviceToken, verifyDeviceToken } from "./device-token.js";
import { createWorkosDirectory, DbWorkosIdentityResolver, JwksWorkosVerifier } from "./workos.js";

/**
 * Authentication strategies behind a single interface.
 *
 * - dev:    identity headers, accepted ONLY when AUTH_MODE=dev (which itself is
 *           refused when NODE_ENV=production by env validation AND by an
 *           explicit guard in buildServer).
 * - workos: Bearer access tokens issued by WorkOS AuthKit, signature-verified
 *           against WorkOS's published keys and mapped to our rows (workos.ts).
 *           Refuses to construct without credentials and a database — there
 *           is no "unconfigured" mode that quietly rejects everyone.
 * - device: HMAC-signed device tokens minted at enrollment. Tried first so the
 *           desktop app authenticates without a user session; falls through to
 *           the user authenticator for everything else.
 */

export interface Authenticator {
  authenticate(req: FastifyRequest): Promise<Principal | null>;
  readonly mode: "dev" | "workos" | "device";
}

/**
 * Verifies `Authorization: Bearer d1.<body>.<mac>` device tokens. The HMAC +
 * expiry check is stateless, but an optional `sessionActive` check makes
 * revocation and rotation authoritative: a token whose session row was revoked
 * (e.g. by rotation) is rejected even though its signature is still valid.
 */
export class DeviceTokenAuthenticator implements Authenticator {
  readonly mode = "device" as const;
  constructor(
    private readonly signingSecret: string,
    private readonly sessionActive?: (input: {
      organization_id: string;
      token_sha256: string;
    }) => Promise<boolean>,
    private readonly now: () => number = () => Date.now(),
  ) {}

  async authenticate(req: FastifyRequest): Promise<Principal | null> {
    const header = req.headers.authorization;
    if (!header?.startsWith("Bearer ")) return null;
    const token = header.slice("Bearer ".length);
    if (!isDeviceToken(token)) return null;
    const verified = verifyDeviceToken(token, this.signingSecret, this.now());
    if (!verified.valid) return null;
    if (this.sessionActive) {
      const tokenSha256 = createHash("sha256").update(token).digest("hex");
      const active = await this.sessionActive({
        organization_id: verified.payload.organization_id,
        token_sha256: tokenSha256,
      });
      if (!active) return null;
    }
    const parsed = principalSchema.safeParse({
      user_id: verified.payload.user_id,
      organization_id: verified.payload.organization_id,
      role: verified.payload.role,
      device_id: verified.payload.device_id,
      auth_mode: "device",
    });
    return parsed.success ? parsed.data : null;
  }
}

/** Tries the device authenticator first, then the configured user authenticator. */
export class CompositeAuthenticator implements Authenticator {
  readonly mode: "dev" | "workos" | "device";
  constructor(
    private readonly device: DeviceTokenAuthenticator,
    private readonly user: Authenticator,
  ) {
    this.mode = user.mode;
  }
  async authenticate(req: FastifyRequest): Promise<Principal | null> {
    return (await this.device.authenticate(req)) ?? (await this.user.authenticate(req));
  }
}

export class DevAuthenticator implements Authenticator {
  readonly mode = "dev" as const;

  async authenticate(req: FastifyRequest): Promise<Principal | null> {
    const userId = req.headers["x-dev-user-id"];
    const orgId = req.headers["x-dev-org-id"];
    const role = req.headers["x-dev-role"] ?? "member";
    if (typeof userId !== "string" || typeof orgId !== "string" || typeof role !== "string") {
      return null;
    }
    const parsed = principalSchema.safeParse({
      user_id: userId,
      organization_id: orgId,
      role,
      auth_mode: "dev",
    });
    return parsed.success ? parsed.data : null;
  }
}

/** Verifies WorkOS AuthKit-issued sessions. */
export interface WorkosTokenVerifier {
  verifyAccessToken(token: string): Promise<{
    workos_user_id: string;
    workos_organization_id: string;
  } | null>;
}

export interface WorkosIdentityResolver {
  resolvePrincipal(identity: {
    workos_user_id: string;
    workos_organization_id: string;
  }): Promise<Principal | null>;
}

export class WorkosAuthenticator implements Authenticator {
  readonly mode = "workos" as const;

  constructor(
    private readonly verifier: WorkosTokenVerifier,
    private readonly resolver: WorkosIdentityResolver,
  ) {}

  async authenticate(req: FastifyRequest): Promise<Principal | null> {
    const header = req.headers.authorization;
    if (!header?.startsWith("Bearer ")) return null;
    const token = header.slice("Bearer ".length);
    const identity = await this.verifier.verifyAccessToken(token);
    if (!identity) return null;
    return this.resolver.resolvePrincipal(identity);
  }
}

export type AuthenticatorDeps = {
  verifier?: WorkosTokenVerifier;
  resolver?: WorkosIdentityResolver;
  sql?: Sql | undefined;
};

/**
 * Builds the user authenticator for the configured AUTH_MODE. In workos mode
 * the pieces are real or the server does not start: env validation already
 * requires the credentials, and the resolver needs the database because a
 * principal IS a row in it.
 */
export function createAuthenticator(env: ServerEnv, deps: AuthenticatorDeps = {}): Authenticator {
  if (env.AUTH_MODE === "dev") {
    return new DevAuthenticator();
  }
  let verifier = deps.verifier;
  if (!verifier) {
    if (!env.WORKOS_CLIENT_ID) {
      throw new Error("FATAL: AUTH_MODE=workos requires WORKOS_CLIENT_ID.");
    }
    verifier = JwksWorkosVerifier.forClient(env.WORKOS_CLIENT_ID);
  }
  let resolver = deps.resolver;
  if (!resolver) {
    if (!env.WORKOS_API_KEY) {
      throw new Error("FATAL: AUTH_MODE=workos requires WORKOS_API_KEY.");
    }
    if (!deps.sql) {
      throw new Error("FATAL: AUTH_MODE=workos requires a database to resolve principals.");
    }
    resolver = new DbWorkosIdentityResolver(
      deps.sql,
      createWorkosDirectory({ apiKey: env.WORKOS_API_KEY }),
    );
  }
  return new WorkosAuthenticator(verifier, resolver);
}

export async function requirePrincipal(
  req: FastifyRequest,
  reply: FastifyReply,
): Promise<Principal | null> {
  const principal = (req as FastifyRequest & { principal?: Principal }).principal;
  if (!principal) {
    await reply.status(401).send({
      type: "about:blank",
      title: "Unauthorized",
      status: 401,
      detail: "Authentication required.",
      request_id: req.id,
    });
    return null;
  }
  return principal;
}
