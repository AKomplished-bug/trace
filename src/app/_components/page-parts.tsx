import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

/** The page's one h1, a short description, and its actions on the right (below on phones). */
export function PageHeader({ title, description, actions, children }: { title: ReactNode; description?: ReactNode; actions?: ReactNode; children?: ReactNode }) {
  return (
    <div className="flex flex-wrap items-end justify-between gap-x-6 gap-y-3">
      <div className="min-w-0 max-w-2xl">
        <h1 className="text-xl font-semibold tracking-tight text-balance">{title}</h1>
        {description && <p className="mt-1 text-sm text-muted-foreground">{description}</p>}
        {children}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </div>
  );
}

/** A titled surface. `flush` drops the body padding for tables and lists that run edge to edge. */
export function Panel({
  title,
  description,
  aside,
  children,
  flush,
  className,
  id,
}: {
  title: ReactNode;
  description?: ReactNode;
  aside?: ReactNode;
  children: ReactNode;
  flush?: boolean;
  className?: string;
  id?: string;
}) {
  return (
    <section id={id} className={cn("min-w-0 overflow-hidden rounded-xl border bg-card text-card-foreground", className)}>
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 border-b px-4 py-3">
        <div className="min-w-0">
          <h2 className="text-sm font-semibold">{title}</h2>
          {description && <p className="mt-0.5 text-xs text-muted-foreground">{description}</p>}
        </div>
        {aside}
      </div>
      <div className={flush ? "" : "p-4"}>{children}</div>
    </section>
  );
}

/** What an empty list means and what to do next. */
export function EmptyState({ title, children, action, className }: { title: string; children?: ReactNode; action?: ReactNode; className?: string }) {
  return (
    <div className={cn("rounded-xl border border-dashed bg-card px-6 py-10 text-center", className)}>
      <p className="font-medium">{title}</p>
      {children && <p className="mx-auto mt-1 max-w-md text-sm text-muted-foreground">{children}</p>}
      {action && <div className="mt-4 flex justify-center gap-2">{action}</div>}
    </div>
  );
}

/** A warning strip (invalid filters, stale states). */
export function Notice({ tone = "pending", children, role }: { tone?: "pending" | "danger"; children: ReactNode; role?: "alert" | "status" }) {
  return (
    <div
      role={role}
      className={cn(
        "rounded-lg border px-4 py-3 text-sm",
        tone === "danger" ? "border-danger-line/70 bg-danger-soft text-danger" : "border-pending-line bg-pending-soft text-pending",
      )}
    >
      {children}
    </div>
  );
}

/** An id in monospace that wraps instead of overflowing. */
export function Id({ value }: { value: string | null }) {
  return value ? <code className="font-mono text-xs break-all text-foreground/80">{value}</code> : <span className="text-xs text-muted-foreground">None</span>;
}

/** Label/value rows. */
export function Facts({ children, className }: { children: ReactNode; className?: string }) {
  return <dl className={cn("grid grid-cols-[max-content_minmax(0,1fr)] gap-x-4 gap-y-2 text-sm", className)}>{children}</dl>;
}

export function Fact({ label, children }: { label: ReactNode; children: ReactNode }) {
  return (
    <>
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="min-w-0">{children}</dd>
    </>
  );
}

/** "previous → new" for an audit row's flat state. */
export function stateText(state: unknown): string {
  if (!state || typeof state !== "object") return "none";
  return Object.entries(state)
    .map(([key, value]) => `${key}=${String(value)}`)
    .join(" ");
}

/** Link styling shared by inline text links. */
export const linkClass = "font-medium text-primary underline-offset-4 hover:underline";
