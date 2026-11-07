"use client";

import { Send } from "lucide-react";
import { useRouter } from "next/navigation";
import { useRef, useState, type FormEvent } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { formatCents } from "../../lib/money";
import { fieldErrors, paymentFormSchema } from "../_lib/money-forms";
import { keyFor, ownerErrorMessage, type KeyedBody } from "../_lib/idempotency";
import { postJson } from "../_lib/post-json";

const FIELDS = ["recipientName", "accountNumber", "routingNumber", "amount", "description"] as const;
type FieldName = (typeof FIELDS)[number];

/**
 * Send payment, in a dialog. POST /api/payments with an Idempotency-Key that stays the same while
 * the payment details do (see keyFor), so submitting again after a timeout or a lost response
 * can't send twice, and editing the details after a failure doesn't hit a 409.
 */
export function SendPaymentDialog({ variant = "default" }: { variant?: "default" | "outline" }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  // The key and the body it was sent with: kept while the body is unchanged, so a retry replays.
  const sent = useRef<KeyedBody | null>(null);
  const [errors, setErrors] = useState<Partial<Record<FieldName | "form", string>>>({});
  const [sending, setSending] = useState(false);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    const parsed = paymentFormSchema.safeParse(Object.fromEntries(FIELDS.map((name) => [name, String(data.get(name) ?? "")])));
    if (!parsed.success) {
      const problems = fieldErrors(parsed.error);
      setErrors(problems);
      const first = FIELDS.find((name) => problems[name]);
      if (first) form.querySelector<HTMLInputElement>(`[name="${first}"]`)?.focus();
      return;
    }
    setSending(true);
    setErrors({});
    sent.current = keyFor(sent.current, parsed.data, () => crypto.randomUUID());
    const result = await postJson("/api/payments", parsed.data, { "idempotency-key": sent.current.key });
    setSending(false);
    if (!result.ok) {
      setErrors({ form: ownerErrorMessage(result) });
      return;
    }
    toast.success(`Payment of ${formatCents(parsed.data.amountCents)} to ${parsed.data.recipientName} created`, {
      description: "The amount is on hold until the payment completes.",
    });
    sent.current = null;
    form.reset();
    setOpen(false);
    router.refresh();
  }

  const invalid = (name: FieldName) => (errors[name] ? true : undefined);
  const describedBy = (name: FieldName, hint?: boolean) =>
    [errors[name] ? `${name}-error` : null, hint ? `${name}-hint` : null].filter(Boolean).join(" ") || undefined;

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) setErrors({});
      }}
    >
      <DialogTrigger asChild>
        <Button variant={variant} className="h-9">
          <Send aria-hidden />
          Send payment
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Send payment</DialogTitle>
          <DialogDescription>
            An ACH transfer to another bank account. The amount comes off your available balance now and leaves your ledger when the payment completes.
          </DialogDescription>
        </DialogHeader>
        <form id="send-payment" noValidate onSubmit={submit}>
          <FieldGroup className="gap-4">
            <Field data-invalid={invalid("recipientName")}>
              <FieldLabel htmlFor="recipientName">Recipient</FieldLabel>
              <Input id="recipientName" name="recipientName" maxLength={22} autoComplete="off" aria-invalid={invalid("recipientName")} aria-describedby={describedBy("recipientName")} />
              <FieldError id="recipientName-error">{errors.recipientName}</FieldError>
            </Field>
            <div className="grid gap-4 sm:grid-cols-2">
              <Field data-invalid={invalid("accountNumber")}>
                <FieldLabel htmlFor="accountNumber">Account number</FieldLabel>
                <Input
                  id="accountNumber"
                  name="accountNumber"
                  inputMode="numeric"
                  autoComplete="off"
                  className="font-mono"
                  aria-invalid={invalid("accountNumber")}
                  aria-describedby={describedBy("accountNumber")}
                />
                <FieldError id="accountNumber-error">{errors.accountNumber}</FieldError>
              </Field>
              <Field data-invalid={invalid("routingNumber")}>
                <FieldLabel htmlFor="routingNumber">Routing number</FieldLabel>
                <Input
                  id="routingNumber"
                  name="routingNumber"
                  inputMode="numeric"
                  autoComplete="off"
                  className="font-mono"
                  aria-invalid={invalid("routingNumber")}
                  aria-describedby={describedBy("routingNumber", true)}
                />
                <FieldDescription id="routingNumber-hint">9 digits. The sandbox accepts 101050001.</FieldDescription>
                <FieldError id="routingNumber-error">{errors.routingNumber}</FieldError>
              </Field>
            </div>
            <div className="grid gap-4 sm:grid-cols-2">
              <Field data-invalid={invalid("amount")}>
                <FieldLabel htmlFor="amount">Amount (USD)</FieldLabel>
                <Input id="amount" name="amount" inputMode="decimal" placeholder="0.00" className="tabular-nums" aria-invalid={invalid("amount")} aria-describedby={describedBy("amount")} />
                <FieldError id="amount-error">{errors.amount}</FieldError>
              </Field>
              <Field data-invalid={invalid("description")}>
                <FieldLabel htmlFor="description">
                  Description <span className="font-normal text-muted-foreground">(optional)</span>
                </FieldLabel>
                <Input id="description" name="description" maxLength={80} aria-invalid={invalid("description")} aria-describedby={describedBy("description")} />
                <FieldError id="description-error">{errors.description}</FieldError>
              </Field>
            </div>
            {errors.form && (
              <p role="alert" className="rounded-md border border-danger-line/70 bg-danger-soft px-3 py-2 text-sm text-danger">
                {errors.form}
              </p>
            )}
          </FieldGroup>
        </form>
        <DialogFooter>
          <Button type="submit" form="send-payment" disabled={sending} className="h-9">
            {sending ? "Sending…" : "Send payment"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
