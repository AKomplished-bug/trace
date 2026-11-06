"use client";

import Link from "next/link";
import type { ReactNode } from "react";
import { usePathname } from "next/navigation";

export function NavLink({ href, children }: { href: string; children: ReactNode }) {
  const pathname = usePathname();
  const active = href === "/" ? pathname === "/" : pathname === href || pathname.startsWith(`${href}/`);
  return (
    <Link
      href={href}
      className={`rounded px-2 py-1 text-sm ${active ? "bg-neutral-100 font-medium text-neutral-900" : "text-neutral-600 hover:text-neutral-900"}`}
    >
      {children}
    </Link>
  );
}
