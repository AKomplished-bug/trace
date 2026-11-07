import { ArrowRight, CircleCheck } from "lucide-react";
import Link from "next/link";
import type { ReactNode } from "react";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { cn } from "@/lib/utils";
import { externalEventStatus } from "../../db/schema";
import { listInvestigations } from "../../services/investigations";
import { isDurationCounter, latencyByRoute } from "../../services/latency";
import { readCounters } from "../../services/metrics";
import { listGivenUpPayments } from "../../services/ops-payments";
import { eventCountsByStatus, listEvents } from "../../services/ops-events";
import { outboxBacklog } from "../../services/payments";
import { getReconciliationOverview } from "../../services/reconciliation-queries";
import { apiDeps } from "../api/deps";
import { providerLabel, RECONCILIATION_STATUS_LABELS, TYPE_LABELS } from "../_components/labels";
import { LocalTime } from "../_components/local-time";
import { Money } from "../_components/money";
import { linkClass, PageHeader, Panel } from "../_components/page-parts";
import { EventStatusBadge } from "../_components/status-badge";
import { requirePageSession } from "../_lib/auth";
import { RECONCILIATION_PROVIDERS } from "../_lib/schemas";
import { RetryButton } from "./events/[id]/retry-button";
import { LatencyTable } from "./latency-table";
import { PaymentActions } from "./payments/payment-actions";
import { RunReconciliation } from "./reconciliation/run-actions";

export const metadata = { title: "Operations · Trace" };

/** How many items of each queue the overview lists inline; the rest are a click away. */
const INLINE = 3;

function labelText(labels: Record<string, string>): string {
  return Object.entries(labels)
    .map(([key, value]) => `${key}=${value}`)
    .join(" ");
}

/** One queue: its count, what it means, the first few items with their one-click action, and a link to all of them. */
function Queue({ title, count, href, linkText, clear, children }: { title: string; count: number; href: string; linkText: string; clear: string; children?: ReactNode }) {
  const open = count > 0;
  return (
    <section
      aria-labelledby={`queue-${href}`}
      className={cn("flex min-w-0 flex-col rounded-xl border bg-card", open && "border-danger-line/70 shadow-[inset_3px_0_0_var(--danger-line)]")}
    >
      <div className="flex items-start justify-between gap-3 px-4 pt-4">
        <h3 id={`queue-${href}`} className="text-sm font-medium">
          {title}
        </h3>
        <span className={cn("text-2xl leading-none font-semibold tabular-nums", open ? "text-danger" : "text-muted-foreground")}>{count}</span>
      </div>
      <div className="flex-1 px-4 pt-2 pb-3 text-sm">
        {open ? (
          children
        ) : (
          <p className="flex items-center gap-1.5 text-muted-foreground">
            <CircleCheck aria-hidden className="size-4 text-success" />
            {clear}
          </p>
        )}
      </div>
      <div className="border-t px-4 py-2.5">
        <Link href={href} className={`inline-flex items-center gap-1 text-sm ${linkClass}`}>
          {linkText}
          <ArrowRight aria-hidden className="size-4" />
        </Link>
      </div>
    </section>
  );
}

