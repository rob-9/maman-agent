import "server-only";
import { getSignInUrl, signOut, withAuth } from "@workos-inc/authkit-nextjs";

/**
 * WHO IS USING THIS PAGE.
 *
 * Two modes, chosen by AUTH_MODE — the same variable the API reads, so the
 * two can never disagree about how a person is identified:
 *
 *   workos  Real sign-in through WorkOS AuthKit (Google sign-in for a Gmail
 *           team; SSO later). The session lives in a sealed cookie the
 *           middleware refreshes; pages forward its access token to the API
 *           as a bearer, and the API verifies the signature itself. The web
 *           app holds no secret that could mint an identity.
 *
 *   dev     Identity headers, which the API accepts ONLY in AUTH_MODE=dev and
 *           refuses to run with in production. With nothing configured, the
 *           seeded demo member is used, so `pnpm demo` opens a working inbox.
 *
 * Nothing in this file reaches the browser: every caller is a server
 * component or a server action.
 */

export type Session =
  | { mode: "dev"; email: string; organizationId: string }
  | { mode: "workos"; email: string; organizationId: string | null };

export const authMode = (): "dev" | "workos" =>
  process.env["AUTH_MODE"] === "workos" ? "workos" : "dev";

const API_BASE = process.env["MAMAN_API_BASE_URL"] ?? "http://localhost:4000";
const WEB_BASE = process.env["WEB_BASE_URL"] ?? "http://localhost:3000";

/** Thrown when dev identity cannot be established; callers turn it into a 503 view. */
export class DevIdentityError extends Error {}

// ---- dev ----

type DevIdentity = { organizationId: string; userId: string; role: string; label: string };
let devCache: DevIdentity | null = null;

async function devIdentity(): Promise<DevIdentity> {
  if (devCache) return devCache;
  const org = process.env["MAMAN_DEV_ORG_ID"];
  const user = process.env["MAMAN_DEV_USER_ID"];
  if (org && user) {
    devCache = { organizationId: org, userId: user, role: "member", label: `dev ${user}` };
    return devCache;
  }
  // Nothing configured: the seeded demo organization and one of its members.
  // Resolved through dev-only API routes that exist only in AUTH_MODE=dev.
  const workosUser = process.env["MAMAN_DEV_WORKOS_USER_ID"] ?? "user_demo_alex";
  try {
    const [o, u] = await Promise.all([
      fetch(`${API_BASE}/v1/dev/resolve-org?workos_id=org_demo_acme_sales`, {
        cache: "no-store",
      }),
      fetch(`${API_BASE}/v1/dev/resolve-user?workos_id=${encodeURIComponent(workosUser)}`, {
        cache: "no-store",
      }),
    ]);
    if (!o.ok || !u.ok) {
      throw new DevIdentityError(
        `dev identity: API answered ${o.status}/${u.status}. Run the seed (pnpm db:seed) or set MAMAN_DEV_ORG_ID and MAMAN_DEV_USER_ID.`,
      );
    }
    const { organization_id } = (await o.json()) as { organization_id: string };
    const { user_id, role } = (await u.json()) as { user_id: string; role: string };
    devCache = { organizationId: organization_id, userId: user_id, role, label: workosUser };
    return devCache;
  } catch (e) {
    if (e instanceof DevIdentityError) throw e;
    throw new DevIdentityError(
      `dev identity: API not reachable at ${API_BASE}. Start it with pnpm --filter @maman/api dev.`,
    );
  }
}

// ---- both ----

/** The current session, or null when nobody is signed in (workos mode only). */
export async function sessionOrNull(): Promise<Session | null> {
  if (authMode() === "workos") {
    const { user, organizationId } = await withAuth();
    if (!user) return null;
    return { mode: "workos", email: user.email, organizationId: organizationId ?? null };
  }
  try {
    const d = await devIdentity();
    return { mode: "dev", email: d.label, organizationId: d.organizationId };
  } catch (e) {
    // No API at render time (a static prerender, or it is simply not up).
    // The page itself reports that; the shell just shows nobody.
    if (e instanceof DevIdentityError) return null;
    throw e;
  }
}

/**
 * Headers that identify the person to the API. In workos mode this redirects
 * to sign-in when there is no session, which is the whole point of calling it.
 */
export async function identityHeaders(): Promise<Record<string, string>> {
  if (authMode() === "workos") {
    const { accessToken } = await withAuth({ ensureSignedIn: true });
    return { authorization: `Bearer ${accessToken}` };
  }
  const d = await devIdentity();
  return { "x-dev-org-id": d.organizationId, "x-dev-user-id": d.userId, "x-dev-role": d.role };
}

/** Where to send the browser to sign in. Sets the PKCE cookie, so: actions only. */
export async function signInUrl(): Promise<string> {
  return getSignInUrl({ redirectUri: `${WEB_BASE}/callback` });
}

/** Ends the WorkOS session and clears the cookie; lands on /signed-out. */
export async function endSession(): Promise<void> {
  await signOut({ returnTo: `${WEB_BASE}/signed-out` });
}
