import Link from "next/link";
import { notFound } from "next/navigation";
import type { ReactNode } from "react";
import { apiDeps } from "../../../api/deps";
import { getTransactionWithReplay } from "../../../../services/replay-queries";
import type { TimelineStep } from "../../../../services/transaction-queries";
import { counterparty, ENTRY_LABELS, providerLabel, TYPE_LABELS, type TransactionType } from "../../../_components/labels";
import { LocalTime } from "../../../_components/local-time";
import { Money } from "../../../_components/money";
import { StatusBadge, Tag } from "../../../_components/status-badge";
import { MoneyGraph } from "../../../_components/money-graph";
import { OpenTargetDetails } from "../../../_components/open-target-details";
import { EFFECT_COPY, whyFinalBalance } from "../../../_components/replay-copy";
import { ReplayPlayer, type PlayerStep } from "../../../_components/replay-player";
import { describeStep, stepAmount } from "../../../_components/trace-copy";
import { TransactionAmount } from "../../../_components/transaction-amount";
import { requirePageSession } from "../../../_lib/auth";
import { transactionIdParams } from "../../../_lib/schemas";

export const metadata = { title: "Money trace · Trace" };

function Panel({ title, children, aside }: { title: string; children: ReactNode; aside?: ReactNode }) {
  return (
    <section className="rounded-md border border-neutral-200 bg-white">
      <div className="flex items-baseline justify-between border-b border-neutral-100 px-4 py-2.5">
        <h2 className="text-sm font-semibold">{title}</h2>
        {aside}
      </div>
      <div className="p-4">{children}</div>
    </section>
  );
}

function Id({ value }: { value: string }) {
  return <code className="break-all font-mono text-xs text-neutral-700">{value}</code>;
}

function TechRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <>
      <dt className="text-neutral-500">{label}</dt>
      <dd className="min-w-0">{children}</dd>
    </>
  );
}

function TraceStep({ step, type, last }: { step: TimelineStep; type: TransactionType; last: boolean }) {
  const { title, detail } = describeStep(step, type);
  const amount = stepAmount(step);
  const posted = step.kind === "LEDGER_POSTED";
  return (
    <li id={`step-${step.id}`} className="relative scroll-mt-4 rounded pb-5 pl-7 last:pb-0 target:bg-amber-50/60">
      {!last && <span aria-hidden className="absolute left-[7px] top-4 h-full w-px bg-neutral-200" />}
      <span
        aria-hidden
        className={`absolute left-0 top-1 h-[15px] w-[15px] rounded-full border-2 bg-white ${posted ? "border-emerald-600" : "border-amber-500"}`}
      />
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <div className="min-w-0">
          <p className="font-mono text-xs text-neutral-500">
            <LocalTime value={step.occurredAt} mode="time" /> · step {step.seq}
          </p>
          <p className="mt-0.5 text-sm font-medium">{title}</p>
          {detail && <p className="mt-0.5 text-xs text-neutral-600">{detail}</p>}
        </div>
        {amount && (
          <p className="whitespace-nowrap text-sm">
            <Money cents={amount.cents} signed={amount.signed} />
            {amount.note && <span className="ml-1 text-xs text-neutral-500">{amount.note}</span>}
          </p>
        )}
      </div>
      <p className="mt-2 flex flex-wrap gap-x-4 gap-y-1 rounded bg-neutral-50 px-2 py-1 text-xs text-neutral-600">
        <span>
          Ledger after <Money cents={step.ledgerBalanceAfterCents} className="text-neutral-900" />
        </span>
        <span>
          Available after <Money cents={step.availableAfterCents} className="text-neutral-900" />
        </span>
      </p>
      <details className="mt-1.5 text-xs">
        <summary className="cursor-pointer select-none text-neutral-500 hover:text-neutral-800">Technical details</summary>
        <dl className="mt-1.5 grid grid-cols-[max-content_minmax(0,1fr)] gap-x-3 gap-y-1">
          <TechRow label="Provider ref">{step.providerRef ? <Id value={step.providerRef} /> : <span className="text-neutral-400">—</span>}</TechRow>
          <TechRow label="External event">
            {step.externalEventId ? (
              <>
                <Id value={step.externalEventId} /> <span className="text-neutral-500">({providerLabel(step.provider)})</span>
              </>
            ) : (
              <span className="text-neutral-400">recorded by Trace</span>
            )}
          </TechRow>
          {step.eventId && <TechRow label="Trace event id"><Id value={step.eventId} /></TechRow>}
          {step.ledgerEntryId && <TechRow label="Ledger entry"><Id value={step.ledgerEntryId} /></TechRow>}
          {(step.fromStatus || step.toStatus) && (
            <TechRow label="Status">
              <span className="font-mono">{step.fromStatus ?? "—"} → {step.toStatus ?? "—"}</span>
            </TechRow>
          )}
          <TechRow label="Sequence">
            <span className="font-mono">step {step.seq} · account #{step.accountSeq}</span>
          </TechRow>
          <TechRow label="Step id"><Id value={step.id} /></TechRow>
        </dl>
      </details>
    </li>
  );
}

