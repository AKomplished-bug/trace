import { ArrowRight, CreditCard } from "lucide-react";
import Link from "next/link";
import { Suspense } from "react";
import { Skeleton } from "@/components/ui/skeleton";
import { apiDeps } from "../api/deps";
import { getAccountSummary, getBalance } from "../../services/account-queries";
import { listTransactions } from "../../services/transaction-queries";
import { ActivityTable } from "../_components/activity-table";
import { FundAccountDialog } from "../_components/fund-account-dialog";
import { Money } from "../_components/money";
import { EmptyState, linkClass } from "../_components/page-parts";
import { SendPaymentDialog } from "../_components/send-payment-dialog";
import { Tag } from "../_components/status-badge";
import { requirePageSession } from "../_lib/auth";

export const metadata = { title: "Dashboard · Trace" };

const RECENT = 6;

/** Streams in after the balance: the balance never waits for the activity list. */
async function RecentActivity({ accountId }: { accountId: string }) {
  const recent = await listTransactions(apiDeps().db, accountId, { limit: RECENT });
  if (recent.items.length === 0) {
    return (
      <EmptyState title="Fund your account to get started" action={<FundAccountDialog />}>
        Once money arrives, every step of its story (holds, settlements and how each one changed your balance) shows up here.
      </EmptyState>
    );
  }
  return <ActivityTable items={recent.items} caption="Recent activity" />;
}

function ActivitySkeleton() {
  return (
    <div className="space-y-px overflow-hidden rounded-xl border bg-card" aria-busy="true" aria-label="Loading recent activity">
      {Array.from({ length: 4 }, (_, i) => (
        <div key={i} className="flex items-center gap-4 px-4 py-3.5">
          <Skeleton className="h-4 w-40" />
          <Skeleton className="ml-auto h-4 w-20" />
        </div>
      ))}
    </div>
  );
}

export default async function Dashboard() {
  const session = await requirePageSession("OWNER");
  const db = apiDeps().db;
  const [summary, balance] = await Promise.all([getAccountSummary(db, session.accountId), getBalance(db, session.accountId)]);
  if (!summary || !balance) throw new Error(`Account ${session.accountId} disappeared`);
  const card = summary.cards[0];
  const [ledgerLine, ...holdLines] = balance.explanation.lines;

  return (
    <div className="space-y-8">
      <h1 className="sr-only">Dashboard</h1>
      <section aria-labelledby="balance-heading" className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_18rem]">
        <div className="rounded-xl border bg-card p-5 sm:p-6">
          <h2 id="balance-heading" className="text-sm font-medium text-muted-foreground">
            Available balance
          </h2>
          <Money cents={balance.availableCents} className="mt-1 block text-4xl font-semibold tracking-tight sm:text-5xl" />
          <dl className="mt-6 grid grid-cols-3 gap-3 border-t pt-4 sm:gap-4">
            <div>
              <dt className="text-xs text-muted-foreground">{ledgerLine.label}</dt>
              <dd className="mt-0.5 text-sm font-medium sm:text-base">
                <Money cents={ledgerLine.amountCents} />
              </dd>
            </div>
            {holdLines.map((line) => (
              <div key={line.key}>
                <dt className="text-xs text-muted-foreground">{line.label}</dt>
                <dd className={`mt-0.5 text-sm font-medium sm:text-base ${line.amountCents > 0 ? "text-pending" : ""}`}>
                  {line.amountCents > 0 ? (
                    <>
                      <span aria-hidden>{line.operator} </span>
                      <span className="sr-only">minus </span>
                      <Money cents={line.amountCents} />
                    </>
                  ) : (
                    <Money cents={0} className="text-muted-foreground" />
                  )}
                </dd>
              </div>
            ))}
          </dl>
          <Link href="/balance" className={`mt-5 inline-flex min-h-6 items-center gap-1 text-sm ${linkClass}`}>
            How is this calculated?
            <ArrowRight aria-hidden className="size-4" />
          </Link>
        </div>

        <div className="grid content-start gap-4">
          <section aria-labelledby="actions-heading" className="rounded-xl border bg-card p-5">
            <h2 id="actions-heading" className="text-sm font-medium text-muted-foreground">
              Move money
            </h2>
            <div className="mt-3 grid gap-2">
              <FundAccountDialog />
              <SendPaymentDialog variant="outline" />
            </div>
          </section>
          <section aria-labelledby="card-heading" className="rounded-xl border bg-card p-5">
            <h2 id="card-heading" className="text-sm font-medium text-muted-foreground">
              Virtual card
            </h2>
            {card ? (
              <div className="mt-2 flex items-center justify-between gap-3">
                <span className="inline-flex items-center gap-2 text-base font-medium tabular-nums">
                  <CreditCard aria-hidden className="size-4 text-muted-foreground" />
                  <span className="sr-only">Card ending </span>
                  <span aria-hidden>••••</span> {card.last4}
                </span>
                <Tag tone={card.status === "ACTIVE" ? "emerald" : "neutral"}>{card.status === "ACTIVE" ? "Active" : card.status.toLowerCase()}</Tag>
              </div>
            ) : (
              <p className="mt-2 text-sm text-muted-foreground">No card issued yet.</p>
            )}
          </section>
        </div>
      </section>

      <section aria-labelledby="recent-heading" className="space-y-3">
        <div className="flex items-baseline justify-between">
          <h2 id="recent-heading" className="text-base font-semibold">
            Recent activity
          </h2>
          <Link href="/activity" className={`inline-flex min-h-6 items-center text-sm ${linkClass}`}>
            View all activity
          </Link>
        </div>
        <Suspense fallback={<ActivitySkeleton />}>
          <RecentActivity accountId={session.accountId} />
        </Suspense>
      </section>
    </div>
  );
}
