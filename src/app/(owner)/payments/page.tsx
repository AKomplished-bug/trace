import { Check } from "lucide-react";
import Link from "next/link";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { cn } from "@/lib/utils";
import { apiDeps } from "../../api/deps";
import { listPayments, type PaymentSummary } from "../../../services/payment-queries";
import { amountView, isInFlight, maskedAccount } from "../../_components/labels";
import { LocalTime } from "../../_components/local-time";
import { EmptyState, PageHeader } from "../../_components/page-parts";
import { SendPaymentDialog } from "../../_components/send-payment-dialog";
import { StatusBadge, Tag } from "../../_components/status-badge";
import { TransactionAmount } from "../../_components/transaction-amount";
import { requirePageSession } from "../../_lib/auth";
import { PAGE_SIZE } from "../../_lib/schemas";

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
  const steps = lifecycle(payment);
  return (
    <ol className="flex flex-wrap items-center gap-x-1.5 gap-y-1 text-xs" aria-label="Lifecycle">
      {steps.map(({ step, done }, i) => (
        <li key={step} className={cn("flex items-center gap-1.5", done ? "text-foreground" : "text-muted-foreground")}>
          {i > 0 && <span aria-hidden className={cn("h-px w-3", done ? "bg-foreground/40" : "bg-border")} />}
          {done ? <Check aria-hidden className="size-3" /> : <span aria-hidden className="size-2 rounded-full border border-current" />}
          <span className={done ? "font-medium" : ""}>
            {STEP_LABELS[step]}
            {!done && <span className="sr-only"> (not yet)</span>}
          </span>
        </li>
      ))}
    </ol>
  );
}

export default async function PaymentsPage() {
  const session = await requirePageSession("OWNER");
  const page = await listPayments(apiDeps().db, session.accountId, { limit: PAGE_SIZE });

  return (
    <div className="space-y-5">
      <PageHeader
        title="Payments"
        description="ACH payments to other bank accounts. The amount is reserved from your available balance at once and leaves your ledger when the payment completes."
        actions={<SendPaymentDialog />}
      />

      {page.items.length === 0 ? (
        <EmptyState title="No payments yet" action={<SendPaymentDialog variant="outline" />}>
          Payments you send appear here with their status and each step of their lifecycle.
        </EmptyState>
      ) : (
        <div className="overflow-hidden rounded-xl border bg-card">
          <Table>
            <caption className="sr-only">Payments, newest first</caption>
            <TableHeader className="bg-muted/50">
              <TableRow className="hover:bg-transparent">
                <TableHead className="px-4 text-xs text-muted-foreground">Recipient</TableHead>
                <TableHead className="px-4 text-xs text-muted-foreground">Status</TableHead>
                <TableHead className="hidden px-4 text-xs text-muted-foreground lg:table-cell">External reference</TableHead>
                <TableHead className="px-4 text-right text-xs text-muted-foreground">Amount</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {page.items.map((p) => {
                const pending = isInFlight(amountView(p));
                return (
                  <TableRow
                    key={p.id}
                    className={cn("relative align-top", pending && "bg-pending-soft/45 shadow-[inset_3px_0_0_var(--pending-line)] hover:bg-pending-soft/70")}
                  >
                    <TableCell className="px-4 py-3 whitespace-normal">
                      <Link
                        href={`/transactions/${p.transactionId}`}
                        className="font-medium outline-none after:absolute after:inset-0 after:content-[''] focus-visible:after:rounded-sm focus-visible:after:ring-2 focus-visible:after:ring-ring focus-visible:after:ring-inset"
                      >
                        {p.recipientName}
                      </Link>
                      <span className="block text-xs text-muted-foreground">
                        <span className="tabular-nums">
                          <span className="sr-only">Account ending </span>
                          <span aria-hidden>{maskedAccount(p.accountNumberLast4)}</span>
                          <span className="sr-only">{p.accountNumberLast4}</span>
                        </span>
                        {p.description && `, ${p.description}`}
                      </span>
                      <span className="block text-xs text-muted-foreground">
                        <LocalTime value={p.createdAt} />
                      </span>
                    </TableCell>
                    <TableCell className="space-y-1.5 px-4 py-3 whitespace-normal">
                      <span className="flex flex-wrap items-center gap-1">
                        <StatusBadge status={p.status} />
                        {p.returnTransactionId && <Tag>Returned after completion</Tag>}
                      </span>
                      <Lifecycle payment={p} />
                    </TableCell>
                    <TableCell className="hidden px-4 py-3 lg:table-cell">
                      {p.providerObjectId ? (
                        <code className="font-mono text-xs text-foreground/80">{p.providerObjectId}</code>
                      ) : (
                        <span className="text-xs text-muted-foreground">Not sent yet</span>
                      )}
                    </TableCell>
                    <TableCell className="px-4 py-3 text-right font-medium">
                      <TransactionAmount t={p} />
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </div>
      )}
    </div>
  );
}
