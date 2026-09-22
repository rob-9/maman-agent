import { handleAuth } from "@workos-inc/authkit-nextjs";

/**
 * Where WorkOS sends the browser back after sign-in. Exchanges the code for
 * a session (verifying the PKCE state it set on the way out), seals it into
 * the cookie, and lands on the inbox. Registered as the redirect URI in the
 * WorkOS dashboard: `${WEB_BASE_URL}/callback`.
 */
export const GET = handleAuth({ returnPathname: "/" });
