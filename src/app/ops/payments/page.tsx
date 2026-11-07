import { CONFIRM_NOT_SENT_MIN_AGE_SECONDS, listGivenUpPayments } from "../../../services/ops-payments";
import { apiDeps } from "../../api/deps";
import { LocalTime } from "../../_components/local-time";
import { Money } from "../../_components/money";
import { requirePageSession } from "../../_lib/auth";
import { PaymentActions } from "./payment-actions";

export const metadata = { title: "Payments · Trace" };

const TOO_SOON = `Confirm not sent opens ${CONFIRM_NOT_SENT_MIN_AGE_SECONDS / 60} minutes after the give-up, once Increase has caught up; reload then.`;

export default async function OpsPaymentsPage() {
  await requirePageSession("OPS");
  const items = await listGivenUpPayments(apiDeps().db);

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-lg font-semibold tracking-tight">Given-up payments</h1>
        <p className="text-sm text-neutral-600">
          The submitter stopped retrying these with the outcome at Increase unknown; each still holds its amount. Requeue resends with the same
          idempotency key, so it can&apos;t send twice. Confirm not sent fails the payment and releases the hold, only if Increase has no transfer for it.
        </p>
      </div>

      {items.length === 0 ? (
        <div className="rounded-md border border-dashed border-neutral-300 bg-white px-5 py-10 text-center text-sm text-neutral-600">
          No given-up payments.
        </div>
      ) : (
        <div className="overflow-x-auto rounded-md border border-neutral-200 bg-white">
          <table className="w-full text-sm">
            <thead className="border-b border-neutral-200 bg-neutral-50 text-left text-xs text-neutral-500">
              <tr>
                <th className="px-4 py-2 font-medium">Gave up</th>
                <th className="px-4 py-2 font-medium">Payment</th>
                <th className="px-4 py-2 text-right font-medium">Amount</th>
                <th className="px-4 py-2 text-right font-medium">Attempts</th>
                <th className="px-4 py-2 text-right font-medium">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-neutral-100">
              {items.map((p) => (
                <tr key={p.id} className="align-top">
                  <td className="whitespace-nowrap px-4 py-2.5 text-xs text-neutral-500">
                    <LocalTime value={p.submitGaveUpAt!} />
                  </td>
                  <td className="max-w-sm px-4 py-2.5">
                    <span className="block font-medium">{p.recipient}</span>
                    <span className="block font-mono text-xs text-neutral-500" title={p.id}>
                      payment {p.id.slice(0, 8)} · transaction {p.transactionId.slice(0, 8)}
                    </span>
                    {p.lastSubmitError && <span className="block truncate text-xs text-red-700">{p.lastSubmitError}</span>}
                  </td>
                  <td className="px-4 py-2.5 text-right">
                    <Money cents={p.amountCents} />
                  </td>
                  <td className="px-4 py-2.5 text-right font-mono tabular-nums">{p.submitAttempts}</td>
                  <td className="px-4 py-2.5">
                    <PaymentActions paymentId={p.id} notYetConfirmable={p.confirmable ? null : TOO_SOON} />
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
