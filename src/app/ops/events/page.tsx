import Link from "next/link";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { cn } from "@/lib/utils";
import { externalEventStatus } from "../../../db/schema";
import { listEvents } from "../../../services/ops-events";
import { apiDeps } from "../../api/deps";
import { FilterBar, Pager, SelectFilter, TextFilter } from "../../_components/filters";
import { EVENT_STATUS_LABELS, providerLabel } from "../../_components/labels";
import { LocalTime } from "../../_components/local-time";
import { EmptyState, linkClass, Notice, PageHeader } from "../../_components/page-parts";
import { EventStatusBadge } from "../../_components/status-badge";
import { requirePageSession } from "../../_lib/auth";
import { EVENT_PROVIDERS, eventListQuery } from "../../_lib/schemas";

export const metadata = { title: "Events · Trace" };

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

function first(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

export default async function EventsPage({ searchParams }: { searchParams: SearchParams }) {
  await requirePageSession("OPS");
  const raw = await searchParams;
  const input = { status: first(raw.status), provider: first(raw.provider), type: first(raw.type), cursor: first(raw.cursor) };
  const query = eventListQuery.safeParse(input);
  const page = query.success ? await listEvents(apiDeps().db, query.data) : null;
  const filtered = Boolean(input.status || input.provider || input.type);

  const pageLink = (cursor?: string) => {
    const params = new URLSearchParams();
    if (query.success && query.data.status) params.set("status", query.data.status);
    if (query.success && query.data.provider) params.set("provider", query.data.provider);
    if (query.success && query.data.type) params.set("type", query.data.type);
    if (cursor) params.set("cursor", cursor);
    const qs = params.toString();
    return qs ? `/ops/events?${qs}` : "/ops/events";
  };

  return (
    <div className="space-y-5">
      <PageHeader title="Events" description="Every provider event we stored, newest first. Payloads are withheld; open an event for its processing history." />

      <FilterBar action="/ops/events" label="Filter events" filtered={filtered}>
        <SelectFilter
          name="status"
          label="Status"
          value={query.success ? (query.data.status ?? "") : ""}
          allLabel="All statuses"
          options={externalEventStatus.enumValues.map((status) => ({ value: status, label: EVENT_STATUS_LABELS[status] }))}
        />
        <SelectFilter
          name="provider"
          label="Provider"
          value={query.success ? (query.data.provider ?? "") : ""}
          allLabel="All providers"
          options={EVENT_PROVIDERS.map((provider) => ({ value: provider, label: providerLabel(provider) }))}
        />
        <TextFilter name="type" label="Event type" value={query.success ? (query.data.type ?? "") : ""} placeholder="e.g. card_payment.updated" />
      </FilterBar>

      {!page ? (
        <Notice>
          That filter or page link isn&apos;t valid.{" "}
          <Link href="/ops/events" className={linkClass}>
            Show all events
          </Link>
        </Notice>
      ) : page.items.length === 0 ? (
        <EmptyState title={filtered ? "No events match these filters" : "No provider events received yet"}>
          {filtered ? "Try another status or provider." : "Webhooks from Stripe and Increase appear here as they arrive."}
        </EmptyState>
      ) : (
        <>
          <div className="overflow-hidden rounded-xl border bg-card">
            <Table>
              <caption className="sr-only">Provider events, newest first</caption>
              <TableHeader className="bg-muted/50">
                <TableRow className="hover:bg-transparent">
                  <TableHead className="px-4 text-xs text-muted-foreground">Event</TableHead>
                  <TableHead className="px-4 text-xs text-muted-foreground">Status</TableHead>
                  <TableHead className="hidden px-4 text-xs text-muted-foreground md:table-cell">Received</TableHead>
                  <TableHead className="hidden px-4 text-right text-xs text-muted-foreground sm:table-cell">Attempts</TableHead>
                  <TableHead className="hidden px-4 text-right text-xs text-muted-foreground sm:table-cell">Deliveries</TableHead>
                  <TableHead className="hidden px-4 text-xs text-muted-foreground lg:table-cell">Processed or next attempt</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {page.items.map((e) => (
                  <TableRow key={e.id} className={cn("relative align-top", e.status === "FAILED" && "bg-danger-soft/50 shadow-[inset_3px_0_0_var(--danger-line)]")}>
                    <TableCell className="max-w-xs px-4 py-3 whitespace-normal">
                      <Link
                        href={`/ops/events/${e.id}`}
                        className="font-mono text-xs font-medium break-all outline-none after:absolute after:inset-0 after:content-[''] focus-visible:after:ring-2 focus-visible:after:ring-ring focus-visible:after:ring-inset"
                      >
                        {e.eventType}
                      </Link>
                      <span className="block truncate font-mono text-xs text-muted-foreground">
                        {providerLabel(e.provider)}, {e.externalEventId}
                      </span>
                      {e.lastError && <span className="block truncate text-xs text-danger">{e.lastError}</span>}
                    </TableCell>
                    <TableCell className="px-4 py-3">
                      <EventStatusBadge status={e.status} />
                    </TableCell>
                    <TableCell className="hidden px-4 py-3 text-xs text-muted-foreground md:table-cell">
                      <LocalTime value={e.receivedAt} />
                    </TableCell>
                    <TableCell className="hidden px-4 py-3 text-right tabular-nums sm:table-cell">{e.attempts}</TableCell>
                    <TableCell className="hidden px-4 py-3 text-right tabular-nums sm:table-cell">{e.deliveryCount}</TableCell>
                    <TableCell className="hidden px-4 py-3 text-xs text-muted-foreground lg:table-cell">
                      {e.processedAt ? (
                        <LocalTime value={e.processedAt} />
                      ) : e.status === "RECEIVED" || e.status === "RETRY" ? (
                        <>
                          Next <LocalTime value={e.nextAttemptAt} />
                        </>
                      ) : (
                        "—"
                      )}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
          <Pager newest={input.cursor ? pageLink() : null} older={page.nextCursor ? pageLink(page.nextCursor) : null} />
        </>
      )}
    </div>
  );
}
