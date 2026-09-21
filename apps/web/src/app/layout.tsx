import type { ReactNode } from "react";
import Link from "next/link";
import { branding } from "@/lib/api";
import "./globals.css";

export const metadata = {
  title: branding.name,
  description: "Who you're about to drop, and a draft to fix it.",
};

const NAV = [
  ["Inbox", "/"],
  ["Connections", "/connections"],
] as const;

export default function RootLayout({ children }: { children: ReactNode }) {
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
        </nav>
        <div className="container">{children}</div>
      </body>
    </html>
  );
}
