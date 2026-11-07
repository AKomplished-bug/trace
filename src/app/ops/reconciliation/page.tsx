import Link from "next/link";
import { reconciliationStatus } from "../../../db/schema";
import { getReconciliationOverview } from "../../../services/reconciliation-queries";
import { apiDeps } from "../../api/deps";
import { providerLabel, TYPE_LABELS } from "../../_components/labels";
import { LocalTime } from "../../_components/local-time";
import { Money } from "../../_components/money";
import { ReconciliationStatusBadge, RunStatusBadge } from "../../_components/status-badge";
import { requirePageSession } from "../../_lib/auth";
import { DEFAULT_RECONCILIATION_DAYS, RECONCILIATION_PROVIDERS, reconciliationListQuery } from "../../_lib/schemas";
import { ActionButton } from "./action-button";

export const metadata = { title: "Reconciliation · Trace" };

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

function first(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

const control = "rounded border border-neutral-300 bg-white px-2 py-1";

export default async function ReconciliationPage({ searchParams }: { searchParams: SearchParams }) {
  await requirePageSession("OPS");
  const raw = await searchParams;
  const query = reconciliationListQuery.safeParse({ status: first(raw.status) });
  const overview = query.success ? await getReconciliationOverview(apiDeps().db, query.data) : null;
  const filter = query.success ? query.data.status : undefined;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-lg font-semibold tracking-tight">Reconciliation</h1>
          <p className="text-sm text-neutral-600">
            Our transactions against the records each provider&apos;s API returns. Each run covers the last {DEFAULT_RECONCILIATION_DAYS} days.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          {RECONCILIATION_PROVIDERS.map((provider) => (
            <ActionButton
              key={provider}
              url="/api/ops/reconciliation/run"
              body={{ provider }}
              label={`Reconcile ${providerLabel(provider)}`}
              pendingLabel="Requesting…"
              open="run"
            />
          ))}
        </div>
      </div>

      {!overview ? (
        <div className="rounded-md border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900">
          That filter isn&apos;t valid.{" "}
          <Link href="/ops/reconciliation" className="underline">
            Show all exceptions
          </Link>
        </div>
      ) : (
        <>
          <section className="rounded-md border border-neutral-200 bg-white p-5">
            <p className="text-xs font-medium uppercase tracking-wide text-neutral-500">Latest successful run per provider</p>
            <div className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-4 lg:grid-cols-7">
              {reconciliationStatus.enumValues.map((status) => {
                const alert = status !== "MATCHED" && status !== "PENDING_EXTERNAL" && overview.counts[status] > 0;
                return (
                  <Link
                    key={status}
                    href={`/ops/reconciliation?status=${status}`}
                    className={`rounded border px-3 py-2 hover:bg-neutral-50 ${alert ? "border-red-200 bg-red-50/60" : "border-neutral-200"} ${filter === status ? "ring-2 ring-neutral-400" : ""}`}
                  >
                    <ReconciliationStatusBadge status={status} />
                    <span className={`mt-1 block font-mono text-2xl tabular-nums ${alert ? "text-red-800" : ""}`}>{overview.counts[status]}</span>
                  </Link>
                );
              })}
            </div>
          </section>

          <section className="overflow-hidden rounded-md border border-neutral-200 bg-white">
            <div className="flex flex-wrap items-center justify-between gap-3 border-b border-neutral-100 px-4 py-2.5">
              <div>
                <h2 className="text-sm font-semibold">{filter ? `${filter} records` : "Open exceptions"}</h2>
                <p className="text-xs text-neutral-500">Everything but MATCHED that no one has resolved yet, oldest first.</p>
              </div>
              <form method="get" action="/ops/reconciliation" className="flex items-center gap-2 text-sm">
                <select name="status" defaultValue={filter ?? ""} aria-label="Status" className={control}>
                  <option value="">All exceptions</option>
                  {reconciliationStatus.enumValues.map((status) => (
                    <option key={status} value={status}>
                      {status}
                    </option>
                  ))}
                </select>
                <button type="submit" className="rounded bg-neutral-900 px-3 py-1 font-medium text-white hover:bg-neutral-700">
                  Apply
                </button>
              </form>
            </div>
            {overview.exceptions.length === 0 ? (
              <p className="px-4 py-8 text-center text-sm text-neutral-600">
                {overview.latestRunIds.length === 0 ? "No reconciliation has finished yet." : "Nothing here: every record in the latest runs matches or is resolved."}
              </p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead className="border-b border-neutral-200 bg-neutral-50 text-left text-xs text-neutral-500">
                    <tr>
                      <th className="px-4 py-2 font-medium">Status</th>
                      <th className="px-4 py-2 font-medium">Business</th>
                      <th className="px-4 py-2 font-medium">Transaction</th>
                      <th className="px-4 py-2 text-right font-medium">Internal</th>
                      <th className="px-4 py-2 text-right font-medium">External</th>
                      <th className="px-4 py-2 text-right font-medium">Difference</th>
                      <th className="px-4 py-2 font-medium">Detected</th>
                      <th className="px-4 py-2 font-medium" />
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-neutral-100">
                    {overview.exceptions.map((e) => (
                      <tr key={e.id} className="align-top">
                        <td className="px-4 py-2.5">
                          <ReconciliationStatusBadge status={e.status} />
                          {e.reason && <span className="block font-mono text-xs text-neutral-500">{e.reason}</span>}
                        </td>
                        <td className="px-4 py-2.5">{e.businessName ?? "—"}</td>
                        <td className="px-4 py-2.5">
                          {TYPE_LABELS[e.transactionType]} <span className="text-xs text-neutral-500">· {providerLabel(e.provider)}</span>
                          <span className="block font-mono text-xs text-neutral-500">
                            {e.transactionId ? e.transactionId.slice(0, 8) : "not in Trace"} ↔ {e.externalId ?? "not at provider"}
                          </span>
                        </td>
                        <td className="px-4 py-2.5 text-right">{e.internalAmountCents === null ? "—" : <Money cents={e.internalAmountCents} />}</td>
                        <td className="px-4 py-2.5 text-right">{e.externalAmountCents === null ? "—" : <Money cents={e.externalAmountCents} />}</td>
                        <td className="px-4 py-2.5 text-right">{e.differenceCents ? <Money cents={e.differenceCents} signed /> : "—"}</td>
                        <td className="whitespace-nowrap px-4 py-2.5 text-xs text-neutral-500">
                          <LocalTime value={e.createdAt} />
                        </td>
                        <td className="px-4 py-2.5 text-right">
                          <Link href={`/ops/reconciliation/${e.runId}#record-${e.id}`} className="text-xs text-neutral-600 hover:text-neutral-900">
                            Run →
                          </Link>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>

          <section className="overflow-hidden rounded-md border border-neutral-200 bg-white">
            <h2 className="border-b border-neutral-100 px-4 py-2.5 text-sm font-semibold">Recent runs</h2>
            {overview.runs.length === 0 ? (
              <p className="px-4 py-8 text-center text-sm text-neutral-600">No runs yet. Reconcile a provider to start one; the worker picks it up.</p>
            ) : (
              <table className="w-full text-sm">
                <thead className="border-b border-neutral-200 bg-neutral-50 text-left text-xs text-neutral-500">
                  <tr>
                    <th className="px-4 py-2 font-medium">Requested</th>
                    <th className="px-4 py-2 font-medium">Provider</th>
                    <th className="px-4 py-2 font-medium">Window</th>
                    <th className="px-4 py-2 font-medium">Status</th>
                    <th className="px-4 py-2 text-right font-medium">Matched</th>
                    <th className="px-4 py-2 text-right font-medium">Exceptions</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-neutral-100">
                  {overview.runs.map((run) => (
                    <tr key={run.id} className="relative align-top hover:bg-neutral-50">
                      <td className="whitespace-nowrap px-4 py-2.5 text-xs">
                        <Link href={`/ops/reconciliation/${run.id}`} className="after:absolute after:inset-0">
                          <LocalTime value={run.createdAt} />
                        </Link>
                      </td>
                      <td className="px-4 py-2.5">{providerLabel(run.provider)}</td>
                      <td className="px-4 py-2.5 text-xs text-neutral-600">
                        <LocalTime value={run.windowStart} /> → <LocalTime value={run.windowEnd} />
                      </td>
                      <td className="px-4 py-2.5">
                        <RunStatusBadge status={run.status} />
                        {run.lastError && <span className="block max-w-xs truncate text-xs text-red-700">{run.lastError}</span>}
                      </td>
                      <td className="px-4 py-2.5 text-right font-mono tabular-nums">{run.matchedCount ?? "—"}</td>
                      <td className="px-4 py-2.5 text-right font-mono tabular-nums">{run.exceptionCount ?? "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </section>
        </>
      )}
    </div>
  );
}
