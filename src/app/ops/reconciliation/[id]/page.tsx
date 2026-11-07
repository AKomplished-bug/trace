import { ChevronLeft } from "lucide-react";
import Link from "next/link";
import { notFound } from "next/navigation";
import type { ReactNode } from "react";
import { getRunDetail } from "../../../../services/reconciliation-queries";
import { apiDeps } from "../../../api/deps";
import { providerLabel, TYPE_LABELS } from "../../../_components/labels";
import { LocalTime } from "../../../_components/local-time";
import { Money } from "../../../_components/money";
import { ReconciliationStatusBadge, RunStatusBadge } from "../../../_components/status-badge";
import { requirePageSession } from "../../../_lib/auth";
import { runIdParams } from "../../../_lib/schemas";
import { RetryRun } from "../run-actions";
import { InvestigationAction } from "../investigation-action";

export const metadata = { title: "Reconciliation run · Trace" };

function Id({ value }: { value: string | null }) {
  return value ? <code className="break-all font-mono text-xs text-foreground">{value}</code> : <span className="text-xs text-muted-foreground">—</span>;
}

function Side({ title, id, refId, status, cents }: { title: string; id: ReactNode; refId?: string | null; status: string | null; cents: number | null }) {
  return (
    <div className="min-w-0">
      <p className="text-xs font-medium text-muted-foreground">{title}</p>
      {status === null && cents === null ? (
        <p className="mt-1 text-sm text-muted-foreground">No record</p>
      ) : (
        <dl className="mt-1 grid grid-cols-[max-content_minmax(0,1fr)] gap-x-3 gap-y-0.5 text-xs">
          <dt className="text-muted-foreground">Id</dt>
          <dd>{id}</dd>
          {refId !== undefined && (
            <>
              <dt className="text-muted-foreground">Element</dt>
              <dd>
                <Id value={refId} />
              </dd>
            </>
          )}
          <dt className="text-muted-foreground">Status</dt>
          <dd className="font-mono">{status ?? "—"}</dd>
          <dt className="text-muted-foreground">Amount</dt>
          <dd>{cents === null ? "—" : <Money cents={cents} />}</dd>
        </dl>
      )}
    </div>
  );
}

function stateText(state: unknown): string {
  if (!state || typeof state !== "object") return "—";
  return Object.entries(state)
    .map(([key, value]) => `${key}=${String(value)}`)
    .join(" ");
}

