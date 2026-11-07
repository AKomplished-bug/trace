import Link from "next/link";
import { externalEventStatus } from "../../db/schema";
import { isDurationCounter, latencyByRoute } from "../../services/latency";
import { readCounters } from "../../services/metrics";
import { eventCountsByStatus } from "../../services/ops-events";
import { outboxBacklog } from "../../services/payments";
import { apiDeps } from "../api/deps";
import { EventStatusBadge } from "../_components/status-badge";
import { requirePageSession } from "../_lib/auth";
import { LatencyTable } from "./latency-table";

export const metadata = { title: "Operations · Trace" };

function labelText(labels: Record<string, string>): string {
  return Object.entries(labels)
    .map(([key, value]) => `${key}=${value}`)
    .join(" ");
}

export default async function OpsHome() {
  await requirePageSession("OPS");
  const db = apiDeps().db;
  const [byStatus, backlog, allCounters] = await Promise.all([eventCountsByStatus(db), outboxBacklog(db), readCounters(db)]);
  const counters = allCounters.filter((c) => !isDurationCounter(c.name));

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-lg font-semibold tracking-tight">Operations</h1>
        <p className="text-sm text-neutral-600">Provider events and payment submissions that need attention, and what every workflow step did.</p>
      </div>

      <section className="grid gap-4 lg:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)]">
        <div className="rounded-md border border-neutral-200 bg-white p-5">
          <p className="text-xs font-medium uppercase tracking-wide text-neutral-500">External events by status</p>
          <div className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-3">
            {externalEventStatus.enumValues.map((status) => {
              const alert = status === "FAILED" && byStatus.FAILED > 0;
              return (
                <Link
                  key={status}
                  href={`/ops/events?status=${status}`}
                  className={`rounded border px-3 py-2 hover:bg-neutral-50 ${alert ? "border-red-200 bg-red-50/60" : "border-neutral-200"}`}
                >
                  <EventStatusBadge status={status} />
                  <span className={`mt-1 block font-mono text-2xl tabular-nums ${alert ? "text-red-800" : ""}`}>{byStatus[status]}</span>
                </Link>
              );
            })}
          </div>
          <div className="mt-4 border-t border-neutral-100 pt-3">
            <Link href="/ops/events" className="text-sm text-neutral-600 hover:text-neutral-900">
              Open the event viewer <span aria-hidden>→</span>
            </Link>
          </div>
        </div>

        <div className="rounded-md border border-neutral-200 bg-white p-5">
          <p className="text-xs font-medium uppercase tracking-wide text-neutral-500">Outbound payments</p>
          <dl className="mt-3 space-y-3 text-sm">
            <div className="flex items-baseline justify-between gap-3">
              <dt className={backlog.givenUp > 0 ? "font-medium text-amber-800" : "text-neutral-600"}>Gave up submitting (outcome unknown)</dt>
              <dd className={`font-mono text-2xl tabular-nums ${backlog.givenUp > 0 ? "text-amber-800" : ""}`}>{backlog.givenUp}</dd>
            </div>
            <div className="flex items-baseline justify-between gap-3">
              <dt className="text-neutral-600">Waiting to be submitted</dt>
              <dd className="font-mono tabular-nums">{backlog.pending}</dd>
            </div>
            <div className="flex items-baseline justify-between gap-3">
              <dt className="text-neutral-600">Oldest waiting</dt>
              <dd className="font-mono tabular-nums">{backlog.oldestAgeSeconds === null ? "—" : `${backlog.oldestAgeSeconds} s`}</dd>
            </div>
          </dl>
          <p className="mt-3 text-xs text-neutral-500">
            A given-up payment stays pending with its hold until a provider webhook says what happened or Ops resolves it.
          </p>
          <div className="mt-4 border-t border-neutral-100 pt-3">
            <Link href="/ops/payments" className="text-sm text-neutral-600 hover:text-neutral-900">
              Resolve given-up payments <span aria-hidden>→</span>
            </Link>
          </div>
        </div>
      </section>

      <LatencyTable routes={latencyByRoute(allCounters)} />

      <section className="overflow-hidden rounded-md border border-neutral-200 bg-white">
        <div className="border-b border-neutral-100 px-4 py-2.5">
          <h2 className="text-sm font-semibold">Outcome counters</h2>
          <p className="text-xs text-neutral-500">Since the counters were created; each process adds its counts every few seconds.</p>
        </div>
        {counters.length === 0 ? (
          <p className="px-4 py-6 text-sm text-neutral-600">Nothing counted yet.</p>
        ) : (
          <table className="w-full text-sm">
            <thead className="border-b border-neutral-200 bg-neutral-50 text-left text-xs text-neutral-500">
              <tr>
                <th className="px-4 py-2 font-medium">Counter</th>
                <th className="px-4 py-2 font-medium">Labels</th>
                <th className="px-4 py-2 text-right font-medium">Value</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-neutral-100">
              {counters.map((c) => (
                <tr key={`${c.name} ${labelText(c.labels)}`}>
                  <td className="px-4 py-2 font-mono text-xs">{c.name}</td>
                  <td className="px-4 py-2 font-mono text-xs text-neutral-600">{labelText(c.labels)}</td>
                  <td className="px-4 py-2 text-right font-mono tabular-nums">{c.value}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </div>
  );
}
