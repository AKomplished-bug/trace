import { ConfirmAction } from "../../_components/confirm-action";

/**
 * POST /api/ops/payments/:id/{requeue,confirm-not-sent}, each behind a confirmation. A second or
 * concurrent action gets a 409 and changes nothing. `notYetConfirmable` disables confirm-not-sent, with the reason.
 */
export function PaymentActions({ paymentId, notYetConfirmable, requeueOnly }: { paymentId: string; notYetConfirmable: string | null; requeueOnly?: boolean }) {
  return (
    <div className="flex flex-wrap items-start justify-end gap-2">
      <ConfirmAction
        url={`/api/ops/payments/${paymentId}/requeue`}
        label="Requeue"
        title="Requeue this payment?"
        description={
          <>
            <p>The submitter tries Increase again with a fresh retry budget and the same idempotency key, so it can&apos;t send the money twice.</p>
            <p>The hold stays in place until the payment completes or fails.</p>
          </>
        }
        confirmLabel="Requeue payment"
        pendingLabel="Requeuing…"
        success="Payment requeued"
        size="sm"
      />
      {!requeueOnly && (
        <ConfirmAction
          url={`/api/ops/payments/${paymentId}/confirm-not-sent`}
          label="Confirm not sent"
          title="Fail this payment and release its hold?"
          description={
            <>
              <p>Trace first asks Increase whether a transfer exists under this payment&apos;s key. Only if there is none does it fail the payment and give the money back to the available balance.</p>
              <p>This can&apos;t be undone.</p>
            </>
          }
          confirmLabel="Confirm not sent"
          pendingLabel="Checking Increase…"
          success="Payment failed and hold released"
          variant="destructive"
          size="sm"
          disabledReason={notYetConfirmable}
        />
      )}
    </div>
  );
}
