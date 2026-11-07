"use client";

import { ArrowLeftRight, CircleGauge, FileSearch, LayoutDashboard, List, Radio, Scale, Send, type LucideIcon } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  useSidebar,
} from "@/components/ui/sidebar";

// Icons are looked up here by name: a server layout can't pass component functions to a client one.
const ICONS = {
  dashboard: LayoutDashboard,
  activity: List,
  payments: Send,
  balance: Scale,
  overview: CircleGauge,
  events: Radio,
  reconciliation: ArrowLeftRight,
  investigations: FileSearch,
} satisfies Record<string, LucideIcon>;

export interface NavItem {
  href: string;
  label: string;
  icon: keyof typeof ICONS;
  /** Active only on `href` itself, not its sub-pages (a section home such as /ops). */
  exact?: boolean;
  /** Further paths that belong to this item (transaction pages belong to Activity). */
  also?: string[];
}

function isActive(pathname: string, item: NavItem): boolean {
  const under = (href: string) => pathname === href || pathname.startsWith(`${href}/`);
  if (item.href === "/" || item.exact) return pathname === item.href;
  return under(item.href) || (item.also ?? []).some(under);
}

/** The left navigation; at phone width the shadcn sidebar renders it in a sheet. */
export function AppSidebar({ home, label, items }: { home: string; label: string; items: NavItem[] }) {
  const pathname = usePathname();
  const { setOpenMobile } = useSidebar();
  return (
    <Sidebar>
      <nav aria-label={label} className="flex h-full min-h-0 flex-col">
        <SidebarHeader className="h-14 justify-center px-4">
          <Link href={home} className="inline-flex h-9 items-center text-[15px] font-semibold tracking-tight" onClick={() => setOpenMobile(false)}>
            Trace
          </Link>
        </SidebarHeader>
        <SidebarContent>
          <SidebarGroup>
            <SidebarGroupContent>
              <SidebarMenu>
                {items.map((item) => {
                  const Icon = ICONS[item.icon];
                  const active = isActive(pathname, item);
                  return (
                    <SidebarMenuItem key={item.href}>
                      <SidebarMenuButton asChild isActive={active} className="h-9">
                        <Link href={item.href} aria-current={active ? "page" : undefined} onClick={() => setOpenMobile(false)}>
                          <Icon aria-hidden />
                          <span>{item.label}</span>
                        </Link>
                      </SidebarMenuButton>
                    </SidebarMenuItem>
                  );
                })}
              </SidebarMenu>
            </SidebarGroupContent>
          </SidebarGroup>
        </SidebarContent>
        <SidebarFooter className="px-4 pb-4 text-xs text-muted-foreground">
          Sandbox: a fictional business, test providers and no real money.
        </SidebarFooter>
      </nav>
    </Sidebar>
  );
}
