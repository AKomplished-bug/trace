import type { ReactNode } from "react";
import { AppHeader } from "../_components/app-header";
import { NavLink } from "../_components/nav-link";
import { requirePageSession } from "../_lib/auth";

export default async function OwnerLayout({ children }: { children: ReactNode }) {
  const session = await requirePageSession("OWNER");
  return (
    <div className="min-h-full">
      <AppHeader
        home="/"
        who={`${session.businessName} · ${session.name}`}
        nav={
          <>
            <NavLink href="/">Overview</NavLink>
            <NavLink href="/activity">Activity</NavLink>
          </>
        }
      />
      <main className="mx-auto max-w-6xl px-4 py-6 sm:py-8">{children}</main>
    </div>
  );
}