export default async function OpsHome() {
  await requirePageSession("OPS");
  const db = apiDeps().db;
  const [byStatus, backlog, allCounters, failedEvents, givenUp, reconciliation, openInvestigations] = await Promise.all([
    eventCountsByStatus(db),
    outboxBacklog(db),
    readCounters(db),
    listEvents(db, { status: "FAILED", limit: INLINE }),
    listGivenUpPayments(db),
    getReconciliationOverview(db, {}),
    listInvestigations(db, { status: "OPEN" }),
  ]);
  const counters = allCounters.filter((c) => !isDurationCounter(c.name));
  const exceptions = reconciliation.exceptions;
  const needsAttention = byStatus.FAILED + backlog.givenUp + exceptions.length + openInvestigations.length;

  return (
    <div className="space-y-8">
      <PageHeader
        title="Operations"
        description={
          needsAttention === 0
            ? "Nothing needs attention right now. Metrics for every workflow step are below."
            : `${needsAttention} ${needsAttention === 1 ? "item needs" : "items need"} attention. Work the queues first; metrics are below.`
        }
      />

      <section aria-labelledby="attention-heading" className="space-y-3">
        <h2 id="attention-heading" className="text-base font-semibold">
          Needs attention
        </h2>
        <div className="grid gap-4 md:grid-cols-2">
          <Queue title="Failed events" count={byStatus.FAILED} href="/ops/events?status=FAILED" linkText="All failed events" clear="Every provider event processed or is retrying.">
            <ul className="divide-y">
              {failedEvents.items.map((e) => (
                <li key={e.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
                  <span className="min-w-0">
                    <Link href={`/ops/events/${e.id}`} className="font-mono text-xs font-medium break-all underline-offset-4 hover:underline">
                      {e.eventType}
                    </Link>
                    <span className="block text-xs text-muted-foreground">
                      {providerLabel(e.provider)}, {e.attempts} attempts
                    </span>
                  </span>
                  <RetryButton eventId={e.id} size="sm" />
                </li>
              ))}
            </ul>
          </Queue>

          <Queue title="Given-up payments" count={backlog.givenUp} href="/ops/payments" linkText="Resolve given-up payments" clear="Every outbound payment was submitted or is waiting its turn.">
            <p className="text-xs text-muted-foreground">Outcome at Increase unknown; each still holds its amount.</p>
            <ul className="mt-1 divide-y">
              {givenUp.slice(0, INLINE).map((p) => (
                <li key={p.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
                  <span className="min-w-0">
                    <Money cents={p.amountCents} className="font-medium" />
                    <span className="block font-mono text-xs text-muted-foreground" title={p.id}>
                      payment {p.id.slice(0, 8)}
                    </span>
                  </span>
                  <PaymentActions paymentId={p.id} notYetConfirmable={null} requeueOnly />
                </li>
              ))}
            </ul>
          </Queue>

          <Queue
            title="Open reconciliation exceptions"
            count={exceptions.length}
            href="/ops/reconciliation"
            linkText="Open the reconciliation queue"
            clear={reconciliation.latestRunIds.length === 0 ? "No reconciliation has finished yet." : "Every record in the latest runs matches or is resolved."}
          >
            <ul className="divide-y">
              {exceptions.slice(0, INLINE).map((e) => (
                <li key={e.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
                  <span className="min-w-0">
                    <span className="font-medium">{RECONCILIATION_STATUS_LABELS[e.status]}</span>
                    <span className="block text-xs text-muted-foreground">
                      {TYPE_LABELS[e.transactionType]}, {providerLabel(e.provider)}
                    </span>
                  </span>
                  {e.differenceCents ? <Money cents={e.differenceCents} signed className="font-medium text-foreground" /> : null}
                </li>
              ))}
            </ul>
          </Queue>

          <Queue title="Open investigations" count={openInvestigations.length} href="/ops/investigations?status=OPEN" linkText="All open investigations" clear="No open cases.">
            <ul className="divide-y">
              {openInvestigations.slice(0, INLINE).map((i) => (
                <li key={i.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
                  <Link href={`/ops/investigations/${i.id}`} className="font-medium underline-offset-4 hover:underline">
                    {RECONCILIATION_STATUS_LABELS[i.recordStatus]}, {TYPE_LABELS[i.transactionType].toLowerCase()}
                  </Link>
                  <span className="text-xs text-muted-foreground">
                    Opened <LocalTime value={i.createdAt} />
                  </span>
                </li>
              ))}
            </ul>
          </Queue>
        </div>
        <div className="flex flex-wrap items-center gap-2 rounded-xl border bg-card px-4 py-3">
          <p className="mr-auto text-sm text-muted-foreground">Check our books against a provider&apos;s records:</p>
          {RECONCILIATION_PROVIDERS.map((provider) => (
            <RunReconciliation key={provider} provider={provider} size="sm" />
          ))}
        </div>
      </section>

      <section aria-labelledby="metrics-heading" className="space-y-3">
        <h2 id="metrics-heading" className="text-base font-semibold">
          Metrics
        </h2>
        <div className="grid gap-4 lg:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)]">
          <Panel title="External events by status" aside={<Link href="/ops/events" className={`text-sm ${linkClass}`}>Event viewer</Link>}>
            <ul className="grid grid-cols-2 gap-3 sm:grid-cols-3">
              {externalEventStatus.enumValues.map((status) => (
                <li key={status}>
                  <Link
                    href={`/ops/events?status=${status}`}
                    className="block rounded-lg border px-3 py-2.5 hover:bg-muted/60"
                  >
                    <EventStatusBadge status={status} />
                    <span className="mt-1.5 block text-2xl font-semibold tabular-nums">{byStatus[status]}</span>
                  </Link>
                </li>
              ))}
            </ul>
          </Panel>

          <Panel title="Outbound payment queue">
            <dl className="grid grid-cols-[minmax(0,1fr)_max-content] gap-y-2.5 text-sm">
              <dt className="text-muted-foreground">Gave up submitting</dt>
              <dd className={cn("text-right font-semibold tabular-nums", backlog.givenUp > 0 && "text-danger")}>{backlog.givenUp}</dd>
              <dt className="text-muted-foreground">Waiting to be submitted</dt>
              <dd className="text-right font-semibold tabular-nums">{backlog.pending}</dd>
              <dt className="text-muted-foreground">Oldest waiting</dt>
              <dd className="text-right font-semibold tabular-nums">{backlog.oldestAgeSeconds === null ? "None" : `${backlog.oldestAgeSeconds} s`}</dd>
            </dl>
          </Panel>
        </div>

        <LatencyTable routes={latencyByRoute(allCounters)} />

        <Panel title="Outcome counters" description="Since the counters were created; each process adds its counts every few seconds." flush>
          {counters.length === 0 ? (
            <p className="px-4 py-6 text-sm text-muted-foreground">Nothing counted yet.</p>
          ) : (
            <Table>
              <caption className="sr-only">Outcome counters</caption>
              <TableHeader className="bg-muted/50">
                <TableRow className="hover:bg-transparent">
                  <TableHead className="px-4 text-xs text-muted-foreground">Counter</TableHead>
                  <TableHead className="px-4 text-xs text-muted-foreground">Labels</TableHead>
                  <TableHead className="px-4 text-right text-xs text-muted-foreground">Value</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {counters.map((c) => (
                  <TableRow key={`${c.name} ${labelText(c.labels)}`}>
                    <TableCell className="px-4 font-mono text-xs break-all whitespace-normal">{c.name}</TableCell>
                    <TableCell className="px-4 font-mono text-xs break-all whitespace-normal text-muted-foreground">{labelText(c.labels)}</TableCell>
                    <TableCell className="px-4 text-right tabular-nums">{c.value}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </Panel>
      </section>
    </div>
  );
}
