import type { ReactNode } from "react";
import { AppShell } from "../_components/app-shell";
import type { NavItem } from "../_components/app-sidebar";
import { requirePageSession } from "../_lib/auth";

const NAV: NavItem[] = [
  { href: "/ops", label: "Overview", icon: "overview", exact: true },
  { href: "/ops/events", label: "Events", icon: "events" },
  { href: "/ops/payments", label: "Payments", icon: "payments" },
  { href: "/ops/reconciliation", label: "Reconciliation", icon: "reconciliation" },
  { href: "/ops/investigations", label: "Investigations", icon: "investigations" },
];

export default async function OpsLayout({ children }: { children: ReactNode }) {
  const session = await requirePageSession("OPS");
  return (
    <AppShell home="/ops" navLabel="Operations" items={NAV} context="Trace operations" role="Ops" userName={session.name} userDetail="Ops team">
      {children}
    </AppShell>
  );
}
