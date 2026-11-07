"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

/** POST /api/ops/events/:id/retry. A second click or a concurrent retry gets a 409 and changes nothing. */
export function RetryButton({ eventId }: { eventId: string }) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);

  async function retry() {
    setSending(true);
    setError(null);
    try {
      const response = await fetch(`/api/ops/events/${eventId}/retry`, { method: "POST" });
      if (!response.ok) {
        const body = (await response.json().catch(() => null)) as { error?: { message?: string } } | null;
        setError(body?.error?.message ?? "Something went wrong; try again");
      }
      router.refresh();
    } catch {
      setError("Couldn't reach Trace. Retrying again is safe: an event is only requeued once.");
    } finally {
      setSending(false);
    }
  }

  return (
    <div className="space-y-2">
      <button
        type="button"
        onClick={retry}
        disabled={sending}
        className="rounded bg-neutral-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-neutral-700 disabled:opacity-50"
      >
        {sending ? "Retrying…" : "Retry processing"}
      </button>
      {error && <p className="rounded border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800">{error}</p>}
    </div>
  );
}
