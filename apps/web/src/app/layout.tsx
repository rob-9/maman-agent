import type { ReactNode } from "react";
import Link from "next/link";
import { branding } from "@/lib/branding";
import { signInAction, signOutAction } from "@/lib/actions";
import { authMode, sessionOrNull } from "@/lib/session";
import "./globals.css";

export const metadata = {
  title: branding.name,
  description: "Who you're about to drop, and a draft to fix it.",
};

const NAV = [
  ["Inbox", "/"],
  ["Connections", "/connections"],
] as const;

export default async function RootLayout({ children }: { children: ReactNode }) {
  const session = await sessionOrNull();
  const noTeam = session?.mode === "workos" && !session.organizationId;

  return (
    <html lang="en">
      <body>
        <nav className="top">
          <span className="brand">{branding.name}</span>
          {NAV.map(([label, href]) => (
            <Link key={href} href={href}>
              {label}
            </Link>
          ))}
          <span className="spacer" />
          {session ? (
            <span className="who">
              <span className="muted">{session.email}</span>
              {session.mode === "workos" ? (
                <form action={signOutAction}>
                  <button type="submit" className="link">
                    Sign out
                  </button>
                </form>
              ) : (
                <span className="pill">dev</span>
              )}
            </span>
          ) : authMode() === "workos" ? (
            <form action={signInAction}>
              <button type="submit" className="link">
                Sign in
              </button>
            </form>
          ) : null}
        </nav>
        <div className="container">
          {noTeam ? (
            <div className="card">
              <h3>Your account isn&apos;t in a team yet</h3>
              <p className="muted">
                Everything in {branding.name} belongs to a team, so there is nothing to show until
                an admin adds you to one. Ask them, then sign in again.
              </p>
            </div>
          ) : (
            children
          )}
        </div>
      </body>
    </html>
  );
}
