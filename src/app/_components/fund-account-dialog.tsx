"use client";

import { Plus } from "lucide-react";
import { useRouter } from "next/navigation";
import { useRef, useState, type FormEvent } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Field, FieldDescription, FieldError, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { formatCents } from "../../lib/money";
import { fieldErrors, fundingFormSchema } from "../_lib/money-forms";
import { keyFor, ownerErrorMessage, type KeyedBody } from "../_lib/idempotency";
import { postJson } from "../_lib/post-json";

/**
 * Fund account, in a dialog. POST /api/funding with an Idempotency-Key that stays the same while
 * the amount does (see keyFor), so a retry after a lost response can't charge twice, and a
 * changed amount after a failure doesn't hit a 409.
 */
export function FundAccountDialog({ variant = "default" }: { variant?: "default" | "outline" }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  // The key and the body it was sent with: kept while the body is unchanged, so a retry replays.
  const sent = useRef<KeyedBody | null>(null);
  const [error, setError] = useState<{ field?: string; form?: string }>({});
  const [sending, setSending] = useState(false);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const parsed = fundingFormSchema.safeParse({ amount: String(new FormData(form).get("amount") ?? "") });
    if (!parsed.success) {
      setError({ field: fieldErrors(parsed.error).amount });
      form.querySelector<HTMLInputElement>('[name="amount"]')?.focus();
      return;
    }
    setSending(true);
    setError({});
    sent.current = keyFor(sent.current, parsed.data, () => crypto.randomUUID());
    const result = await postJson("/api/funding", parsed.data, { "idempotency-key": sent.current.key });
    setSending(false);
    if (!result.ok) {
      setError({ form: ownerErrorMessage(result) });
      return;
    }
    toast.success(`Funding of ${formatCents(parsed.data.amountCents)} requested`, {
      description: "It shows as pending until Stripe confirms the payment.",
    });
    sent.current = null;
    form.reset();
    setOpen(false);
    router.refresh();
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) setError({});
      }}
    >
      <DialogTrigger asChild>
        <Button variant={variant} className="h-9">
          <Plus aria-hidden />
          Fund account
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Fund account</DialogTitle>
          <DialogDescription>Add money from a Stripe test card. It reaches your ledger once Stripe confirms the payment.</DialogDescription>
        </DialogHeader>
        <form id="fund-account" noValidate onSubmit={submit} className="grid gap-4">
          <Field data-invalid={error.field ? true : undefined}>
            <FieldLabel htmlFor="fund-amount">Amount (USD)</FieldLabel>
            <Input
              id="fund-amount"
              name="amount"
              inputMode="decimal"
              placeholder="0.00"
              className="tabular-nums"
              aria-invalid={error.field ? true : undefined}
              aria-describedby={error.field ? "fund-amount-error fund-amount-hint" : "fund-amount-hint"}
            />
            <FieldDescription id="fund-amount-hint">Up to $1,000,000.</FieldDescription>
            <FieldError id="fund-amount-error">{error.field}</FieldError>
          </Field>
          {error.form && (
            <p role="alert" className="rounded-md border border-danger-line/70 bg-danger-soft px-3 py-2 text-sm text-danger">
              {error.form}
            </p>
          )}
        </form>
        <DialogFooter>
          <Button type="submit" form="fund-account" disabled={sending} className="h-9">
            {sending ? "Requesting…" : "Fund account"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
