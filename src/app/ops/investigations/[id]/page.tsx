import { ChevronLeft } from "lucide-react";
import Link from "next/link";
import { notFound } from "next/navigation";
import type { ReactNode } from "react";
import { suggestedAdjustmentCents, type ReconciliationStatus } from "../../../../domain/reconciliation";
import { getInvestigationDetail } from "../../../../services/investigations";
import { apiDeps } from "../../../api/deps";
import { ENTRY_LABELS, providerLabel, TYPE_LABELS } from "../../../_components/labels";
import { LocalTime } from "../../../_components/local-time";
import { Money } from "../../../_components/money";
import { ReconciliationStatusBadge, StatusBadge, Tag } from "../../../_components/status-badge";
import { describeStep, stepAmount } from "../../../_components/trace-copy";
import { requirePageSession } from "../../../_lib/auth";
import { investigationIdParams } from "../../../_lib/schemas";
import { NoteForm, ResolveForm } from "./investigation-forms";

export const metadata = { title: "Investigation · Trace" };

const LIKELY_CAUSES: Record<ReconciliationStatus, string[]> = {
  MATCHED: [],
  AMOUNT_MISMATCH: [
    "The merchant captured a different amount than we recorded (settlement differs from authorization).",
    "A partial refund or capture at the provider that we haven't applied.",
  ],
  STATUS_MISMATCH: [
    "An event for this record is waiting, retrying or FAILED — check the event viewer.",
    "A duplicate or out-of-order event, or a step the provider recorded under another element id.",
  ],
  MISSING_INTERNAL: ["The provider's webhook never arrived or failed.", "The record was created outside Trace (e.g. in the provider dashboard)."],
  MISSING_EXTERNAL: ["The provider call failed before it created anything.", "The record lives at another provider account, or outside the run's window."],
  DUPLICATE: ["A client retry after the provider's idempotency window created a second record.", "The provider captured twice."],
  PENDING_EXTERNAL: ["One side is still catching up (provider delay or an event in retry); run reconciliation again later."],
};

function Panel({ title, children, aside }: { title: string; children: ReactNode; aside?: ReactNode }) {
  return (
    <section className="rounded-xl border border-border bg-card">
      <div className="flex items-baseline justify-between border-b border-border px-4 py-2.5">
        <h2 className="text-sm font-semibold">{title}</h2>
        {aside}
      </div>
      <div className="p-4">{children}</div>
    </section>
  );
}

function Id({ value }: { value: string | null }) {
  return value ? <code className="break-all font-mono text-xs text-foreground">{value}</code> : <span className="text-xs text-muted-foreground">—</span>;
}

function stateText(state: unknown): string {
  if (!state || typeof state !== "object") return "—";
  return Object.entries(state)
    .map(([key, value]) => `${key}=${String(value)}`)
    .join(" ");
}

