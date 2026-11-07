import type { ReactNode } from "react";
import { AppShell } from "../_components/app-shell";
import type { NavItem } from "../_components/app-sidebar";
import { requirePageSession } from "../_lib/auth";

const NAV: NavItem[] = [
  { href: "/", label: "Dashboard", icon: "dashboard" },
  { href: "/activity", label: "Activity", icon: "activity", also: ["/transactions"] },
  { href: "/payments", label: "Payments", icon: "payments" },
  { href: "/balance", label: "Balance", icon: "balance" },
];

export default async function OwnerLayout({ children }: { children: ReactNode }) {
  const session = await requirePageSession("OWNER");
  const business = session.businessName ?? "Your business";
  return (
    <AppShell
      home="/"
      navLabel="Account"
      items={NAV}
      context={business}
      role="Owner"
      userName={session.name}
      userDetail={`Owner of ${business}`}
    >
      {children}
    </AppShell>
  );
}
