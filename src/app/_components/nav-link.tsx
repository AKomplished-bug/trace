"use client";

import Link from "next/link";
import type { ReactNode } from "react";
import { usePathname } from "next/navigation";

/** `exact`: active only on `href` itself, not its sub-pages (a section home such as /ops). */
export function NavLink({ href, exact, children }: { href: string; exact?: boolean; children: ReactNode }) {
  const pathname = usePathname();
  const active = href === "/" || exact ? pathname === href : pathname === href || pathname.startsWith(`${href}/`);
  return (
    <Link
      href={href}
      className={`rounded px-2 py-1 text-sm ${active ? "bg-neutral-100 font-medium text-neutral-900" : "text-neutral-600 hover:text-neutral-900"}`}
    >
      {children}
    </Link>
  );
}
