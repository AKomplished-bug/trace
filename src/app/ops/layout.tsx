import type { ReactNode } from "react";
import { AppHeader } from "../_components/app-header";
import { NavLink } from "../_components/nav-link";
import { requirePageSession } from "../_lib/auth";

export default async function OpsLayout({ children }: { children: ReactNode }) {
  const session = await requirePageSession("OPS");
  return (
    <div className="min-h-full">
      <AppHeader
        home="/ops"
        who={`${session.name} · Ops`}
        nav={
          <>
            <NavLink href="/ops" exact>
              Overview
            </NavLink>
            <NavLink href="/ops/events">Events</NavLink>
            <NavLink href="/ops/payments">Payments</NavLink>
          </>
        }
      />
      <main className="mx-auto max-w-6xl px-4 py-6 sm:py-8">{children}</main>
    </div>
  );
}
