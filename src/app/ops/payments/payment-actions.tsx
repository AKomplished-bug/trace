"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

type Action = "requeue" | "confirm-not-sent";

/**
 * POST /api/ops/payments/:id/{requeue,confirm-not-sent}. A second click or a concurrent action
 * gets a 409 and changes nothing. `notYetConfirmable` greys out confirm-not-sent, with the reason.
 */
export function PaymentActions({ paymentId, notYetConfirmable }: { paymentId: string; notYetConfirmable: string | null }) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [sending, setSending] = useState<Action | null>(null);

  async function act(action: Action) {
    if (action === "confirm-not-sent" && !window.confirm("Fail this payment and release its hold? Trace checks with Increase first.")) return;
    setSending(action);
    setError(null);
    try {
      const response = await fetch(`/api/ops/payments/${paymentId}/${action}`, { method: "POST" });
      if (!response.ok) {
        const body = (await response.json().catch(() => null)) as { error?: { message?: string } } | null;
        setError(body?.error?.message ?? "Something went wrong; try again");
      }
      router.refresh();
    } catch {
      setError("Couldn't reach Trace. Trying again is safe: each action applies once.");
    } finally {
      setSending(null);
    }
  }

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap justify-end gap-2">
        <button
          type="button"
          onClick={() => act("requeue")}
          disabled={sending !== null}
          className="rounded bg-neutral-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-neutral-700 disabled:opacity-50"
        >
          {sending === "requeue" ? "Requeuing…" : "Requeue"}
        </button>
        <button
          type="button"
          onClick={() => act("confirm-not-sent")}
          disabled={sending !== null || notYetConfirmable !== null}
          title={notYetConfirmable ?? undefined}
          className="rounded border border-neutral-300 bg-white px-3 py-1.5 text-sm font-medium hover:bg-neutral-50 disabled:opacity-50"
        >
          {sending === "confirm-not-sent" ? "Checking Increase…" : "Confirm not sent"}
        </button>
      </div>
      {notYetConfirmable && <p className="text-right text-xs text-neutral-500">{notYetConfirmable}</p>}
      {error && <p className="rounded border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800">{error}</p>}
    </div>
  );
}
