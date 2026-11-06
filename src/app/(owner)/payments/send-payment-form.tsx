"use client";

import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";

/** "100", "100.5", "100.50" → cents, with string math only (never floats); null if it isn't an amount. */
function toCents(value: string): number | null {
  const match = /^(\d{1,7})(?:\.(\d{1,2}))?$/.exec(value.trim());
  if (!match) return null;
  return Number(match[1]) * 100 + Number((match[2] ?? "").padEnd(2, "0"));
}

const input = "mt-1 block w-full rounded border border-neutral-300 bg-white px-2 py-1.5 text-sm";

/**
 * POST /api/payments with an Idempotency-Key that stays the same until a payment is created, so
 * re-submitting after a timeout or a lost response can't send the money twice.
 */
export function SendPaymentForm() {
  const router = useRouter();
  const [idempotencyKey, setIdempotencyKey] = useState(() => crypto.randomUUID());
  const [error, setError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    const amountCents = toCents(String(data.get("amount") ?? ""));
    if (amountCents === null || amountCents === 0) {
      setError("Enter an amount in dollars, e.g. 100 or 100.50");
      return;
    }
    const description = String(data.get("description") ?? "").trim();
    setSending(true);
    setError(null);
    try {
      const response = await fetch("/api/payments", {
        method: "POST",
        headers: { "content-type": "application/json", "idempotency-key": idempotencyKey },
        body: JSON.stringify({
          recipientName: String(data.get("recipientName") ?? ""),
          accountNumber: String(data.get("accountNumber") ?? ""),
          routingNumber: String(data.get("routingNumber") ?? ""),
          amountCents,
          ...(description ? { description } : {}),
        }),
      });
      if (!response.ok) {
        const body = (await response.json().catch(() => null)) as { error?: { message?: string } } | null;
        setError(body?.error?.message ?? "Something went wrong; try again");
        return;
      }
      form.reset();
      setIdempotencyKey(crypto.randomUUID());
      router.refresh();
    } catch {
      setError("Couldn't reach Trace. Submitting again is safe: it can't send the payment twice.");
    } finally {
      setSending(false);
    }
  }

  return (
    <form onSubmit={submit} className="grid gap-3 sm:grid-cols-2">
      <label className="text-xs text-neutral-600 sm:col-span-2">
        Recipient
        <input name="recipientName" required maxLength={22} autoComplete="off" className={input} placeholder="Globex Supplies" />
      </label>
      <label className="text-xs text-neutral-600">
        Account number
        <input name="accountNumber" required inputMode="numeric" pattern="\d{4,17}" autoComplete="off" className={`${input} font-mono`} />
      </label>
      <label className="text-xs text-neutral-600">
        Routing number
        <input name="routingNumber" required inputMode="numeric" pattern="\d{9}" autoComplete="off" className={`${input} font-mono`} placeholder="101050001" />
      </label>
      <label className="text-xs text-neutral-600">
        Amount (USD)
        <input name="amount" required inputMode="decimal" className={`${input} font-mono`} placeholder="100.00" />
      </label>
      <label className="text-xs text-neutral-600">
        Description <span className="text-neutral-400">(optional)</span>
        <input name="description" maxLength={80} className={input} placeholder="Invoice 2468" />
      </label>
      {error && <p className="rounded border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800 sm:col-span-2">{error}</p>}
      <div className="sm:col-span-2">
        <button
          type="submit"
          disabled={sending}
          className="rounded bg-neutral-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-neutral-700 disabled:opacity-50"
        >
          {sending ? "Sending…" : "Send payment"}
        </button>
      </div>
    </form>
  );
}
