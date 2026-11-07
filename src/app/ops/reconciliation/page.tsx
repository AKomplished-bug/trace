import Link from "next/link";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { cn } from "@/lib/utils";
import { reconciliationStatus } from "../../../db/schema";
import { getReconciliationOverview } from "../../../services/reconciliation-queries";
import { apiDeps } from "../../api/deps";
import { FilterBar, SelectFilter } from "../../_components/filters";
import { providerLabel, RECONCILIATION_STATUS_LABELS, RECONCILIATION_STATUS_TONES, TYPE_LABELS } from "../../_components/labels";
import { LocalTime } from "../../_components/local-time";
import { Money } from "../../_components/money";
import { EmptyState, linkClass, Notice, PageHeader, Panel } from "../../_components/page-parts";
import { ReconciliationStatusBadge, RunStatusBadge } from "../../_components/status-badge";
import { requirePageSession } from "../../_lib/auth";
import { DEFAULT_RECONCILIATION_DAYS, RECONCILIATION_PROVIDERS, reconciliationListQuery } from "../../_lib/schemas";
import { InvestigationAction } from "./investigation-action";
import { RunReconciliation } from "./run-actions";

export const metadata = { title: "Reconciliation · Trace" };

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

function first(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

export default async function ReconciliationPage({ searchParams }: { searchParams: SearchParams }) {
  await requirePageSession("OPS");
  const raw = await searchParams;
  const query = reconciliationListQuery.safeParse({ status: first(raw.status) });
  const overview = query.success ? await getReconciliationOverview(apiDeps().db, query.data) : null;
  const filter = query.success ? query.data.status : undefined;

  return (
    <div className="space-y-6">
      <PageHeader
        title="Reconciliation"
        description={`Our transactions against the records each provider's API returns. Each run covers the last ${DEFAULT_RECONCILIATION_DAYS} days.`}
        actions={RECONCILIATION_PROVIDERS.map((provider, i) => (
          <RunReconciliation key={provider} provider={provider} variant={i === 0 ? "default" : "outline"} />
        ))}
      />

      {!overview ? (
        <Notice>
          That filter isn&apos;t valid.{" "}
          <Link href="/ops/reconciliation" className={linkClass}>
            Show all exceptions
          </Link>
        </Notice>
      ) : (
        <>
          <section aria-labelledby="latest-heading" className="space-y-3">
            <h2 id="latest-heading" className="text-base font-semibold">
              Latest successful run per provider
            </h2>
            <ul className="grid grid-cols-2 gap-3 sm:grid-cols-4 lg:grid-cols-7">
              {reconciliationStatus.enumValues.map((status) => {
                const alert = RECONCILIATION_STATUS_TONES[status] === "danger" && overview.counts[status] > 0;
                return (
                  <li key={status}>
                    <Link
                      href={`/ops/reconciliation?status=${status}`}
                      aria-current={filter === status ? "true" : undefined}
                      className={cn(
                        "block h-full rounded-xl border bg-card px-3 py-2.5 hover:bg-muted/60",
                        alert && "border-danger-line/70 shadow-[inset_3px_0_0_var(--danger-line)]",
                        filter === status && "ring-2 ring-ring",
                      )}
                    >
                      <span className="block text-xs text-muted-foreground">{RECONCILIATION_STATUS_LABELS[status]}</span>
                      <span className={cn("mt-1 block text-2xl font-semibold tabular-nums", alert && "text-danger")}>{overview.counts[status]}</span>
                    </Link>
                  </li>
                );
              })}
            </ul>
          </section>

          <section aria-labelledby="exceptions-heading" className="space-y-3">
            <div>
              <h2 id="exceptions-heading" className="text-base font-semibold">
                {filter ? RECONCILIATION_STATUS_LABELS[filter] : "Open exceptions"}
              </h2>
              <p className="text-sm text-muted-foreground">Everything but matched that no one has resolved yet, oldest first.</p>
            </div>
            <FilterBar action="/ops/reconciliation" label="Filter exceptions" filtered={Boolean(filter)}>
              <SelectFilter
                name="status"
                label="Result"
                value={filter ?? ""}
                allLabel="All exceptions"
                options={reconciliationStatus.enumValues.map((status) => ({ value: status, label: RECONCILIATION_STATUS_LABELS[status] }))}
              />
            </FilterBar>
            {overview.exceptions.length === 0 ? (
              <EmptyState title={overview.latestRunIds.length === 0 ? "No reconciliation has finished yet" : "Nothing to work on"}>
                {overview.latestRunIds.length === 0
                  ? "Reconcile a provider to start a run; the worker picks it up."
                  : "Every record in the latest runs matches or is resolved."}
              </EmptyState>
            ) : (
              <div className="overflow-hidden rounded-xl border bg-card">
                <Table>
                  <caption className="sr-only">Open reconciliation exceptions</caption>
                  <TableHeader className="bg-muted/50">
                    <TableRow className="hover:bg-transparent">
                      <TableHead className="px-4 text-xs text-muted-foreground">Result</TableHead>
                      <TableHead className="px-4 text-xs text-muted-foreground">Transaction</TableHead>
                      <TableHead className="hidden px-4 text-xs text-muted-foreground lg:table-cell">Business</TableHead>
                      <TableHead className="hidden px-4 text-right text-xs text-muted-foreground md:table-cell">Trace</TableHead>
                      <TableHead className="hidden px-4 text-right text-xs text-muted-foreground md:table-cell">Provider</TableHead>
                      <TableHead className="px-4 text-right text-xs text-muted-foreground">Difference</TableHead>
                      <TableHead className="hidden px-4 text-xs text-muted-foreground xl:table-cell">Detected</TableHead>
                      <TableHead className="px-4 text-right text-xs text-muted-foreground">
                        <span className="sr-only">Actions</span>
                      </TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {overview.exceptions.map((e) => (
                      <TableRow key={e.id} className="align-top">
                        <TableCell className="px-4 py-3">
                          <ReconciliationStatusBadge status={e.status} />
                          {e.reason && <span className="mt-1 block font-mono text-xs text-muted-foreground">{e.reason}</span>}
                        </TableCell>
                        <TableCell className="px-4 py-3 whitespace-normal">
                          {TYPE_LABELS[e.transactionType]} <span className="text-xs text-muted-foreground">({providerLabel(e.provider)})</span>
                          <span className="block font-mono text-xs break-all text-muted-foreground">
                            {e.transactionId ? e.transactionId.slice(0, 8) : "not in Trace"} ↔ {e.externalId ?? "not at provider"}
                          </span>
                        </TableCell>
                        <TableCell className="hidden px-4 py-3 lg:table-cell">{e.businessName ?? "—"}</TableCell>
                        <TableCell className="hidden px-4 py-3 text-right md:table-cell">{e.internalAmountCents === null ? "—" : <Money cents={e.internalAmountCents} />}</TableCell>
                        <TableCell className="hidden px-4 py-3 text-right md:table-cell">{e.externalAmountCents === null ? "—" : <Money cents={e.externalAmountCents} />}</TableCell>
                        <TableCell className="px-4 py-3 text-right font-medium">{e.differenceCents ? <Money cents={e.differenceCents} signed className="text-foreground" /> : "—"}</TableCell>
                        <TableCell className="hidden px-4 py-3 text-xs text-muted-foreground xl:table-cell">
                          <LocalTime value={e.createdAt} />
                        </TableCell>
                        <TableCell className="space-y-1 px-4 py-3 text-right">
                          <InvestigationAction recordId={e.id} investigationId={e.investigationId} />
                          <Link href={`/ops/reconciliation/${e.runId}#record-${e.id}`} className={`block text-xs ${linkClass}`}>
                            View in run
                          </Link>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            )}
          </section>

          <Panel title="Recent runs" flush>
            {overview.runs.length === 0 ? (
              <p className="px-4 py-8 text-center text-sm text-muted-foreground">No runs yet. Reconcile a provider to start one; the worker picks it up.</p>
            ) : (
              <Table>
                <caption className="sr-only">Recent reconciliation runs</caption>
                <TableHeader className="bg-muted/50">
                  <TableRow className="hover:bg-transparent">
                    <TableHead className="px-4 text-xs text-muted-foreground">Requested</TableHead>
                    <TableHead className="px-4 text-xs text-muted-foreground">Provider</TableHead>
                    <TableHead className="hidden px-4 text-xs text-muted-foreground lg:table-cell">Window</TableHead>
                    <TableHead className="px-4 text-xs text-muted-foreground">Status</TableHead>
                    <TableHead className="hidden px-4 text-right text-xs text-muted-foreground sm:table-cell">Matched</TableHead>
                    <TableHead className="hidden px-4 text-right text-xs text-muted-foreground sm:table-cell">Exceptions</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {overview.runs.map((run) => (
                    <TableRow key={run.id} className="relative align-top">
                      <TableCell className="px-4 py-3 text-xs">
                        <Link
                          href={`/ops/reconciliation/${run.id}`}
                          className="font-medium outline-none after:absolute after:inset-0 after:content-[''] focus-visible:after:ring-2 focus-visible:after:ring-ring focus-visible:after:ring-inset"
                        >
                          <LocalTime value={run.createdAt} />
                        </Link>
                      </TableCell>
                      <TableCell className="px-4 py-3">{providerLabel(run.provider)}</TableCell>
                      <TableCell className="hidden px-4 py-3 text-xs text-muted-foreground lg:table-cell">
                        <LocalTime value={run.windowStart} /> to <LocalTime value={run.windowEnd} />
                      </TableCell>
                      <TableCell className="px-4 py-3">
                        <RunStatusBadge status={run.status} />
                        {run.lastError && <span className="mt-1 block max-w-xs truncate text-xs text-danger">{run.lastError}</span>}
                      </TableCell>
                      <TableCell className="hidden px-4 py-3 text-right tabular-nums sm:table-cell">{run.matchedCount ?? "—"}</TableCell>
                      <TableCell className="hidden px-4 py-3 text-right tabular-nums sm:table-cell">{run.exceptionCount ?? "—"}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </Panel>
        </>
      )}
    </div>
  );
}
