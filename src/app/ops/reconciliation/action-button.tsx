"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

// Where `open` goes with the response's run or investigation id.
const OPEN_PATHS = { run: "/ops/reconciliation/", investigation: "/ops/investigations/" } as const;

/**
 * POSTs `body` (JSON) to `url`, then refreshes the page — or, with `open`, opens the run or
 * investigation the response returns. Shows the API's error message on failure; the actions it
 * drives are idempotent or answer 409, so clicking again is safe.
 */
export function ActionButton({
  url,
  body,
  label,
  pendingLabel,
  open,
  tone = "dark",
}: {
  url: string;
  body?: unknown;
  label: string;
  pendingLabel: string;
  open?: keyof typeof OPEN_PATHS;
  tone?: "dark" | "light";
}) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);

  async function send() {
    setSending(true);
    setError(null);
    try {
      const response = await fetch(url, {
        method: "POST",
        headers: body === undefined ? undefined : { "content-type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const json = (await response.json().catch(() => null)) as (Partial<Record<keyof typeof OPEN_PATHS, { id?: string }>> & { error?: { message?: string } }) | null;
      if (!response.ok) {
        setError(json?.error?.message ?? "Something went wrong; try again");
        router.refresh();
        return;
      }
      const id = open ? json?.[open]?.id : undefined;
      if (open && id) router.push(`${OPEN_PATHS[open]}${id}`);
      else router.refresh();
    } catch {
      setError("Couldn't reach Trace. Trying again is safe.");
    } finally {
      setSending(false);
    }
  }

  const style = tone === "dark" ? "bg-neutral-900 text-white hover:bg-neutral-700" : "border border-neutral-300 bg-white text-neutral-800 hover:bg-neutral-50";
  return (
    <span className="inline-flex flex-col gap-1">
      <button type="button" onClick={send} disabled={sending} className={`rounded px-3 py-1.5 text-sm font-medium disabled:opacity-50 ${style}`}>
        {sending ? pendingLabel : label}
      </button>
      {error && <span className="rounded border border-red-200 bg-red-50 px-2 py-1 text-xs text-red-800">{error}</span>}
    </span>
  );
}
