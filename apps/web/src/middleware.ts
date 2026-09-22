import { NextResponse } from "next/server";
import { authkitProxy } from "@workos-inc/authkit-nextjs";

/**
 * In workos mode every page needs a session except the two that exist to get
 * one. The proxy refreshes the sealed session cookie before a page renders,
 * so server components always hold a live access token to forward. In dev
 * mode there is no session to manage and the request passes through.
 */
const WEB_BASE = process.env["WEB_BASE_URL"] ?? "http://localhost:3000";

export default process.env["AUTH_MODE"] === "workos"
  ? authkitProxy({
      redirectUri: `${WEB_BASE}/callback`,
      middlewareAuth: { enabled: true, unauthenticatedPaths: ["/callback", "/signed-out"] },
    })
  : () => NextResponse.next();

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
