import { ShieldCheck, TriangleAlert } from "lucide-react";
import Link from "next/link";
import { apiDeps } from "../../api/deps";
import { getBalanceExplanation } from "../../../services/replay-queries";
import { BalanceExplanation } from "../../_components/balance-explanation";
import { counterparty, TYPE_LABELS } from "../../_components/labels";
import { LocalTime } from "../../_components/local-time";
import { Money } from "../../_components/money";
import { PageHeader, Panel } from "../../_components/page-parts";
import { StatusBadge, ToneBadge } from "../../_components/status-badge";
import { requirePageSession } from "../../_lib/auth";

export const metadata = { title: "Balance · Trace" };

/** Spec §12: the available balance, term by term, the holds behind "pending", and a replay that re-derives it. */
export default async function BalancePage() {
  const session = await requirePageSession("OWNER");
  const view = await getBalanceExplanation(apiDeps().db, session.accountId);
  if (!view) throw new Error(`Account ${session.accountId} disappeared`);
  const { balance, activeHolds, replay } = view;

  return (
    <div className="space-y-6">
      <PageHeader title="Balance" description="How your available balance is calculated, and the holds that reduce it right now." />

      <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_20rem]">
        <section aria-labelledby="breakdown-heading" className="rounded-xl border bg-card p-5 sm:p-6">
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div>
              <h2 id="breakdown-heading" className="text-sm font-medium text-muted-foreground">
                Available balance
              </h2>
              <Money cents={balance.availableCents} className="mt-1 block text-4xl font-semibold tracking-tight" />
            </div>
            {replay.matchesStored ? (
              <ToneBadge tone="success">Replay matches</ToneBadge>
            ) : (
              <ToneBadge tone="danger">Replay mismatch</ToneBadge>
            )}
          </div>
          <div className="mt-6">
            <BalanceExplanation balance={balance} />
          </div>
        </section>

        <Panel title="Replay check" aside={replay.matchesStored ? <ShieldCheck aria-hidden className="size-4 text-success" /> : <TriangleAlert aria-hidden className="size-4 text-danger" />}>
          <div className="space-y-2 text-sm">
            <p>
              Replaying all {replay.stepCount} steps of your money trace from $0 gives a ledger balance of <Money cents={replay.final.ledgerCents} className="font-medium" /> and
              an available balance of <Money cents={replay.final.availableCents} className="font-medium" />.
            </p>
            {replay.matchesStored ? (
              <p className="text-muted-foreground">
                That is exactly your ledger balance, the sum of your ledger entries and your available balance, with the same holds active.
              </p>
            ) : (
              // Owners get a plain sentence; the step, ids and figures go to the replay_mismatch log line.
              <p role="alert" className="text-danger">
                Replaying your money trace doesn&apos;t reproduce your current balance exactly. This has been logged for our team to look into.
              </p>
            )}
          </div>
        </Panel>
      </div>

      <Panel
        title="Active holds"
        description="Card authorizations and pending payments. Each one reduces your available balance until it settles, is released or expires."
        aside={<span className="text-xs text-muted-foreground tabular-nums">{activeHolds.length} active</span>}
        flush
      >
        {activeHolds.length === 0 ? (
          <p className="p-4 text-sm text-muted-foreground">Nothing is on hold, so your available balance equals your ledger balance.</p>
        ) : (
          <ul className="divide-y">
            {activeHolds.map((hold) => (
              <li key={hold.id} className="relative bg-pending-soft/30 shadow-[inset_3px_0_0_var(--pending-line)] hover:bg-pending-soft/60">
                <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 px-4 py-3">
                  <div className="min-w-0">
                    <p className="flex flex-wrap items-center gap-2 text-sm">
                      <Link
                        href={`/transactions/${hold.transactionId}`}
                        className="font-medium outline-none after:absolute after:inset-0 after:content-[''] focus-visible:after:ring-2 focus-visible:after:ring-ring focus-visible:after:ring-inset"
                      >
                        {counterparty(hold)}
                      </Link>
                      <StatusBadge status={hold.status} />
                    </p>
                    <p className="text-xs text-muted-foreground">
                      {hold.kind === "PENDING_PAYMENT" ? "Pending payment" : "Card hold"}, {TYPE_LABELS[hold.type].toLowerCase()}. Held since <LocalTime value={hold.createdAt} />
                      {hold.expiresAt && (
                        <>
                          , expires <LocalTime value={hold.expiresAt} />
                        </>
                      )}
                    </p>
                  </div>
                  <span className="text-right text-sm font-medium whitespace-nowrap text-pending">
                    <Money cents={hold.amountCents} />
                    <span className="block text-xs font-normal">On hold</span>
                  </span>
                </div>
              </li>
            ))}
          </ul>
        )}
      </Panel>
    </div>
  );
}
