import Link from "next/link";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { cn } from "@/lib/utils";
import { investigationStatus } from "../../../db/schema";
import { listInvestigations } from "../../../services/investigations";
import { apiDeps } from "../../api/deps";
import { TYPE_LABELS } from "../../_components/labels";
import { LocalTime } from "../../_components/local-time";
import { Money } from "../../_components/money";
import { EmptyState, linkClass, Notice, PageHeader } from "../../_components/page-parts";
import { ReconciliationStatusBadge, Tag } from "../../_components/status-badge";
import { requirePageSession } from "../../_lib/auth";
import { investigationListQuery } from "../../_lib/schemas";

export const metadata = { title: "Investigations · Trace" };

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

const FILTER_LABELS: Record<string, string> = { all: "All", OPEN: "Open", RESOLVED: "Resolved" };

export default async function InvestigationsPage({ searchParams }: { searchParams: SearchParams }) {
  await requirePageSession("OPS");
  const raw = await searchParams;
  const query = investigationListQuery.safeParse({ status: Array.isArray(raw.status) ? raw.status[0] : raw.status });
  const items = query.success ? await listInvestigations(apiDeps().db, query.data) : null;
  const filter = query.success ? query.data.status : undefined;

  return (
    <div className="space-y-5">
      <PageHeader
        title="Investigations"
        description="Reconciliation exceptions Ops is working on, newest first. Open one from the reconciliation queue."
        actions={
          <nav aria-label="Filter by status" className="inline-flex rounded-lg bg-muted p-1 text-sm">
            {[undefined, ...investigationStatus.enumValues].map((status) => (
              <Link
                key={status ?? "all"}
                href={status ? `/ops/investigations?status=${status}` : "/ops/investigations"}
                aria-current={filter === status ? "page" : undefined}
                className={cn(
                  "inline-flex h-8 items-center rounded-md px-3 font-medium",
                  filter === status ? "bg-card text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground",
                )}
              >
                {FILTER_LABELS[status ?? "all"] ?? status}
              </Link>
            ))}
          </nav>
        }
      />

      {!items ? (
        <Notice>
          That filter isn&apos;t valid.{" "}
          <Link href="/ops/investigations" className={linkClass}>
            Show all
          </Link>
        </Notice>
      ) : items.length === 0 ? (
        <EmptyState title={filter === "OPEN" ? "No open investigations" : "No investigations yet"}>
          Open one from an exception in the{" "}
          <Link href="/ops/reconciliation" className={linkClass}>
            reconciliation queue
          </Link>
          .
        </EmptyState>
      ) : (
        <div className="overflow-hidden rounded-xl border bg-card">
          <Table>
            <caption className="sr-only">Investigations, newest first</caption>
            <TableHeader className="bg-muted/50">
              <TableRow className="hover:bg-transparent">
                <TableHead className="px-4 text-xs text-muted-foreground">Issue</TableHead>
                <TableHead className="px-4 text-xs text-muted-foreground">Transaction</TableHead>
                <TableHead className="hidden px-4 text-xs text-muted-foreground md:table-cell">Business</TableHead>
                <TableHead className="hidden px-4 text-xs text-muted-foreground lg:table-cell">Opened</TableHead>
                <TableHead className="px-4 text-right text-xs text-muted-foreground">Difference</TableHead>
                <TableHead className="px-4 text-xs text-muted-foreground">Status</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {items.map((i) => (
                <TableRow key={i.id} className="relative align-top">
                  <TableCell className="px-4 py-3">
                    <Link
                      href={`/ops/investigations/${i.id}`}
                      className="rounded-full outline-none after:absolute after:inset-0 after:content-[''] focus-visible:after:ring-2 focus-visible:after:ring-ring focus-visible:after:ring-inset"
                    >
                      <span className="sr-only">Investigation: </span>
                      <ReconciliationStatusBadge status={i.recordStatus} />
                    </Link>
                  </TableCell>
                  <TableCell className="px-4 py-3 whitespace-normal">
                    {TYPE_LABELS[i.transactionType]}
                    <span className="block font-mono text-xs text-muted-foreground">{i.transactionId ? i.transactionId.slice(0, 8) : "not in Trace"}</span>
                  </TableCell>
                  <TableCell className="hidden px-4 py-3 md:table-cell">{i.businessName ?? "—"}</TableCell>
                  <TableCell className="hidden px-4 py-3 text-xs text-muted-foreground lg:table-cell">
                    <LocalTime value={i.createdAt} />
                  </TableCell>
                  <TableCell className="px-4 py-3 text-right font-medium">{i.differenceCents ? <Money cents={i.differenceCents} signed className="text-foreground" /> : "—"}</TableCell>
                  <TableCell className="px-4 py-3">{i.status === "OPEN" ? <Tag tone="amber">Open</Tag> : <Tag tone="emerald">Resolved</Tag>}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
    </div>
  );
}
