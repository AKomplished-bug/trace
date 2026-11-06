import Link from "next/link";
import { apiDeps } from "../../api/deps";
import { transactionStatus, transactionType } from "../../../db/schema";
import { listTransactions } from "../../../services/transaction-queries";
import { ActivityTable } from "../../_components/activity-table";
import { STATUS_LABELS, TYPE_LABELS } from "../../_components/labels";
import { requirePageSession } from "../../_lib/auth";
import { transactionListQuery } from "../../_lib/schemas";

export const metadata = { title: "Activity · Trace" };

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

function first(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

export default async function ActivityPage({ searchParams }: { searchParams: SearchParams }) {
  const session = await requirePageSession("OWNER");
  const raw = await searchParams;
  const input = { type: first(raw.type), status: first(raw.status), cursor: first(raw.cursor) };
  const query = transactionListQuery.safeParse(input);
  const page = query.success ? await listTransactions(apiDeps().db, session.accountId, query.data) : null;
  const filtered = Boolean(input.type || input.status);

  const pageLink = (cursor?: string) => {
    const params = new URLSearchParams();
    if (query.success && query.data.type) params.set("type", query.data.type);
    if (query.success && query.data.status) params.set("status", query.data.status);
    if (cursor) params.set("cursor", cursor);
    const qs = params.toString();
    return qs ? `/activity?${qs}` : "/activity";
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-lg font-semibold tracking-tight">Activity</h1>
          <p className="text-sm text-neutral-600">Every transaction on your account. Open one to see its money trace.</p>
        </div>
        <form method="get" action="/activity" className="flex flex-wrap items-center gap-2 text-sm">
          <select
            name="type"
            defaultValue={query.success ? (query.data.type ?? "") : ""}
            aria-label="Type"
            className="rounded border border-neutral-300 bg-white px-2 py-1"
          >
            <option value="">All types</option>
            {transactionType.enumValues.map((type) => (
              <option key={type} value={type}>
                {TYPE_LABELS[type]}
              </option>
            ))}
          </select>
          <select
            name="status"
            defaultValue={query.success ? (query.data.status ?? "") : ""}
            aria-label="Status"
            className="rounded border border-neutral-300 bg-white px-2 py-1"
          >
            <option value="">All statuses</option>
            {transactionStatus.enumValues.map((status) => (
              <option key={status} value={status}>
                {STATUS_LABELS[status]}
              </option>
            ))}
          </select>
          <button type="submit" className="rounded bg-neutral-900 px-3 py-1 font-medium text-white hover:bg-neutral-700">
            Apply
          </button>
          {filtered && (
            <Link href="/activity" className="px-1 text-neutral-600 hover:text-neutral-900">
              Clear
            </Link>
          )}
        </form>
      </div>

      {!page ? (
        <div className="rounded-md border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900">
          That filter or page link isn&apos;t valid.{" "}
          <Link href="/activity" className="underline">
            Show all activity
          </Link>
        </div>
      ) : page.items.length === 0 ? (
        <div className="rounded-md border border-dashed border-neutral-300 bg-white px-5 py-10 text-center">
          {filtered ? (
            <p className="text-sm text-neutral-600">No transactions match these filters.</p>
          ) : (
            <>
              <p className="font-medium">Fund your account to get started</p>
              <p className="mt-1 text-sm text-neutral-600">Your first deposit will appear here, with its full money trace.</p>
            </>
          )}
        </div>
      ) : (
        <>
          <ActivityTable items={page.items} />
          <div className="flex justify-between text-sm">
            {input.cursor ? (
              <Link href={pageLink()} className="text-neutral-600 hover:text-neutral-900">
                ← Newest
              </Link>
            ) : (
              <span />
            )}
            {page.nextCursor && (
              <Link href={pageLink(page.nextCursor)} className="text-neutral-600 hover:text-neutral-900">
                Older →
              </Link>
            )}
          </div>
        </>
      )}
    </div>
  );
}