export default async function InvestigationPage({ params }: { params: Promise<{ id: string }> }) {
  await requirePageSession("OPS");
  const parsed = investigationIdParams.safeParse(await params);
  if (!parsed.success) notFound();
  const detail = await getInvestigationDetail(apiDeps().db, parsed.data.id);
  if (!detail) notFound();
  const { investigation: inv, record, trace, adjustment, notes, audit } = detail;
  const open = inv.status === "OPEN";
  // An adjustment fits only an amount mismatch on a posted transaction, and must close the gap as it
  // stands now: the posted entry plus adjustments already linked to it (the API checks the same).
  const postedCents = trace?.transaction.postedCents ?? null;
  const canAdjust = record.status === "AMOUNT_MISMATCH" && postedCents !== null && record.externalAmountCents !== null;
  const currentCents =
    postedCents === null
      ? null
      : Math.abs(postedCents + (trace?.related ?? []).filter((r) => r.type === "ADJUSTMENT").reduce((sum, r) => sum + (r.postedCents ?? 0), 0));
  const suggestedCents =
    canAdjust && currentCents !== null && record.externalAmountCents !== null
      ? suggestedAdjustmentCents(record.transactionType, record.externalAmountCents - currentCents)
      : null;

  return (
    <div className="space-y-5">
      <Link href="/ops/investigations" className="inline-flex min-h-6 items-center gap-1 text-sm font-medium text-primary underline-offset-4 hover:underline">
        <ChevronLeft aria-hidden className="size-4" />
        Investigations
      </Link>
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-xs font-medium text-muted-foreground">Investigation · {inv.businessName ?? "no business"}</p>
          <h1 className="mt-1 flex flex-wrap items-center gap-2 text-xl font-semibold tracking-tight">
            {TYPE_LABELS[record.transactionType]} <ReconciliationStatusBadge status={record.status} />
          </h1>
          <p className="mt-1 text-xs text-muted-foreground">
            Opened <LocalTime value={inv.createdAt} /> · <Id value={inv.id} />
          </p>
        </div>
        {open ? <Tag tone="amber">Open</Tag> : <Tag tone="emerald">Resolved</Tag>}
      </header>

      <div className="grid gap-5 lg:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)]">
        <div className="space-y-5">
          <Panel title="Discrepancy" aside={<Link href={`/ops/reconciliation/${record.runId}#record-${record.id}`} className="inline-flex min-h-6 items-center text-xs font-medium text-primary underline-offset-4 hover:underline">View in reconciliation run</Link>}>
            <dl className="grid grid-cols-[max-content_minmax(0,1fr)_minmax(0,1fr)] gap-x-6 gap-y-1.5 text-sm">
              <dt />
              <dd className="text-xs font-medium text-muted-foreground">Trace</dd>
              <dd className="text-xs font-medium text-muted-foreground">{providerLabel(record.provider)}</dd>
              <dt className="text-muted-foreground">Amount</dt>
              <dd>{record.internalAmountCents === null ? "—" : <Money cents={record.internalAmountCents} />}</dd>
              <dd>{record.externalAmountCents === null ? "—" : <Money cents={record.externalAmountCents} />}</dd>
              <dt className="text-muted-foreground">Status</dt>
              <dd className="font-mono text-xs">{record.internalStatus ?? "—"}</dd>
              <dd className="font-mono text-xs">{record.externalStatus ?? "—"}</dd>
              <dt className="text-muted-foreground">Id</dt>
              <dd><Id value={record.transactionId} /></dd>
              <dd><Id value={record.externalId} /></dd>
              <dt className="text-muted-foreground">Element</dt>
              <dd />
              <dd><Id value={record.externalRef} /></dd>
            </dl>
            {record.differenceCents ? (
              <p className="mt-3 border-t border-border pt-3 text-sm">
                Difference (provider − Trace): <Money cents={record.differenceCents} signed className="font-medium text-foreground" />
              </p>
            ) : null}
            {LIKELY_CAUSES[record.status].length > 0 && (
              <div className="mt-3 border-t border-border pt-3">
                <p className="text-xs font-medium text-muted-foreground">Likely causes</p>
                <ul className="mt-1 list-disc space-y-0.5 pl-5 text-sm text-foreground">
                  {LIKELY_CAUSES[record.status].map((cause) => (
                    <li key={cause}>{cause}</li>
                  ))}
                </ul>
              </div>
            )}
          </Panel>

          <Panel
            title="Money trace"
            aside={
              trace ? (
                trace.replay.consistent ? (
                  <Tag tone="emerald">Replay matches recorded balances</Tag>
                ) : (
                  <span className="rounded bg-danger-soft px-1.5 py-0.5 text-xs font-medium text-danger ring-1 ring-inset ring-danger-line/70">
                    Replay mismatch at step {trace.replay.divergence ? trace.replay.divergence.stepIndex + 1 : "?"}
                  </span>
                )
              ) : undefined
            }
          >
            {!trace ? (
              <p className="text-sm text-muted-foreground">There is no Trace transaction for this record.</p>
            ) : (
              <>
                <p className="mb-3 flex flex-wrap items-center gap-2 text-sm">
                  <StatusBadge status={trace.transaction.status} /> <Id value={trace.transaction.id} />
                </p>
                <ol className="space-y-2">
                  {trace.steps.map((step) => {
                    const { title, detail: more } = describeStep(step, trace.transaction.type);
                    const amount = stepAmount(step);
                    return (
                      <li key={step.id} className="rounded border border-border px-3 py-2 text-sm">
                        <div className="flex flex-wrap items-baseline justify-between gap-2">
                          <span>
                            <span className="font-mono text-xs text-muted-foreground">#{step.seq}</span> {title}
                          </span>
                          {amount && <Money cents={amount.cents} signed={amount.signed} />}
                        </div>
                        {more && <p className="text-xs text-muted-foreground">{more}</p>}
                        <p className="mt-1 text-xs text-muted-foreground">
                          Ledger after <Money cents={step.ledgerBalanceAfterCents} /> · available after <Money cents={step.availableAfterCents} />
                          {step.providerRef && (
                            <>
                              {" "}
                              · ref <code className="font-mono">{step.providerRef}</code>
                            </>
                          )}
                          {step.eventId && (
                            <>
                              {" "}
                              ·{" "}
                              <Link href={`/ops/events/${step.eventId}`} className="underline">
                                event
                              </Link>
                            </>
                          )}
                        </p>
                      </li>
                    );
                  })}
                </ol>
              </>
            )}
          </Panel>

          {trace && (
            <Panel title="Ledger entries and linked transactions">
              <ul className="divide-y divide-border text-sm">
                {trace.ledgerEntries.map((entry) => (
                  <li key={entry.id} className="flex items-baseline justify-between gap-3 py-1.5">
                    <span>{ENTRY_LABELS[entry.entryType]}</span>
                    <Money cents={entry.amountCents} signed />
                  </li>
                ))}
                {trace.related.map((r) => (
                  <li key={r.id} className="flex items-baseline justify-between gap-3 py-1.5">
                    <span>
                      {TYPE_LABELS[r.type]} <span className="text-xs text-muted-foreground">{r.relation === "original" ? "original" : "follow-up"}</span>
                      <span className="block font-mono text-xs text-muted-foreground">{r.id}</span>
                    </span>
                    {r.postedCents === null ? <Money cents={r.amountCents} /> : <Money cents={r.postedCents} signed />}
                  </li>
                ))}
              </ul>
            </Panel>
          )}
        </div>

        <div className="space-y-5">
          <Panel title={open ? "Resolve" : "Resolution"}>
            {open ? (
              <ResolveForm investigationId={inv.id} canAdjust={canAdjust && suggestedCents !== null} suggestedCents={suggestedCents} />
            ) : (
              <dl className="grid grid-cols-[max-content_minmax(0,1fr)] gap-x-3 gap-y-1 text-sm">
                <dt className="text-muted-foreground">Resolved</dt>
                <dd>{inv.resolvedAt ? <LocalTime value={inv.resolvedAt} /> : "—"}</dd>
                <dt className="text-muted-foreground">By</dt>
                <dd><Id value={inv.resolvedBy} /></dd>
                <dt className="text-muted-foreground">Adjustment</dt>
                <dd>
                  {adjustment ? (
                    <>
                      <Money cents={adjustment.amountCents} /> <Id value={adjustment.id} />
                    </>
                  ) : (
                    "none"
                  )}
                </dd>
              </dl>
            )}
          </Panel>

          <Panel title={`Notes (${notes.length})`}>
            {notes.length > 0 && (
              <ol className="mb-3 space-y-2">
                {notes.map((n) => (
                  <li key={n.id} className="rounded bg-muted/50 px-3 py-2 text-sm">
                    <p className="whitespace-pre-wrap break-words">{n.body}</p>
                    <p className="mt-1 text-xs text-muted-foreground">
                      <code className="font-mono">{n.authorId.slice(0, 8)}</code> · <LocalTime value={n.createdAt} />
                    </p>
                  </li>
                ))}
              </ol>
            )}
            <NoteForm investigationId={inv.id} />
          </Panel>

          <Panel title="Audit trail">
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
                    <span className="block break-words font-mono text-xs text-muted-foreground">
                      {stateText(a.previousState)} → {stateText(a.newState)}
                    </span>
                  </li>
                ))}
              </ol>
            )}
          </Panel>
        </div>
      </div>
    </div>
  );
}
