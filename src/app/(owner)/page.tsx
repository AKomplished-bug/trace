import Link from "next/link";
import { apiDeps } from "../api/deps";
import { getAccountSummary, getBalance } from "../../services/account-queries";
import { listTransactions } from "../../services/transaction-queries";
import { ActivityTable } from "../_components/activity-table";
import { BalanceExplanation } from "../_components/balance-explanation";
import { counterparty, TYPE_LABELS } from "../_components/labels";
import { Money } from "../_components/money";
import { StatusBadge, Tag } from "../_components/status-badge";
import { requirePageSession } from "../_lib/auth";

export const metadata = { title: "Overview · Trace" };

const RECENT = 6;

export default async function Dashboard() {
  const session = await requirePageSession("OWNER");
  const db = apiDeps().db;
  const [summary, balance, recent] = await Promise.all([
    getAccountSummary(db, session.accountId),
    getBalance(db, session.accountId),
    listTransactions(db, session.accountId, { limit: RECENT }),
  ]);
  if (!summary || !balance) throw new Error(`Account ${session.accountId} disappeared`);
  const card = summary.cards[0];
  const latest = recent.items[0];
  const [, ...holdLines] = balance.explanation.lines;

  return (
    <div className="space-y-6">
      <section className="grid gap-4 lg:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)]">
        <div className="rounded-md border border-neutral-200 bg-white p-5">
          <div className="flex flex-wrap items-end gap-x-10 gap-y-4">
            <div>
              <p className="text-xs font-medium uppercase tracking-wide text-neutral-500">Available to spend</p>
              <Money cents={balance.availableCents} className="mt-1 block text-4xl font-semibold tracking-tight" />
            </div>
            <dl className="flex flex-wrap gap-x-8 gap-y-2 text-sm">
              <div>
                <dt className="text-xs text-neutral-500">{balance.explanation.lines[0].label}</dt>
                <dd>
                  <Money cents={balance.ledgerBalanceCents} />
                </dd>
              </div>
              {holdLines.map((line) => (
                <div key={line.key}>
                  <dt className="text-xs text-neutral-500">{line.label}</dt>
                  <dd className={line.amountCents > 0 ? "text-amber-700" : "text-neutral-500"}>
                    <Money cents={line.amountCents} />
                  </dd>
                </div>
              ))}
            </dl>
          </div>
          <BalanceExplanation balance={balance} />
        </div>

        <div className="grid gap-4">
          <div className="rounded-md border border-neutral-200 bg-white p-5">
            <p className="text-xs font-medium uppercase tracking-wide text-neutral-500">Virtual card</p>
            {card ? (
              <div className="mt-2 flex items-center justify-between">
                <span className="font-mono text-lg tracking-widest">•••• {card.last4}</span>
                <Tag tone={card.status === "ACTIVE" ? "emerald" : "neutral"}>{card.status.toLowerCase()}</Tag>
              </div>
            ) : (
              <p className="mt-2 text-sm text-neutral-600">No card issued yet.</p>
            )}
          </div>

          <div className="rounded-md border border-neutral-200 bg-white p-5">
            <p className="text-xs font-medium uppercase tracking-wide text-neutral-500">Latest transaction</p>
            {latest ? (
              <>
                <div className="mt-2 flex items-center justify-between gap-3">
                  <span className="min-w-0">
                    <span className="block truncate text-sm font-medium">{TYPE_LABELS[latest.type]}</span>
                    <span className="block truncate text-xs text-neutral-500">{counterparty(latest)}</span>
                  </span>
                  <StatusBadge status={latest.status} />
                </div>
                <Link
                  href={`/transactions/${latest.id}`}
                  className="mt-4 inline-flex items-center gap-1 rounded bg-neutral-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-neutral-700"
                >
                  View money trace <span aria-hidden>→</span>
                </Link>
              </>
            ) : (
              <p className="mt-2 text-sm text-neutral-600">Nothing yet.</p>
            )}
          </div>
        </div>
      </section>

      <section>
        <div className="mb-2 flex items-baseline justify-between">
          <h2 className="text-sm font-semibold">Recent activity</h2>
          {latest && (
            <Link href="/activity" className="text-sm text-neutral-600 hover:text-neutral-900">
              All activity →
            </Link>
          )}
        </div>
        {recent.items.length > 0 ? (
          <ActivityTable items={recent.items} />
        ) : (
          <div className="rounded-md border border-dashed border-neutral-300 bg-white px-5 py-10 text-center">
            <p className="font-medium">Fund your account to get started</p>
            <p className="mx-auto mt-1 max-w-md text-sm text-neutral-600">
              Once money arrives, every step of its story — holds, settlements and how each one changed your balance —
              shows up here as a money trace.
            </p>
          </div>
        )}
      </section>
    </div>
  );
}
