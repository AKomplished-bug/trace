import Link from "next/link";
import { apiDeps } from "../../api/deps";
import { listPayments, type PaymentSummary } from "../../../services/payment-queries";
import { LocalTime } from "../../_components/local-time";
import { StatusBadge, Tag } from "../../_components/status-badge";
import { TransactionAmount } from "../../_components/transaction-amount";
import { requirePageSession } from "../../_lib/auth";
import { PAGE_SIZE } from "../../_lib/schemas";
import { SendPaymentForm } from "./send-payment-form";

export const metadata = { title: "Payments · Trace" };

const STEP_LABELS: Record<PaymentSummary["status"], string> = {
  PENDING: "Pending",
  SUBMITTED: "Submitted",
  COMPLETED: "Completed",
  RETURNED: "Returned",
  FAILED: "Failed",
};

/** Pending → Submitted → Completed, or the step where it ended (Returned after submission; Failed before or after it). */
function lifecycle(p: Pick<PaymentSummary, "status" | "providerObjectId">): Array<{ step: PaymentSummary["status"]; done: boolean }> {
  if (p.status === "RETURNED") return ["PENDING", "SUBMITTED", "RETURNED"].map((step) => ({ step: step as PaymentSummary["status"], done: true }));
  if (p.status === "FAILED") {
    const steps: PaymentSummary["status"][] = p.providerObjectId ? ["PENDING", "SUBMITTED", "FAILED"] : ["PENDING", "FAILED"];
    return steps.map((step) => ({ step, done: true }));
  }
  const reached = ["PENDING", "SUBMITTED", "COMPLETED"].indexOf(p.status);
  return (["PENDING", "SUBMITTED", "COMPLETED"] as const).map((step, i) => ({ step, done: i <= reached }));
}

function Lifecycle({ payment }: { payment: Pick<PaymentSummary, "status" | "providerObjectId"> }) {
  return (
    <ol className="flex flex-wrap items-center gap-1 text-[11px]">
      {lifecycle(payment).map(({ step, done }, i) => {
        const tone = step === "FAILED" ? "text-red-700" : step === "RETURNED" ? "text-neutral-700" : done ? "text-emerald-700" : "text-neutral-400";
        return (
          <li key={step} className={`flex items-center gap-1 ${tone}`}>
            {i > 0 && <span aria-hidden className="text-neutral-300">→</span>}
            <span className={done ? "font-medium" : ""}>{STEP_LABELS[step]}</span>
          </li>
        );
      })}
    </ol>
  );
}

export default async function PaymentsPage() {
  const session = await requirePageSession("OWNER");
  const page = await listPayments(apiDeps().db, session.accountId, { limit: PAGE_SIZE });

  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-lg font-semibold tracking-tight">Payments</h1>
        <p className="text-sm text-neutral-600">
          Send money to another bank account by ACH. The amount is reserved from your available balance at once and leaves your ledger
          when the payment completes.
        </p>
      </div>

      <section className="rounded-md border border-neutral-200 bg-white p-5">
        <h2 className="mb-3 text-sm font-semibold">Send payment</h2>
        <SendPaymentForm />
      </section>

      {page.items.length === 0 ? (
        <div className="rounded-md border border-dashed border-neutral-300 bg-white px-5 py-10 text-center text-sm text-neutral-600">
          No payments yet. Payments you send appear here with their status and lifecycle.
        </div>
      ) : (
        <div className="overflow-hidden rounded-md border border-neutral-200 bg-white">
          <table className="w-full text-sm">
            <thead className="border-b border-neutral-200 bg-neutral-50 text-left text-xs text-neutral-500">
              <tr>
                <th className="px-4 py-2 font-medium">Recipient</th>
                <th className="px-4 py-2 font-medium">Status</th>
                <th className="hidden px-4 py-2 font-medium md:table-cell">External reference</th>
                <th className="px-4 py-2 text-right font-medium">Amount</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-neutral-100">
              {page.items.map((p) => (
                <tr key={p.id} className="group relative align-top hover:bg-neutral-50">
                  <td className="px-4 py-2.5">
                    <Link href={`/transactions/${p.transactionId}`} className="font-medium after:absolute after:inset-0">
                      {p.recipientName}
                    </Link>
                    <span className="block text-xs text-neutral-500">
                      <span className="font-mono">•••• {p.accountNumberLast4}</span>
                      {p.description && ` · ${p.description}`}
                      {" · "}
                      <LocalTime value={p.createdAt} />
                    </span>
                  </td>
                  <td className="space-y-1 px-4 py-2.5">
                    <span className="flex flex-wrap items-center gap-1">
                      <StatusBadge status={p.status} />
                      {p.returnTransactionId && <Tag>returned after completion</Tag>}
                    </span>
                    <Lifecycle payment={p} />
                  </td>
                  <td className="hidden px-4 py-2.5 md:table-cell">
                    {p.providerObjectId ? (
                      <code className="break-all font-mono text-xs text-neutral-700">{p.providerObjectId}</code>
                    ) : (
                      <span className="text-xs text-neutral-400">not sent yet</span>
                    )}
                  </td>
                  <td className="whitespace-nowrap px-4 py-2.5 text-right">
                    <TransactionAmount t={p} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
