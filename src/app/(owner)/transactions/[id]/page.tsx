import { ChevronLeft } from "lucide-react";
import Link from "next/link";
import { notFound } from "next/navigation";
import type { ReactNode } from "react";
import { TabsContent } from "@/components/ui/tabs";
import { cn } from "@/lib/utils";
import { apiDeps } from "../../../api/deps";
import { getTransactionWithReplay } from "../../../../services/replay-queries";
import type { TimelineStep } from "../../../../services/transaction-queries";
import { HashTabs } from "../../../_components/hash-tabs";
import { counterparty, ENTRY_LABELS, providerLabel, TYPE_LABELS, type TransactionType } from "../../../_components/labels";
import { LocalTime } from "../../../_components/local-time";
import { Money } from "../../../_components/money";
import { MoneyGraph } from "../../../_components/money-graph";
import { OpenTargetDetails } from "../../../_components/open-target-details";
import { Fact, Facts, Id, linkClass, Panel } from "../../../_components/page-parts";
import { EFFECT_COPY, whyFinalBalance } from "../../../_components/replay-copy";
import { ReplayPlayer, type PlayerStep } from "../../../_components/replay-player";
import { StatusBadge, Tag, ToneBadge } from "../../../_components/status-badge";
import { describeStep, stepAmount } from "../../../_components/trace-copy";
import { TransactionAmount } from "../../../_components/transaction-amount";
import { requirePageSession } from "../../../_lib/auth";
import { transactionIdParams } from "../../../_lib/schemas";

export const metadata = { title: "Money trace · Trace" };

const TABS = [
  { value: "timeline", label: "Timeline" },
  { value: "replay", label: "Replay" },
  { value: "graph", label: "Money graph" },
  { value: "external", label: "External references" },
];

function TabPanel({ value, id, children }: { value: string; id?: string; children: ReactNode }) {
  return (
    <TabsContent value={value} id={id} forceMount data-tab={value} className="scroll-mt-20 data-[state=inactive]:hidden">
      {children}
    </TabsContent>
  );
}

function TechRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <>
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="min-w-0">{children}</dd>
    </>
  );
}

