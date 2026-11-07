import { DEFAULT_RECONCILIATION_DAYS } from "../../_lib/schemas";
import { providerLabel } from "../../_components/labels";
import { ConfirmAction } from "../../_components/confirm-action";

/** "Reconcile <provider>" (POST /api/ops/reconciliation/run); a repeat while one is active returns that run. */
export function RunReconciliation({ provider, variant = "outline", size }: { provider: string; variant?: "default" | "outline"; size?: "default" | "sm" }) {
  const name = providerLabel(provider);
  return (
    <ConfirmAction
      url="/api/ops/reconciliation/run"
      body={{ provider }}
      label={`Reconcile ${name}`}
      title={`Reconcile ${name}?`}
      description={
        <>
          <p>
            The worker fetches {name}&apos;s records for the last {DEFAULT_RECONCILIATION_DAYS} days and compares them with ours. Nothing in the ledger changes.
          </p>
          <p>If a run for {name} is already queued or running, you get that run instead of a new one.</p>
        </>
      }
      confirmLabel="Start run"
      pendingLabel="Requesting…"
      success={`${name} reconciliation requested`}
      open="run"
      variant={variant}
      size={size}
    />
  );
}

/** POST /api/ops/reconciliation/:id/retry, only from FAILED. */
export function RetryRun({ runId }: { runId: string }) {
  return (
    <ConfirmAction
      url={`/api/ops/reconciliation/${runId}/retry`}
      label="Retry run"
      title="Retry this reconciliation run?"
      description={<p>The worker runs it again with a fresh retry budget. The retry is recorded in the audit trail.</p>}
      confirmLabel="Retry run"
      pendingLabel="Retrying…"
      success="Reconciliation run queued again"
    />
  );
}
