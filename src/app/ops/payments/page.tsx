import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { CONFIRM_NOT_SENT_MIN_AGE_SECONDS, listGivenUpPayments } from "../../../services/ops-payments";
import { apiDeps } from "../../api/deps";
import { LocalTime } from "../../_components/local-time";
import { Money } from "../../_components/money";
import { EmptyState, PageHeader } from "../../_components/page-parts";
import { requirePageSession } from "../../_lib/auth";
import { PaymentActions } from "./payment-actions";

export const metadata = { title: "Payments · Trace" };

const TOO_SOON = `Available ${CONFIRM_NOT_SENT_MIN_AGE_SECONDS / 60} minutes after the give-up, once Increase has caught up. Reload then.`;

export default async function OpsPaymentsPage() {
  await requirePageSession("OPS");
  const items = await listGivenUpPayments(apiDeps().db);

  return (
    <div className="space-y-5">
      <PageHeader
        title="Given-up payments"
        description={
          <>
            The submitter stopped retrying these with the outcome at Increase unknown; each still holds its amount. Requeue resends with the same idempotency
            key, so it can&apos;t send twice. Confirm not sent fails the payment and releases the hold, only if Increase has no transfer for it.
          </>
        }
      />

      {items.length === 0 ? (
        <EmptyState title="No given-up payments">Payments the submitter can&apos;t confirm with Increase land here for a decision.</EmptyState>
      ) : (
        <div className="overflow-hidden rounded-xl border bg-card">
          <Table>
            <caption className="sr-only">Given-up payments, oldest give-up first</caption>
            <TableHeader className="bg-muted/50">
              <TableRow className="hover:bg-transparent">
                <TableHead className="px-4 text-xs text-muted-foreground">Payment</TableHead>
                <TableHead className="hidden px-4 text-xs text-muted-foreground md:table-cell">Gave up</TableHead>
                <TableHead className="hidden px-4 text-right text-xs text-muted-foreground sm:table-cell">Attempts</TableHead>
                <TableHead className="px-4 text-right text-xs text-muted-foreground">Amount</TableHead>
                <TableHead className="px-4 text-right text-xs text-muted-foreground">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {items.map((p) => (
                <TableRow key={p.id} className="align-top">
                  <TableCell className="max-w-sm px-4 py-3 whitespace-normal">
                    <span className="block font-mono text-xs font-medium" title={p.id}>
                      Payment {p.id.slice(0, 8)}
                    </span>
                    <span className="block font-mono text-xs text-muted-foreground" title={p.transactionId}>
                      Transaction {p.transactionId.slice(0, 8)}
                    </span>
                    <span className="block text-xs text-muted-foreground md:hidden">
                      Gave up <LocalTime value={p.submitGaveUpAt!} />
                    </span>
                    {p.lastSubmitError && <span className="mt-1 block text-xs break-words text-danger">{p.lastSubmitError}</span>}
                  </TableCell>
                  <TableCell className="hidden px-4 py-3 text-xs text-muted-foreground md:table-cell">
                    <LocalTime value={p.submitGaveUpAt!} />
                  </TableCell>
                  <TableCell className="hidden px-4 py-3 text-right tabular-nums sm:table-cell">{p.submitAttempts}</TableCell>
                  <TableCell className="px-4 py-3 text-right font-medium">
                    <Money cents={p.amountCents} />
                  </TableCell>
                  <TableCell className="px-4 py-3 whitespace-normal">
                    <PaymentActions paymentId={p.id} notYetConfirmable={p.confirmable ? null : TOO_SOON} />
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
    </div>
  );
}
