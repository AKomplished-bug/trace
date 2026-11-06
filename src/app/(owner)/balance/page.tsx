import Link from "next/link";
import { apiDeps } from "../../api/deps";
import { getBalanceExplanation } from "../../../services/replay-queries";
import { BalanceExplanation } from "../../_components/balance-explanation";
import { counterparty, TYPE_LABELS } from "../../_components/labels";
import { LocalTime } from "../../_components/local-time";
import { Money } from "../../_components/money";
import { StatusBadge, Tag } from "../../_components/status-badge";
import { requirePageSession } from "../../_lib/auth";

export const metadata = { title: "Balance explanation · Trace" };

/** Spec §12: the available balance, term by term, the holds behind "pending", and a replay that re-derives it. */
export default async function BalancePage() {
  const session = await requirePageSession("OWNER");
  const view = await getBalanceExplanation(apiDeps().db, session.accountId);
  if (!view) throw new Error(`Account ${session.accountId} disappeared`);
  const { balance, activeHolds, replay } = view;

  return (
    <div className="space-y-5">
      <Link href="/" className="text-sm text-neutral-600 hover:text-neutral-900">
        ← Overview
      </Link>

      <section className="rounded-md border border-neutral-200 bg-white p-5">
        <p className="text-xs font-medium uppercase tracking-wide text-neutral-500">Balance explanation</p>
        <div className="mt-1 flex flex-wrap items-end justify-between gap-4">
          <div>
            <p className="text-sm text-neutral-600">Available to spend</p>
            <Money cents={balance.availableCents} className="block text-4xl font-semibold tracking-tight" />
          </div>
          {replay.matchesStored ? (
            <Tag tone="emerald">Replay matches recorded balances</Tag>
          ) : (
            <span className="inline-flex items-center rounded bg-red-50 px-1.5 py-0.5 text-xs font-medium text-red-800 ring-1 ring-inset ring-red-200">
              Replay mismatch
            </span>
          )}
        </div>
        <div className="mt-5 border-t border-neutral-100 pt-4">
          <BalanceExplanation balance={balance} />
        </div>
      </section>

      <div className="grid gap-5 lg:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)]">
        <section className="rounded-md border border-neutral-200 bg-white">
          <div className="flex items-baseline justify-between border-b border-neutral-100 px-4 py-2.5">
            <h2 className="text-sm font-semibold">What&apos;s pending</h2>
            <span className="text-xs text-neutral-500">{activeHolds.length} active {activeHolds.length === 1 ? "hold" : "holds"}</span>
          </div>
          {activeHolds.length === 0 ? (
            <p className="p-4 text-sm text-neutral-600">Nothing is on hold: your available balance equals your ledger balance.</p>
          ) : (
            <ul className="divide-y divide-neutral-100">
              {activeHolds.map((hold) => (
                <li key={hold.id}>
                  <Link href={`/transactions/${hold.transactionId}`} className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 px-4 py-2.5 hover:bg-neutral-50">
                    <span className="min-w-0">
                      <span className="flex flex-wrap items-center gap-2 text-sm font-medium">
                        {counterparty(hold)} <StatusBadge status={hold.status} />
                      </span>
                      <span className="block text-xs text-neutral-500">
                        {hold.kind === "PENDING_PAYMENT" ? "Pending payment" : "Pending card hold"} · {TYPE_LABELS[hold.type]} · held since{" "}
                        <LocalTime value={hold.createdAt} />
                        {hold.expiresAt && (
                          <>
                            {" "}
                            · expires <LocalTime value={hold.expiresAt} />
                          </>
                        )}
                      </span>
                    </span>
                    <span className="whitespace-nowrap text-sm">
                      <Money cents={hold.amountCents} className="text-amber-800" />
                      <span className="ml-1 text-xs text-amber-700">on hold</span>
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </section>

        <section className="rounded-md border border-neutral-200 bg-white">
          <div className="border-b border-neutral-100 px-4 py-2.5">
            <h2 className="text-sm font-semibold">Replay check</h2>
          </div>
          <div className="space-y-2 p-4 text-sm">
            <p className="text-neutral-700">
              Replaying all {replay.stepCount} steps of your money trace from $0 gives ledger <Money cents={replay.final.ledgerCents} /> and available{" "}
              <Money cents={replay.final.availableCents} />.
            </p>
            {replay.matchesStored ? (
              <p className="text-xs text-neutral-500">
                That is exactly your ledger balance, the sum of your ledger entries and your available balance, with the same holds active.
              </p>
            ) : (
              // Owners get a plain sentence; the step, ids and figures go to the replay_mismatch log line.
              <p role="alert" className="text-xs text-red-800">
                Replaying your money trace doesn&apos;t reproduce your current balance exactly. This has been logged for our team to look into.
              </p>
            )}
          </div>
        </section>
      </div>
    </div>
  );
}
