import Link from "next/link";
import type { TransactionSummary } from "../../services/transaction-queries";
import { counterparty, TYPE_LABELS } from "./labels";
import { LocalTime } from "./local-time";
import { StatusBadge } from "./status-badge";
import { TransactionAmount } from "./transaction-amount";

/** Transactions as dense rows; each opens its money trace. */
export function ActivityTable({ items }: { items: TransactionSummary[] }) {
  return (
    <div className="overflow-hidden rounded-md border border-neutral-200 bg-white">
      <table className="w-full text-sm">
        <thead className="border-b border-neutral-200 bg-neutral-50 text-left text-xs text-neutral-500">
          <tr>
            <th className="hidden px-4 py-2 font-medium sm:table-cell">Date</th>
            <th className="px-4 py-2 font-medium">Description</th>
            <th className="px-4 py-2 font-medium">Status</th>
            <th className="px-4 py-2 text-right font-medium">Amount</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-neutral-100">
          {items.map((t) => (
            <tr key={t.id} className="group relative hover:bg-neutral-50">
              <td className="hidden whitespace-nowrap px-4 py-2.5 text-xs text-neutral-500 sm:table-cell">
                <LocalTime value={t.createdAt} />
              </td>
              <td className="px-4 py-2.5">
                <Link href={`/transactions/${t.id}`} className="after:absolute after:inset-0">
                  <span className="font-medium">{TYPE_LABELS[t.type]}</span>
                </Link>
                <span className="block text-xs text-neutral-500">
                  {counterparty(t)}
                  <span className="sm:hidden">
                    {" · "}
                    <LocalTime value={t.createdAt} />
                  </span>
                </span>
              </td>
              <td className="px-4 py-2.5">
                <StatusBadge status={t.status} />
              </td>
              <td className="whitespace-nowrap px-4 py-2.5 text-right">
                <TransactionAmount t={t} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
