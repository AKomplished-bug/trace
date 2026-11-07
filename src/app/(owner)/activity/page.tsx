import Link from "next/link";
import { apiDeps } from "../../api/deps";
import { transactionStatus, transactionType } from "../../../db/schema";
import { listTransactions } from "../../../services/transaction-queries";
import { ActivityTable } from "../../_components/activity-table";
import { FilterBar, Pager, SelectFilter } from "../../_components/filters";
import { FundAccountDialog } from "../../_components/fund-account-dialog";
import { STATUS_LABELS, TYPE_LABELS } from "../../_components/labels";
import { EmptyState, linkClass, Notice, PageHeader } from "../../_components/page-parts";
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
    <div className="space-y-5">
      <PageHeader title="Activity" description="Every transaction on your account, newest first. Select one for a summary and its money trace." />

      <FilterBar action="/activity" label="Filter activity" filtered={filtered}>
        <SelectFilter
          name="type"
          label="Type"
          value={query.success ? (query.data.type ?? "") : ""}
          allLabel="All types"
          options={transactionType.enumValues.map((type) => ({ value: type, label: TYPE_LABELS[type] }))}
        />
        <SelectFilter
          name="status"
          label="Status"
          value={query.success ? (query.data.status ?? "") : ""}
          allLabel="All statuses"
          options={transactionStatus.enumValues.map((status) => ({ value: status, label: STATUS_LABELS[status] }))}
        />
      </FilterBar>

      {!page ? (
        <Notice>
          That filter or page link isn&apos;t valid.{" "}
          <Link href="/activity" className={linkClass}>
            Show all activity
          </Link>
        </Notice>
      ) : page.items.length === 0 ? (
        filtered ? (
          <EmptyState title="No transactions match these filters" action={<Link href="/activity" className={linkClass}>Clear filters</Link>} />
        ) : (
          <EmptyState title="Fund your account to get started" action={<FundAccountDialog />}>
            Your first deposit appears here, with its full money trace.
          </EmptyState>
        )
      ) : (
        <>
          <ActivityTable items={page.items} caption={filtered ? "Filtered transactions" : "All transactions"} />
          <Pager newest={input.cursor ? pageLink() : null} older={page.nextCursor ? pageLink(page.nextCursor) : null} />
        </>
      )}
    </div>
  );
}
