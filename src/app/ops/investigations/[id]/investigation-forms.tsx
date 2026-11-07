"use client";

import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import { toast } from "sonner";
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Field, FieldDescription, FieldError, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { formatCents } from "../../../../lib/money";
import { postJson } from "../../../_lib/post-json";

/** POST /api/ops/investigations/:id/notes. */
export function NoteForm({ investigationId }: { investigationId: string }) {
  const router = useRouter();
  const [body, setBody] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setSending(true);
    const result = await postJson(`/api/ops/investigations/${investigationId}/notes`, { body });
    setSending(false);
    setError(result.ok ? null : result.message);
    if (result.ok) {
      setBody("");
      toast.success("Note added");
    }
    router.refresh();
  }

  return (
    <form onSubmit={submit} className="grid gap-2">
      <Field data-invalid={error ? true : undefined}>
        <FieldLabel htmlFor="note-body" className="sr-only">
          Note
        </FieldLabel>
        <Textarea id="note-body" value={body} onChange={(e) => setBody(e.target.value)} rows={2} maxLength={2000} placeholder="Add a note" aria-invalid={error ? true : undefined} />
        <FieldError>{error}</FieldError>
      </Field>
      <div>
        <Button type="submit" variant="outline" disabled={sending || !body.trim()} className="h-9">
          {sending ? "Adding…" : "Add note"}
        </Button>
      </div>
    </form>
  );
}

/**
 * POST /api/ops/investigations/:id/resolve, after a confirmation that says exactly what will be
 * posted. The adjustment is optional and signed (credit +, debit −), prefilled with the amount
 * that brings the ledger to the provider's. A second submit gets a 409 and posts nothing.
 */
export function ResolveForm({ investigationId, suggestedCents, canAdjust }: { investigationId: string; suggestedCents: number | null; canAdjust: boolean }) {
  const router = useRouter();
  const [note, setNote] = useState("");
  const [adjust, setAdjust] = useState(canAdjust && suggestedCents !== null);
  const [cents, setCents] = useState(suggestedCents === null ? "" : String(suggestedCents));
  const [error, setError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [sending, setSending] = useState(false);
  const adjustmentCents = Number(cents);
  const adjustmentValid = !adjust || (cents.trim() !== "" && Number.isSafeInteger(adjustmentCents) && adjustmentCents !== 0);

  function review(event: FormEvent) {
    event.preventDefault();
    if (!note.trim()) {
      setError("Write a resolution note: what happened, and why this resolution.");
      return;
    }
    if (!adjustmentValid) {
      setError("Enter the adjustment as a whole, non-zero number of cents, or untick the adjustment.");
      return;
    }
    setError(null);
    setConfirming(true);
  }

  async function resolve() {
    setSending(true);
    const result = await postJson(`/api/ops/investigations/${investigationId}/resolve`, adjust ? { note, adjustmentCents } : { note });
    setSending(false);
    if (!result.ok) {
      setError(result.message);
      setConfirming(false);
      router.refresh();
      return;
    }
    setConfirming(false);
    toast.success(adjust ? `Resolved with a ${formatCents(adjustmentCents, { signed: true })} adjustment` : "Investigation resolved");
    router.refresh();
  }

  return (
    <form onSubmit={review} className="grid gap-4">
      <Field data-invalid={error && !note.trim() ? true : undefined}>
        <FieldLabel htmlFor="resolution-note">Resolution note</FieldLabel>
        <Textarea id="resolution-note" value={note} onChange={(e) => setNote(e.target.value)} rows={3} maxLength={2000} placeholder="What happened, and why this resolution" />
      </Field>
      {canAdjust && (
        <div className="grid gap-3">
          <Field orientation="horizontal">
            <Checkbox id="post-adjustment" className="size-6 [&_svg]:size-4" checked={adjust} onCheckedChange={(value) => setAdjust(value === true)} />
            <FieldLabel htmlFor="post-adjustment" className="font-normal">
              Post an adjustment (a new transaction; history is not edited)
            </FieldLabel>
          </Field>
          {adjust && (
            <Field data-invalid={!adjustmentValid ? true : undefined}>
              <FieldLabel htmlFor="adjustment-cents">Adjustment in cents</FieldLabel>
              <Input
                id="adjustment-cents"
                type="number"
                step={1}
                value={cents}
                onChange={(e) => setCents(e.target.value)}
                className="h-9 w-40 font-mono"
                aria-describedby="adjustment-hint"
                aria-invalid={!adjustmentValid ? true : undefined}
              />
              <FieldDescription id="adjustment-hint">
                Credit +, debit −. {adjustmentValid && adjust && cents.trim() !== "" ? `That is ${formatCents(adjustmentCents, { signed: true })}.` : ""}
              </FieldDescription>
            </Field>
          )}
        </div>
      )}
      {error && <FieldError>{error}</FieldError>}
      <div>
        <Button type="submit" className="h-9">
          Resolve
        </Button>
      </div>

      <AlertDialog open={confirming} onOpenChange={setConfirming}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Resolve this investigation?</AlertDialogTitle>
            <AlertDialogDescription asChild>
              <div className="space-y-2">
                {adjust ? (
                  <p>
                    Trace posts a <strong className="font-semibold text-foreground">{formatCents(adjustmentCents, { signed: true })}</strong> adjustment to the
                    business&apos;s ledger, linked to this transaction, and marks the exception resolved.
                  </p>
                ) : (
                  <p>The exception is marked resolved with your note. No money moves.</p>
                )}
                <p>Both are recorded in the audit trail and can&apos;t be undone.</p>
              </div>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel className="h-9">Cancel</AlertDialogCancel>
            <Button onClick={resolve} disabled={sending} className="h-9">
              {sending ? "Resolving…" : adjust ? "Post adjustment and resolve" : "Resolve"}
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </form>
  );
}
