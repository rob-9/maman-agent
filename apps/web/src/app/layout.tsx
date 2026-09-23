import type { ReactNode } from "react";
import { branding } from "@/lib/branding";
import { signInAction, signOutAction } from "@/lib/actions";
import { authMode, sessionOrNull } from "@/lib/session";
import { NavLinks } from "@/components/nav-links";
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
        <header className="topbar">
          <span className="brand">
            <span className="mark" aria-hidden="true">
              {branding.name.charAt(0)}
            </span>
            <span>{branding.name}</span>
          </span>
          <NavLinks items={NAV} />
          <span className="spacer" />
          {session ? (
            <span className="who">
              <span className="email">{session.email}</span>
              {session.mode === "workos" ? (
                <form action={signOutAction}>
                  <button type="submit" className="link">
                    Sign out
                  </button>
                </form>
              ) : (
                <span className="tag">dev</span>
              )}
            </span>
          ) : authMode() === "workos" ? (
            <form action={signInAction}>
              <button type="submit" className="btn small">
                Sign in
              </button>
            </form>
          ) : null}
        </header>
        <main className="page">
          {noTeam ? (
            <div className="card empty">
              <h3>Your account isn&apos;t in a team yet</h3>
              <p>
                Everything in {branding.name} belongs to a team. There is nothing to show until an
                admin adds you to one. Ask them, then sign in again.
              </p>
            </div>
          ) : (
            children
          )}
        </main>
      </body>
    </html>
  );
}
