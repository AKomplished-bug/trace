"use client";

import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";

async function post(url: string, body: unknown): Promise<string | null> {
  try {
    const response = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    if (response.ok) return null;
    const json = (await response.json().catch(() => null)) as { error?: { message?: string } } | null;
    return json?.error?.message ?? "Something went wrong; try again";
  } catch {
    return "Couldn't reach Trace; try again.";
  }
}

const field = "w-full rounded border border-neutral-300 bg-white px-2 py-1.5 text-sm";

/** POST /api/ops/investigations/:id/notes. */
export function NoteForm({ investigationId }: { investigationId: string }) {
  const router = useRouter();
  const [body, setBody] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setSending(true);
    const problem = await post(`/api/ops/investigations/${investigationId}/notes`, { body });
    setError(problem);
    if (!problem) setBody("");
    setSending(false);
    router.refresh();
  }

  return (
    <form onSubmit={submit} className="space-y-2">
      <textarea value={body} onChange={(e) => setBody(e.target.value)} rows={2} maxLength={2000} aria-label="Note" placeholder="Add a note" className={field} />
      <button type="submit" disabled={sending || !body.trim()} className="rounded border border-neutral-300 bg-white px-3 py-1.5 text-sm font-medium hover:bg-neutral-50 disabled:opacity-50">
        {sending ? "Adding…" : "Add note"}
      </button>
      {error && <p className="rounded border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800">{error}</p>}
    </form>
  );
}

/**
 * POST /api/ops/investigations/:id/resolve. The adjustment is optional and signed (credit +,
 * debit −), prefilled with the amount that would bring the ledger to the provider's. A second
 * submit gets a 409 and posts nothing.
 */
export function ResolveForm({ investigationId, suggestedCents, canAdjust }: { investigationId: string; suggestedCents: number | null; canAdjust: boolean }) {
  const router = useRouter();
  const [note, setNote] = useState("");
  const [adjust, setAdjust] = useState(canAdjust && suggestedCents !== null);
  const [cents, setCents] = useState(suggestedCents === null ? "" : String(suggestedCents));
  const [error, setError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setSending(true);
    const problem = await post(`/api/ops/investigations/${investigationId}/resolve`, adjust ? { note, adjustmentCents: Number(cents) } : { note });
    setError(problem);
    setSending(false);
    router.refresh();
  }

  return (
    <form onSubmit={submit} className="space-y-3">
      <textarea value={note} onChange={(e) => setNote(e.target.value)} rows={3} maxLength={2000} aria-label="Resolution note" placeholder="What happened, and why this resolution" className={field} />
      {canAdjust && (
        <div className="space-y-1 text-sm">
          <label className="flex items-center gap-2">
            <input type="checkbox" checked={adjust} onChange={(e) => setAdjust(e.target.checked)} />
            Post an adjustment (a new transaction; history is not edited)
          </label>
          {adjust && (
            <label className="flex items-center gap-2">
              <span className="text-neutral-600">Cents</span>
              <input type="number" step={1} value={cents} onChange={(e) => setCents(e.target.value)} className={`${field} w-36 font-mono`} aria-label="Adjustment in cents" />
              <span className="text-xs text-neutral-500">credit +, debit −</span>
            </label>
          )}
        </div>
      )}
      <button type="submit" disabled={sending || !note.trim()} className="rounded bg-neutral-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-neutral-700 disabled:opacity-50">
        {sending ? "Resolving…" : "Resolve"}
      </button>
      {error && <p className="rounded border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800">{error}</p>}
    </form>
  );
}
