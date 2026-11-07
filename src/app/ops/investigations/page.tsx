import Link from "next/link";
import { investigationStatus } from "../../../db/schema";
import { listInvestigations } from "../../../services/investigations";
import { apiDeps } from "../../api/deps";
import { TYPE_LABELS } from "../../_components/labels";
import { LocalTime } from "../../_components/local-time";
import { Money } from "../../_components/money";
import { ReconciliationStatusBadge, Tag } from "../../_components/status-badge";
import { requirePageSession } from "../../_lib/auth";
import { investigationListQuery } from "../../_lib/schemas";

export const metadata = { title: "Investigations · Trace" };

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

export default async function InvestigationsPage({ searchParams }: { searchParams: SearchParams }) {
  await requirePageSession("OPS");
  const raw = await searchParams;
  const query = investigationListQuery.safeParse({ status: Array.isArray(raw.status) ? raw.status[0] : raw.status });
  const items = query.success ? await listInvestigations(apiDeps().db, query.data) : null;
  const filter = query.success ? query.data.status : undefined;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-lg font-semibold tracking-tight">Investigations</h1>
          <p className="text-sm text-neutral-600">Reconciliation exceptions Ops is working on, newest first. Open one from the reconciliation queue.</p>
        </div>
        <nav className="flex gap-2 text-sm">
          {[undefined, ...investigationStatus.enumValues].map((status) => (
            <Link
              key={status ?? "all"}
              href={status ? `/ops/investigations?status=${status}` : "/ops/investigations"}
              className={`rounded px-2 py-1 ${filter === status ? "bg-neutral-900 text-white" : "text-neutral-600 hover:bg-neutral-100"}`}
            >
              {status ?? "All"}
            </Link>
          ))}
        </nav>
      </div>

      {!items ? (
        <div className="rounded-md border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900">
          That filter isn&apos;t valid.{" "}
          <Link href="/ops/investigations" className="underline">
            Show all
          </Link>
        </div>
      ) : items.length === 0 ? (
        <div className="rounded-md border border-dashed border-neutral-300 bg-white px-5 py-10 text-center text-sm text-neutral-600">No investigations.</div>
      ) : (
        <div className="overflow-x-auto rounded-md border border-neutral-200 bg-white">
          <table className="w-full text-sm">
            <thead className="border-b border-neutral-200 bg-neutral-50 text-left text-xs text-neutral-500">
              <tr>
                <th className="px-4 py-2 font-medium">Opened</th>
                <th className="px-4 py-2 font-medium">Issue</th>
                <th className="px-4 py-2 font-medium">Business</th>
                <th className="px-4 py-2 font-medium">Transaction</th>
                <th className="px-4 py-2 text-right font-medium">Difference</th>
                <th className="px-4 py-2 font-medium">Status</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-neutral-100">
              {items.map((i) => (
                <tr key={i.id} className="relative align-top hover:bg-neutral-50">
                  <td className="whitespace-nowrap px-4 py-2.5 text-xs">
                    <Link href={`/ops/investigations/${i.id}`} className="after:absolute after:inset-0">
                      <LocalTime value={i.createdAt} />
                    </Link>
                  </td>
                  <td className="px-4 py-2.5">
                    <ReconciliationStatusBadge status={i.recordStatus} />
                  </td>
                  <td className="px-4 py-2.5">{i.businessName ?? "—"}</td>
                  <td className="px-4 py-2.5">
                    {TYPE_LABELS[i.transactionType]}
                    <span className="block font-mono text-xs text-neutral-500">{i.transactionId ? i.transactionId.slice(0, 8) : "not in Trace"}</span>
                  </td>
                  <td className="px-4 py-2.5 text-right">{i.differenceCents ? <Money cents={i.differenceCents} signed /> : "—"}</td>
                  <td className="px-4 py-2.5">{i.status === "OPEN" ? <Tag tone="amber">open</Tag> : <Tag tone="emerald">resolved</Tag>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
