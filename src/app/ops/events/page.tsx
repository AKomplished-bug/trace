import Link from "next/link";
import { externalEventStatus } from "../../../db/schema";
import { listEvents } from "../../../services/ops-events";
import { apiDeps } from "../../api/deps";
import { providerLabel } from "../../_components/labels";
import { LocalTime } from "../../_components/local-time";
import { EventStatusBadge } from "../../_components/status-badge";
import { requirePageSession } from "../../_lib/auth";
import { EVENT_PROVIDERS, eventListQuery } from "../../_lib/schemas";

export const metadata = { title: "Events · Trace" };

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

function first(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

const control = "rounded border border-neutral-300 bg-white px-2 py-1";

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
    <div className="space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-lg font-semibold tracking-tight">External events</h1>
          <p className="text-sm text-neutral-600">Every provider event we stored, newest first. Payloads are withheld.</p>
        </div>
        <form method="get" action="/ops/events" className="flex flex-wrap items-center gap-2 text-sm">
          <select name="status" defaultValue={query.success ? (query.data.status ?? "") : ""} aria-label="Status" className={control}>
            <option value="">All statuses</option>
            {externalEventStatus.enumValues.map((status) => (
              <option key={status} value={status}>
                {status}
              </option>
            ))}
          </select>
          <select name="provider" defaultValue={query.success ? (query.data.provider ?? "") : ""} aria-label="Provider" className={control}>
            <option value="">All providers</option>
            {EVENT_PROVIDERS.map((provider) => (
              <option key={provider} value={provider}>
                {providerLabel(provider)}
              </option>
            ))}
          </select>
          <input
            name="type"
            defaultValue={query.success ? (query.data.type ?? "") : ""}
            aria-label="Event type"
            placeholder="Event type"
            className={`${control} font-mono`}
          />
          <button type="submit" className="rounded bg-neutral-900 px-3 py-1 font-medium text-white hover:bg-neutral-700">
            Apply
          </button>
          {filtered && (
            <Link href="/ops/events" className="px-1 text-neutral-600 hover:text-neutral-900">
              Clear
            </Link>
          )}
        </form>
      </div>

      {!page ? (
        <div className="rounded-md border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900">
          That filter or page link isn&apos;t valid.{" "}
          <Link href="/ops/events" className="underline">
            Show all events
          </Link>
        </div>
      ) : page.items.length === 0 ? (
        <div className="rounded-md border border-dashed border-neutral-300 bg-white px-5 py-10 text-center text-sm text-neutral-600">
          {filtered ? "No events match these filters." : "No provider events received yet."}
        </div>
      ) : (
        <>
          <div className="overflow-x-auto rounded-md border border-neutral-200 bg-white">
            <table className="w-full text-sm">
              <thead className="border-b border-neutral-200 bg-neutral-50 text-left text-xs text-neutral-500">
                <tr>
                  <th className="px-4 py-2 font-medium">Received</th>
                  <th className="px-4 py-2 font-medium">Event</th>
                  <th className="px-4 py-2 font-medium">Status</th>
                  <th className="px-4 py-2 text-right font-medium">Attempts</th>
                  <th className="px-4 py-2 text-right font-medium">Deliveries</th>
                  <th className="px-4 py-2 font-medium">Processed / next attempt</th>
                  <th className="px-4 py-2 text-right font-medium">Transactions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-neutral-100">
                {page.items.map((e) => (
                  <tr key={e.id} className="relative align-top hover:bg-neutral-50">
                    <td className="whitespace-nowrap px-4 py-2.5 text-xs text-neutral-500">
                      <LocalTime value={e.receivedAt} />
                    </td>
                    <td className="max-w-xs px-4 py-2.5">
                      <Link href={`/ops/events/${e.id}`} className="font-mono text-xs font-medium after:absolute after:inset-0">
                        {e.eventType}
                      </Link>
                      <span className="block truncate font-mono text-xs text-neutral-500">
                        {providerLabel(e.provider)} · {e.externalEventId}
                      </span>
                      {e.lastError && <span className="block truncate text-xs text-red-700">{e.lastError}</span>}
                    </td>
                    <td className="px-4 py-2.5">
                      <EventStatusBadge status={e.status} />
                    </td>
                    <td className="px-4 py-2.5 text-right font-mono tabular-nums">{e.attempts}</td>
                    <td className="px-4 py-2.5 text-right font-mono tabular-nums">{e.deliveryCount}</td>
                    <td className="whitespace-nowrap px-4 py-2.5 text-xs text-neutral-500">
                      {e.processedAt ? (
                        <LocalTime value={e.processedAt} />
                      ) : e.status === "RECEIVED" || e.status === "RETRY" ? (
                        <>
                          next <LocalTime value={e.nextAttemptAt} />
                        </>
                      ) : (
                        "—"
                      )}
                    </td>
                    <td className="px-4 py-2.5 text-right font-mono text-xs text-neutral-600">
                      {e.transactionIds.length
                        ? e.transactionIds.map((id) => (
                            <span key={id} title={id} className="block">
                              {id.slice(0, 8)}
                            </span>
                          ))
                        : "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="flex justify-between text-sm">
            {input.cursor ? (
              <Link href={pageLink()} className="text-neutral-600 hover:text-neutral-900">
                ← Newest
              </Link>
            ) : (
              <span />
            )}
            {page.nextCursor && (
              <Link href={pageLink(page.nextCursor)} className="text-neutral-600 hover:text-neutral-900">
                Older →
              </Link>
            )}
          </div>
        </>
      )}
    </div>
  );
}
