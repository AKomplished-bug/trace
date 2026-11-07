"use client";

import { useRouter } from "next/navigation";
import { useState, type ReactNode } from "react";
import { toast } from "sonner";
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { postJson } from "../_lib/post-json";

// Where `open` goes with the response's run or investigation id.
const OPEN_PATHS = { run: "/ops/reconciliation/", investigation: "/ops/investigations/" } as const;

/**
 * An Ops action behind a confirmation dialog: POSTs `body` (JSON) to `url`, then toasts and
 * refreshes the page, or with `open` goes to the run or investigation the response returns. The
 * API's error stays in the dialog. The actions it drives are idempotent or answer 409, so trying
 * again is safe.
 */
export function ConfirmAction({
  url,
  body,
  label,
  title,
  description,
  confirmLabel,
  pendingLabel,
  success,
  open: openTarget,
  variant = "default",
  size = "default",
  disabledReason,
}: {
  url: string;
  body?: unknown;
  label: string;
  title: string;
  description: ReactNode;
  confirmLabel: string;
  pendingLabel: string;
  success: string;
  open?: keyof typeof OPEN_PATHS;
  variant?: "default" | "outline" | "destructive" | "secondary";
  size?: "default" | "sm";
  /** Set when the action isn't available yet: the trigger is disabled and this is shown under it. */
  disabledReason?: string | null;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);

  async function confirm() {
    setSending(true);
    setError(null);
    const result = await postJson<Partial<Record<keyof typeof OPEN_PATHS, { id?: string }>>>(url, body);
    setSending(false);
    if (!result.ok) {
      setError(result.status === null ? "Couldn't reach Trace. Trying again is safe: the action applies once." : result.message);
      router.refresh();
      return;
    }
    setOpen(false);
    toast.success(success);
    const id = openTarget ? result.data?.[openTarget]?.id : undefined;
    if (openTarget && id) router.push(`${OPEN_PATHS[openTarget]}${id}`);
    else router.refresh();
  }

  return (
    <span className="inline-flex flex-col items-end gap-1">
      <AlertDialog
        open={open}
        onOpenChange={(next) => {
          setOpen(next);
          if (!next) setError(null);
        }}
      >
        <AlertDialogTrigger asChild>
          <Button variant={variant} disabled={Boolean(disabledReason)} className={size === "sm" ? "h-8" : "h-9"}>
            {label}
          </Button>
        </AlertDialogTrigger>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{title}</AlertDialogTitle>
            <AlertDialogDescription asChild>
              <div className="space-y-2">{description}</div>
            </AlertDialogDescription>
          </AlertDialogHeader>
          {error && (
            <p role="alert" className="rounded-md border border-danger-line/70 bg-danger-soft px-3 py-2 text-sm text-danger">
              {error}
            </p>
          )}
          <AlertDialogFooter>
            <AlertDialogCancel className="h-9">Cancel</AlertDialogCancel>
            <Button onClick={confirm} disabled={sending} variant={variant === "destructive" ? "destructive" : "default"} className="h-9">
              {sending ? pendingLabel : confirmLabel}
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      {disabledReason && <span className="max-w-64 text-right text-xs text-muted-foreground">{disabledReason}</span>}
    </span>
  );
}
