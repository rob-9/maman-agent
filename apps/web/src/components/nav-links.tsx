"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

/** The top bar's links, with the current page marked. The only client code on the page. */
export function NavLinks({ items }: { items: ReadonlyArray<readonly [string, string]> }) {
  const pathname = usePathname();
  return (
    <nav aria-label="Main">
      {items.map(([label, href]) => {
        const current = href === "/" ? pathname === "/" : pathname.startsWith(href);
        return (
          <Link key={href} href={href} aria-current={current ? "page" : undefined}>
            {label}
          </Link>
        );
      })}
    </nav>
  );
}