export default async function TransactionPage({ params }: { params: Promise<{ id: string }> }) {
  const session = await requirePageSession("OWNER");
  const parsed = transactionIdParams.safeParse(await params);
  if (!parsed.success) notFound();
  const db = apiDeps().db;
  const trace = await getTransactionWithReplay(db, session.accountId, parsed.data.id);
  if (!trace) notFound();
  const { detail, steps, replay } = trace;

  const { transaction: t, ledgerEntries, holds, related, external } = detail;
  const cardHold = holds.find((hold) => hold.kind === "CARD_AUTHORIZATION");
  const finalCents = t.postedCents === null ? null : Math.abs(t.postedCents);
  const differs = cardHold && finalCents !== null && finalCents !== cardHold.amountCents;
  const netLedgerCents = steps.reduce((sum, step) => sum + step.ledgerDeltaCents, 0);
  const heldNowCents = holds.filter((hold) => hold.status === "ACTIVE").reduce((sum, hold) => sum + hold.amountCents, 0);
  const lastStep = steps.at(-1);
  const playerSteps: PlayerStep[] = replay.steps.map((step) => ({
    id: step.event.id,
    seq: step.event.seq,
    ...describeStep(step.event, t.type),
    effect: EFFECT_COPY[step.explanation],
    before: { ledgerCents: step.before.ledgerCents, availableCents: step.before.availableCents },
    after: { ledgerCents: step.after.ledgerCents, availableCents: step.after.availableCents },
    otherActivity: step.otherActivity,
    matches: step.matches,
  }));
  const divergence = replay.divergence;

  return (
    <div className="space-y-5">
      <OpenTargetDetails />
      <Link href="/activity" className="text-sm text-neutral-600 hover:text-neutral-900">
        ← Activity
      </Link>

      <header className="rounded-md border border-neutral-200 bg-white p-5">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="min-w-0">
            <p className="text-xs font-medium uppercase tracking-wide text-neutral-500">{TYPE_LABELS[t.type]}</p>
            <h1 className="mt-1 flex flex-wrap items-center gap-2 text-lg font-semibold tracking-tight">
              {counterparty(t)} <StatusBadge status={t.status} />
            </h1>
            <p className="mt-1 text-xs text-neutral-500">
              <LocalTime value={t.createdAt} />
            </p>
          </div>
          <div className="text-right">
            <TransactionAmount t={t} className="block text-3xl font-semibold tracking-tight" />
            {differs && cardHold && finalCents !== null && (
              <p className="mt-1 text-xs text-neutral-600">
                Authorized <Money cents={cardHold.amountCents} /> · final <Money cents={finalCents} />
                <span className="block text-neutral-500">
                  {finalCents < cardHold.amountCents
                    ? "Settled for less than authorized; the difference was never taken."
                    : "Settled for more than authorized."}
                </span>
              </p>
            )}
          </div>
        </div>
        <dl className="mt-4 grid gap-x-6 gap-y-1 border-t border-neutral-100 pt-3 text-xs sm:grid-cols-[max-content_minmax(0,1fr)]">
          <dt className="text-neutral-500">Transaction</dt>
          <dd><Id value={t.id} /></dd>
          <dt className="text-neutral-500">External record</dt>
          <dd>
            {providerLabel(external.provider)}
            {external.providerObjectId && (
              <>
                {" · "}
                <Id value={external.providerObjectId} />
              </>
            )}
          </dd>
        </dl>
      </header>

      <div className="grid gap-5 lg:grid-cols-[minmax(0,1.7fr)_minmax(0,1fr)]">
        <div className="space-y-5">
          <Panel title="Money trace" aside={<span className="text-xs text-neutral-500">{steps.length} steps</span>}>
            {steps.length === 0 ? (
              <p className="text-sm text-neutral-600">Nothing has happened to this transaction yet. Steps appear here as they occur.</p>
            ) : (
              <>
                <ol>
                  {steps.map((step, i) => (
                    <TraceStep key={step.id} step={step} type={t.type} last={i === steps.length - 1} />
                  ))}
                </ol>
                {lastStep && (
                  <p className="mt-4 border-t border-neutral-100 pt-3 text-sm">
                    Where this left your balance: ledger <Money cents={lastStep.ledgerBalanceAfterCents} className="font-medium" />, available{" "}
                    <Money cents={lastStep.availableAfterCents} className="font-medium" />
                  </p>
                )}
              </>
            )}
          </Panel>

          <section id="replay" className="scroll-mt-4 space-y-5">
            <Panel
              title="Replay"
              aside={
                replay.consistent ? (
                  <Tag tone="emerald">Replay matches recorded balances</Tag>
                ) : (
                  <span className="inline-flex items-center rounded bg-red-50 px-1.5 py-0.5 text-xs font-medium text-red-800 ring-1 ring-inset ring-red-200">
                    Mismatch at step {divergence ? divergence.stepIndex + 1 : "?"}
                  </span>
                )
              }
            >
              {!replay.consistent && divergence && (
                <p role="alert" className="mb-3 rounded border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-800">
                  {divergence.reason === "ledger_entry" ? (
                    <>The ledger change recorded at step {divergence.stepIndex + 1} doesn&apos;t match the ledger entry it posted.</>
                  ) : (
                    <>
                      Replaying this money trace doesn&apos;t reproduce the balances recorded at step {divergence.stepIndex + 1}: replay gives ledger{" "}
                      <Money cents={divergence.replayed.ledgerCents} /> / available <Money cents={divergence.replayed.availableCents} />, the record says{" "}
                      <Money cents={divergence.recorded.ledgerCents} /> / <Money cents={divergence.recorded.availableCents} />.
                    </>
                  )}
                </p>
              )}
              {steps.length === 0 ? (
                <p className="text-sm text-neutral-600">Nothing to replay yet.</p>
              ) : (
                <ReplayPlayer
                  initial={{ ledgerCents: replay.initial.ledgerCents, availableCents: replay.initial.availableCents }}
                  steps={playerSteps}
                  why={whyFinalBalance(replay)}
                />
              )}
            </Panel>
            <Panel title="Money graph" aside={<span className="text-xs text-neutral-500">what caused what</span>}>
              <MoneyGraph graph={replay.graph} type={t.type} />
            </Panel>
          </section>
        </div>

        <div className="space-y-5">
          <Panel title="Balance impact">
            <dl className="grid grid-cols-[minmax(0,1fr)_max-content] gap-y-1.5 text-sm">
              <dt className="text-neutral-600">Ledger change</dt>
              <dd className="text-right"><Money cents={netLedgerCents} signed /></dd>
              <dt className="text-neutral-600">Still on hold</dt>
              <dd className="text-right"><Money cents={heldNowCents} /></dd>
              {cardHold && (
                <>
                  <dt className="text-neutral-600">Card hold</dt>
                  <dd className="text-right">
                    <Money cents={cardHold.amountCents} />{" "}
                    <Tag tone={cardHold.status === "ACTIVE" ? "amber" : "neutral"}>{cardHold.status.toLowerCase()}</Tag>
                  </dd>
                </>
              )}
            </dl>
          </Panel>

          <Panel title="Ledger entries">
            {ledgerEntries.length === 0 ? (
              <p className="text-sm text-neutral-600">Nothing posted yet — held amounts don&apos;t touch the ledger until they settle.</p>
            ) : (
              <ul className="divide-y divide-neutral-100 text-sm">
                {ledgerEntries.map((entry) => (
                  <li key={entry.id} id={`ledger-${entry.id}`} className="scroll-mt-4 py-2 first:pt-0 last:pb-0 target:bg-amber-50/60">
                    <div className="flex items-baseline justify-between gap-3">
                      <span>{ENTRY_LABELS[entry.entryType]}</span>
                      <Money cents={entry.amountCents} signed />
                    </div>
                    <p className="mt-0.5 text-xs text-neutral-500">
                      <LocalTime value={entry.createdAt} /> · <Id value={entry.id} />
                    </p>
                  </li>
                ))}
              </ul>
            )}
          </Panel>

          <Panel title="External record">
            <dl className="grid grid-cols-[max-content_minmax(0,1fr)] gap-x-3 gap-y-1 text-xs">
              <dt className="text-neutral-500">Provider</dt>
              <dd>{providerLabel(external.provider)}</dd>
              <dt className="text-neutral-500">Provider id</dt>
              <dd>{external.providerObjectId ? <Id value={external.providerObjectId} /> : "—"}</dd>
            </dl>
            {external.events.length > 0 && (
              <ul className="mt-3 divide-y divide-neutral-100 border-t border-neutral-100 text-xs">
                {external.events.map((event) => (
                  <li key={event.id} id={`event-${event.id}`} className="scroll-mt-4 py-2 target:bg-amber-50/60">
                    <span className="text-neutral-600">
                      Update from {providerLabel(event.provider)} · <LocalTime value={event.receivedAt} />
                    </span>
                    <details className="mt-1">
                      <summary className="cursor-pointer select-none text-neutral-500 hover:text-neutral-800">Technical details</summary>
                      <dl className="mt-1 grid grid-cols-[max-content_minmax(0,1fr)] gap-x-3 gap-y-1">
                        <TechRow label="Event id"><Id value={event.externalEventId} /></TechRow>
                        <TechRow label="Event type"><code className="font-mono">{event.eventType}</code></TechRow>
                      </dl>
                    </details>
                  </li>
                ))}
              </ul>
            )}
          </Panel>

          {related.length > 0 && (
            <Panel title="Linked transactions">
              <ul className="divide-y divide-neutral-100 text-sm">
                {related.map((r) => (
                  <li key={r.id} className="py-2 first:pt-0 last:pb-0">
                    <Link href={`/transactions/${r.id}`} className="flex items-baseline justify-between gap-3 hover:underline">
                      <span>
                        {TYPE_LABELS[r.type]}
                        <span className="block text-xs text-neutral-500">
                          {r.relation === "follow_up"
                            ? "Follows up on this transaction"
                            : t.type === "ADJUSTMENT"
                              ? "The transaction this adjusts"
                              : "The original this one reverses"}
                        </span>
                      </span>
                      <TransactionAmount t={r} />
                    </Link>
                  </li>
                ))}
              </ul>
            </Panel>
          )}
        </div>
      </div>
    </div>
  );
}
