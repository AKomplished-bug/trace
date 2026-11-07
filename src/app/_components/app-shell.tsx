import type { ReactNode } from "react";
import { Separator } from "@/components/ui/separator";
import { SidebarInset, SidebarProvider, SidebarTrigger } from "@/components/ui/sidebar";
import { AppSidebar, type NavItem } from "./app-sidebar";
import { UserMenu } from "./user-menu";

/**
 * The signed-in frame shared by the owner and Ops sides: left navigation, a sticky top bar with
 * the business (or team), a role indicator and the user menu, and the page's <main>.
 */
export function AppShell({
  home,
  navLabel,
  items,
  context,
  role,
  userName,
  userDetail,
  children,
}: {
  home: string;
  navLabel: string;
  items: NavItem[];
  context: string;
  role: string;
  userName: string;
  userDetail: string;
  children: ReactNode;
}) {
  return (
    <SidebarProvider>
      <AppSidebar home={home} label={navLabel} items={items} />
      <SidebarInset className="min-w-0">
        <header className="sticky top-0 z-20 flex h-14 items-center gap-2 border-b bg-background/95 px-3 backdrop-blur supports-[backdrop-filter]:bg-background/80 sm:px-4">
          <SidebarTrigger className="size-9 md:hidden" aria-label="Open navigation" />
          <Separator orientation="vertical" className="h-5 md:hidden" />
          <p className="min-w-0 truncate text-sm font-medium">{context}</p>
          <span className="inline-flex h-6 shrink-0 items-center rounded-full border px-2 text-xs font-medium text-muted-foreground">{role}</span>
          <div className="ml-auto">
            <UserMenu name={userName} detail={userDetail} />
          </div>
        </header>
        <main id="main" tabIndex={-1} className="mx-auto w-full max-w-6xl min-w-0 px-4 py-6 outline-none sm:px-6 sm:py-8">
          {children}
        </main>
      </SidebarInset>
    </SidebarProvider>
  );
}