function TraceStep({ step, type, last }: { step: TimelineStep; type: TransactionType; last: boolean }) {
  const { title, detail } = describeStep(step, type);
  const amount = stepAmount(step);
  const posted = step.kind === "LEDGER_POSTED";
  return (
    <li id={`step-${step.id}`} className="relative scroll-mt-20 rounded-md pb-6 pl-8 last:pb-0 target:bg-accent/60">
      {!last && <span aria-hidden className="absolute top-5 left-[7px] h-full w-px bg-border" />}
      <span
        aria-hidden
        className={cn("absolute top-1 left-0 size-4 rounded-full border-2 bg-card", posted ? "border-success bg-success" : "border-muted-foreground/70")}
      />
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <div className="min-w-0">
          <p className="text-xs text-muted-foreground tabular-nums">
            Step {step.seq}, <LocalTime value={step.occurredAt} mode="time" />
            {posted && <span className="ml-1.5 font-medium text-success">Posted to ledger</span>}
          </p>
          <p className="mt-0.5 text-sm font-medium">{title}</p>
          {detail && <p className="mt-0.5 text-sm text-muted-foreground">{detail}</p>}
        </div>
        {amount && (
          <p className="text-sm font-medium whitespace-nowrap">
            <Money cents={amount.cents} signed={amount.signed} />
            {amount.note && <span className="ml-1 text-xs font-normal text-muted-foreground">{amount.note}</span>}
          </p>
        )}
      </div>
      <p className="mt-2 flex flex-wrap gap-x-4 gap-y-1 rounded-md bg-muted/60 px-2.5 py-1.5 text-xs text-muted-foreground">
        <span>
          Ledger after <Money cents={step.ledgerBalanceAfterCents} className="font-medium text-foreground" />
        </span>
        <span>
          Available after <Money cents={step.availableAfterCents} className="font-medium text-foreground" />
        </span>
      </p>
      <details className="mt-2 text-xs">
        <summary className="inline-flex min-h-6 cursor-pointer items-center text-muted-foreground select-none hover:text-foreground">Technical details</summary>
        <dl className="mt-1.5 grid grid-cols-[max-content_minmax(0,1fr)] gap-x-3 gap-y-1">
          <TechRow label="Provider ref">{step.providerRef ? <Id value={step.providerRef} /> : <span className="text-muted-foreground">None</span>}</TechRow>
          <TechRow label="External event">
            {step.externalEventId ? (
              <>
                <Id value={step.externalEventId} /> <span className="text-muted-foreground">({providerLabel(step.provider)})</span>
              </>
            ) : (
              <span className="text-muted-foreground">Recorded by Trace</span>
            )}
          </TechRow>
          {step.eventId && (
            <TechRow label="Trace event id">
              <Id value={step.eventId} />
            </TechRow>
          )}
          {step.ledgerEntryId && (
            <TechRow label="Ledger entry">
              <Id value={step.ledgerEntryId} />
            </TechRow>
          )}
          {(step.fromStatus || step.toStatus) && (
            <TechRow label="Status">
              <span className="font-mono">
                {step.fromStatus ?? "none"} → {step.toStatus ?? "none"}
              </span>
            </TechRow>
          )}
          <TechRow label="Sequence">
            <span className="font-mono">
              step {step.seq}, account #{step.accountSeq}
            </span>
          </TechRow>
          <TechRow label="Step id">
            <Id value={step.id} />
          </TechRow>
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
    <div className="space-y-6">
      <OpenTargetDetails />
      <Link href="/activity" className={`inline-flex items-center gap-1 text-sm ${linkClass}`}>
        <ChevronLeft aria-hidden className="size-4" />
        Activity
      </Link>

      <header className="rounded-xl border bg-card p-5 sm:p-6">
        <div className="flex flex-wrap items-start justify-between gap-x-6 gap-y-4">
          <div className="min-w-0">
            <p className="text-sm text-muted-foreground">{TYPE_LABELS[t.type]}</p>
            <h1 className="mt-0.5 text-xl font-semibold tracking-tight break-words">{counterparty(t)}</h1>
            <div className="mt-2 flex flex-wrap items-center gap-2">
              <StatusBadge status={t.status} />
              {steps.length === 0 ? null : replay.consistent ? (
                <a href="#replay" className="rounded-full">
                  <ToneBadge tone="success">Replay matches recorded balances</ToneBadge>
                </a>
              ) : (
                <a href="#replay" className="rounded-full">
                  <ToneBadge tone="danger">Replay mismatch at step {divergence ? divergence.stepIndex + 1 : "?"}</ToneBadge>
                </a>
              )}
            </div>
          </div>
          <div className="text-left sm:text-right">
            <TransactionAmount t={t} className="block text-3xl font-semibold tracking-tight sm:items-end" />
            {differs && cardHold && finalCents !== null && (
              <p className="mt-1 text-sm text-muted-foreground">
                Authorized <Money cents={cardHold.amountCents} />, settled <Money cents={finalCents} />
                <span className="block text-xs">
                  {finalCents < cardHold.amountCents ? "Settled for less than authorized; the difference was never taken." : "Settled for more than authorized."}
                </span>
              </p>
            )}
          </div>
        </div>
        <Facts className="mt-5 border-t pt-4 text-xs sm:grid-cols-[max-content_minmax(0,1fr)_max-content_minmax(0,1fr)]">
          <Fact label="Created">
            <LocalTime value={t.createdAt} />
          </Fact>
          <Fact label="Transaction id">
            <Id value={t.id} />
          </Fact>
          <Fact label="Provider">{providerLabel(external.provider)}</Fact>
          <Fact label="Provider id">
            <Id value={external.providerObjectId} />
          </Fact>
        </Facts>
      </header>

      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_20rem]">
        <div className="min-w-0">
          <HashTabs label="Money trace views" tabs={TABS} defaultValue="timeline">
            <TabPanel value="timeline">
              <Panel title="Money trace" description="Every step, in order, with the balances it left." aside={<span className="text-xs text-muted-foreground tabular-nums">{steps.length} steps</span>}>
                {steps.length === 0 ? (
                  <p className="text-sm text-muted-foreground">Nothing has happened to this transaction yet. Steps appear here as they occur.</p>
                ) : (
                  <>
                    <ol>
                      {steps.map((step, i) => (
                        <TraceStep key={step.id} step={step} type={t.type} last={i === steps.length - 1} />
                      ))}
                    </ol>
                    {lastStep && (
                      <p className="mt-5 border-t pt-4 text-sm">
                        Where this left your balance: ledger <Money cents={lastStep.ledgerBalanceAfterCents} className="font-medium" />, available{" "}
                        <Money cents={lastStep.availableAfterCents} className="font-medium" />.
                      </p>
                    )}
                  </>
                )}
              </Panel>
            </TabPanel>

            <TabPanel value="replay" id="replay">
              <Panel
                title="Replay"
                description="Re-derives the balances step by step from the trace and checks them against what was recorded."
                aside={
                  replay.consistent ? (
                    <ToneBadge tone="success">Matches</ToneBadge>
                  ) : (
                    <ToneBadge tone="danger">Mismatch at step {divergence ? divergence.stepIndex + 1 : "?"}</ToneBadge>
                  )
                }
              >
                {!replay.consistent && divergence && (
                  <p role="alert" className="mb-4 rounded-md border border-danger-line/70 bg-danger-soft px-3 py-2 text-sm text-danger">
                    {divergence.reason === "ledger_entry" ? (
                      <>The ledger change recorded at step {divergence.stepIndex + 1} doesn&apos;t match the ledger entry it posted.</>
                    ) : (
                      <>
                        Replaying this money trace doesn&apos;t reproduce the balances recorded at step {divergence.stepIndex + 1}: replay gives ledger{" "}
                        <Money cents={divergence.replayed.ledgerCents} /> and available <Money cents={divergence.replayed.availableCents} />, the record says{" "}
                        <Money cents={divergence.recorded.ledgerCents} /> and <Money cents={divergence.recorded.availableCents} />.
                      </>
                    )}
                  </p>
                )}
                {steps.length === 0 ? (
                  <p className="text-sm text-muted-foreground">Nothing to replay yet.</p>
                ) : (
                  <ReplayPlayer
                    initial={{ ledgerCents: replay.initial.ledgerCents, availableCents: replay.initial.availableCents }}
                    steps={playerSteps}
                    why={whyFinalBalance(replay)}
                  />
                )}
              </Panel>
            </TabPanel>

            <TabPanel value="graph">
              <Panel title="Money graph" description="What caused what. Each node links to the record behind it.">
                <MoneyGraph graph={replay.graph} type={t.type} />
              </Panel>
            </TabPanel>

            <TabPanel value="external">
              <Panel title="External references" description="The provider's record and every update it sent. Payloads are never shown.">
                <Facts className="text-xs">
                  <Fact label="Provider">{providerLabel(external.provider)}</Fact>
                  <Fact label="Provider id">
                    <Id value={external.providerObjectId} />
                  </Fact>
                </Facts>
                {external.events.length === 0 ? (
                  <p className="mt-4 border-t pt-4 text-sm text-muted-foreground">No provider updates recorded for this transaction.</p>
                ) : (
                  <ul className="mt-4 divide-y border-t text-sm">
                    {external.events.map((event) => (
                      <li key={event.id} id={`event-${event.id}`} className="scroll-mt-20 py-3 target:bg-accent/60">
                        <span>
                          Update from {providerLabel(event.provider)}, <LocalTime value={event.receivedAt} />
                        </span>
                        <Facts className="mt-1.5 text-xs">
                          <Fact label="Event id">
                            <Id value={event.externalEventId} />
                          </Fact>
                          <Fact label="Event type">
                            <code className="font-mono">{event.eventType}</code>
                          </Fact>
                        </Facts>
                      </li>
                    ))}
                  </ul>
                )}
              </Panel>
            </TabPanel>
          </HashTabs>
        </div>

        <div className="space-y-6">
          <Panel title="Balance impact">
            <dl className="grid grid-cols-[minmax(0,1fr)_max-content] gap-y-2 text-sm">
              <dt className="text-muted-foreground">Ledger change</dt>
              <dd className="text-right font-medium">
                <Money cents={netLedgerCents} signed />
              </dd>
              <dt className="text-muted-foreground">Still on hold</dt>
              <dd className={cn("text-right font-medium", heldNowCents > 0 && "text-pending")}>
                <Money cents={heldNowCents} />
              </dd>
              {cardHold && (
                <>
                  <dt className="text-muted-foreground">Card hold</dt>
                  <dd className="flex items-center justify-end gap-2 text-right">
                    <Money cents={cardHold.amountCents} />
                    <Tag tone={cardHold.status === "ACTIVE" ? "amber" : "neutral"}>{cardHold.status === "ACTIVE" ? "Active" : cardHold.status === "RELEASED" ? "Released" : "Expired"}</Tag>
                  </dd>
                </>
              )}
            </dl>
          </Panel>

          <Panel title="Ledger entries" flush>
            {ledgerEntries.length === 0 ? (
              <p className="p-4 text-sm text-muted-foreground">Nothing posted yet. Held amounts don&apos;t touch the ledger until they settle.</p>
            ) : (
              <ul className="divide-y text-sm">
                {ledgerEntries.map((entry) => (
                  <li key={entry.id} id={`ledger-${entry.id}`} className="scroll-mt-20 px-4 py-3 target:bg-accent/60">
                    <div className="flex items-baseline justify-between gap-3">
                      <span>{ENTRY_LABELS[entry.entryType]}</span>
                      <Money cents={entry.amountCents} signed className="font-medium" />
                    </div>
                    <p className="mt-0.5 text-xs text-muted-foreground">
                      <LocalTime value={entry.createdAt} />
                    </p>
                    <p className="mt-0.5">
                      <Id value={entry.id} />
                    </p>
                  </li>
                ))}
              </ul>
            )}
          </Panel>

          {related.length > 0 && (
            <Panel title="Linked transactions" flush>
              <ul className="divide-y text-sm">
                {related.map((r) => (
                  <li key={r.id} className="relative px-4 py-3 hover:bg-muted/60">
                    <div className="flex items-start justify-between gap-3">
                      <span>
                        <Link
                          href={`/transactions/${r.id}`}
                          className="font-medium outline-none after:absolute after:inset-0 after:content-[''] focus-visible:after:ring-2 focus-visible:after:ring-ring focus-visible:after:ring-inset"
                        >
                          {TYPE_LABELS[r.type]}
                        </Link>
                        <span className="block text-xs text-muted-foreground">
                          {r.relation === "follow_up" ? "Follows up on this transaction" : t.type === "ADJUSTMENT" ? "The transaction this adjusts" : "The original this one reverses"}
                        </span>
                      </span>
                      <TransactionAmount t={r} className="font-medium" />
                    </div>
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
