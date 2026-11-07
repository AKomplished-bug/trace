import { ConfirmAction } from "../../../_components/confirm-action";

/** POST /api/ops/events/:id/retry. A second or concurrent retry gets a 409 and changes nothing. */
export function RetryButton({ eventId, size }: { eventId: string; size?: "default" | "sm" }) {
  return (
    <ConfirmAction
      url={`/api/ops/events/${eventId}/retry`}
      label="Retry processing"
      title="Retry this event?"
      description={
        <>
          <p>It gets a fresh retry budget and the worker picks it up straight away.</p>
          <p>Processing is idempotent: steps already applied are not applied again. The retry is recorded in the audit trail.</p>
        </>
      }
      confirmLabel="Retry event"
      pendingLabel="Retrying…"
      success="Event queued for retry"
      size={size}
    />
  );
}