export default async function RunPage({ params }: { params: Promise<{ id: string }> }) {
  await requirePageSession("OPS");
  const parsed = runIdParams.safeParse(await params);
  if (!parsed.success) notFound();
  const detail = await getRunDetail(apiDeps().db, parsed.data.id);
  if (!detail) notFound();
  const { run, records, audit } = detail;

  return (
    <div className="space-y-4">
      <Link href="/ops/reconciliation" className="inline-flex min-h-6 items-center gap-1 text-sm font-medium text-primary underline-offset-4 hover:underline">
        <ChevronLeft aria-hidden className="size-4" />
        Reconciliation
      </Link>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">{providerLabel(run.provider)} reconciliation</h1>
          <p className="text-sm text-muted-foreground">
            Records created <LocalTime value={run.windowStart} /> → <LocalTime value={run.windowEnd} />
          </p>
        </div>
        <RunStatusBadge status={run.status} />
      </div>

      {run.status === "FAILED" && (
        <div className="rounded-xl border border-danger-line/70 bg-danger-soft p-4">
          <p className="text-sm font-medium text-danger">The run failed after {run.attempts} attempt{run.attempts === 1 ? "" : "s"}; no records were stored.</p>
          {run.lastError && <p className="mt-1 break-words font-mono text-xs text-danger">{run.lastError}</p>}
          <div className="mt-3">
            <RetryRun runId={run.id} />
          </div>
        </div>
      )}
      {(run.status === "PENDING" || run.status === "RUNNING") && (
        <p className="rounded-xl border border-pending-line bg-pending-soft px-4 py-3 text-sm text-pending">
          {run.status === "PENDING" ? "Waiting for the worker to pick this run up." : "The worker is fetching the provider's records."} Refresh to see the
          results.
        </p>
      )}

      <section className="rounded-xl border border-border bg-card p-4">
        <dl className="grid grid-cols-2 gap-3 text-sm sm:grid-cols-4">
          <div>
            <dt className="text-xs text-muted-foreground">Requested</dt>
            <dd>
              <LocalTime value={run.createdAt} />
            </dd>
          </div>
          <div>
            <dt className="text-xs text-muted-foreground">Finished</dt>
            <dd>{run.finishedAt ? <LocalTime value={run.finishedAt} /> : "—"}</dd>
          </div>
          <div>
            <dt className="text-xs text-muted-foreground">Matched</dt>
            <dd className="font-mono tabular-nums">{run.matchedCount ?? "—"}</dd>
          </div>
          <div>
            <dt className="text-xs text-muted-foreground">Exceptions</dt>
            <dd className="font-mono tabular-nums">{run.exceptionCount ?? "—"}</dd>
          </div>
        </dl>
      </section>

      <section className="rounded-xl border border-border bg-card">
        <h2 className="border-b border-border px-4 py-2.5 text-sm font-semibold">Records ({records.length})</h2>
        {records.length === 0 ? (
          <p className="px-4 py-6 text-sm text-muted-foreground">{run.status === "SUCCEEDED" ? "Neither side had anything in this window." : "None yet."}</p>
        ) : (
          <ul className="divide-y divide-border">
            {records.map((r) => (
              <li key={r.id} id={`record-${r.id}`} className="scroll-mt-4 px-4 py-3 target:bg-pending-soft">
                <div className="flex flex-wrap items-center gap-2">
                  <ReconciliationStatusBadge status={r.status} />
                  {r.reason && <span className="font-mono text-xs text-muted-foreground">{r.reason}</span>}
                  <span className="text-sm">{TYPE_LABELS[r.transactionType]}</span>
                  {r.differenceCents ? (
                    <span className="text-xs text-muted-foreground">
                      difference <Money cents={r.differenceCents} signed className="text-foreground" />
                    </span>
                  ) : null}
                  {r.resolvedAt && <span className="text-xs text-success">resolved <LocalTime value={r.resolvedAt} /></span>}
                  {r.status !== "MATCHED" && (
                    <span className="ml-auto">
                      <InvestigationAction recordId={r.id} investigationId={r.investigationId} />
                    </span>
                  )}
                </div>
                <div className="mt-2 grid gap-4 sm:grid-cols-2">
                  <Side title="Trace" id={<Id value={r.transactionId} />} status={r.internalStatus} cents={r.internalAmountCents} />
                  <Side title={providerLabel(run.provider)} id={<Id value={r.externalId} />} refId={r.externalRef} status={r.externalStatus} cents={r.externalAmountCents} />
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="rounded-xl border border-border bg-card">
        <h2 className="border-b border-border px-4 py-2.5 text-sm font-semibold">Ops actions</h2>
        <div className="p-4">
          {audit.length === 0 ? (
            <p className="text-sm text-muted-foreground">None.</p>
          ) : (
            <ol className="space-y-2 text-sm">
              {audit.map((a) => (
                <li key={a.id}>
                  <span className="font-mono text-xs font-medium">{a.action}</span>{" "}
                  <span className="text-xs text-muted-foreground">
                    by <code className="font-mono">{a.actorId ?? "system"}</code> · <LocalTime value={a.createdAt} />
                  </span>
                  <span className="block font-mono text-xs text-muted-foreground">
                    {stateText(a.previousState)} → {stateText(a.newState)}
                  </span>
                </li>
              ))}
            </ol>
          )}
        </div>
      </section>
    </div>
  );
}
