"use client";

import { ArrowUpRight } from "lucide-react";
import Link from "next/link";
import { useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { cn } from "@/lib/utils";
import type { TransactionSummary } from "../../services/transaction-queries";
import { amountView, counterparty, isInFlight, providerLabel, TYPE_LABELS } from "./labels";
import { LocalTime } from "./local-time";
import { Fact, Facts, Id } from "./page-parts";
import { StatusBadge } from "./status-badge";
import { TransactionAmount } from "./transaction-amount";

/** What the amount means, in words, for the summary sheet. */
function amountMeaning(t: TransactionSummary): string {
  const view = amountView(t);
  switch (view.kind) {
    case "posted":
      return view.cents >= 0 ? "Credited to your ledger." : "Debited from your ledger.";
    case "held":
      return "Reserved from your available balance; not on your ledger yet.";
    case "void":
      return "Ended without moving money.";
    case "pending":
      return "Nothing has moved yet.";
  }
}

/**
 * Transactions as dense rows. A row opens a summary sheet; the sheet links to the full money
 * trace. Rows whose money is held or not moved yet are marked pending (tinted, with a dashed
 * badge and the words "On hold" or "Not moved yet").
 */
export function ActivityTable({ items, caption }: { items: TransactionSummary[]; caption: string }) {
  const [selected, setSelected] = useState<TransactionSummary | null>(null);
  // The row button that opened the sheet; focus goes back to it when the sheet closes.
  const opener = useRef<HTMLButtonElement | null>(null);

  return (
    <>
      <div className="overflow-hidden rounded-xl border bg-card">
        <Table>
          <caption className="sr-only">{caption}. Select a row for its summary.</caption>
          <TableHeader className="bg-muted/50">
            <TableRow className="hover:bg-transparent">
              <TableHead className="hidden w-44 px-4 text-xs text-muted-foreground sm:table-cell">Date</TableHead>
              <TableHead className="px-4 text-xs text-muted-foreground">Description</TableHead>
              <TableHead className="hidden px-4 text-xs text-muted-foreground sm:table-cell">Status</TableHead>
              <TableHead className="px-4 text-right text-xs text-muted-foreground">Amount</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {items.map((t) => {
              const pending = isInFlight(amountView(t));
              return (
                <TableRow
                  key={t.id}
                  data-pending={pending || undefined}
                  className={cn("relative cursor-pointer", pending && "bg-pending-soft/45 shadow-[inset_3px_0_0_var(--pending-line)] hover:bg-pending-soft/70")}
                >
                  <TableCell className="hidden px-4 py-3 text-xs text-muted-foreground sm:table-cell">
                    <LocalTime value={t.createdAt} />
                  </TableCell>
                  <TableCell className="px-4 py-3 whitespace-normal">
                    <button
                      type="button"
                      onClick={(event) => {
                        opener.current = event.currentTarget;
                        setSelected(t);
                      }}
                      className="block text-left font-medium outline-none after:absolute after:inset-0 after:content-[''] focus-visible:after:rounded-sm focus-visible:after:ring-2 focus-visible:after:ring-ring focus-visible:after:ring-inset"
                    >
                      {TYPE_LABELS[t.type]}
                    </button>
                    <span className="block text-xs text-muted-foreground">
                      {counterparty(t)}
                      <span className="sm:hidden">
                        {", "}
                        <LocalTime value={t.createdAt} />
                      </span>
                    </span>
                    <span className="mt-1.5 block sm:hidden">
                      <StatusBadge status={t.status} />
                    </span>
                  </TableCell>
                  <TableCell className="hidden px-4 py-3 sm:table-cell">
                    <StatusBadge status={t.status} />
                  </TableCell>
                  <TableCell className="px-4 py-3 text-right font-medium">
                    <TransactionAmount t={t} />
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </div>

      <Sheet open={selected !== null} onOpenChange={(open) => !open && setSelected(null)}>
        <SheetContent
          className="w-full gap-0 sm:max-w-md"
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            opener.current?.focus();
          }}
        >
          {selected && (
            <>
              <SheetHeader className="border-b p-5">
                <SheetTitle>{TYPE_LABELS[selected.type]}</SheetTitle>
                <SheetDescription>{counterparty(selected)}</SheetDescription>
              </SheetHeader>
              <div className="space-y-5 overflow-y-auto p-5">
                <div className="flex items-start justify-between gap-4">
                  <StatusBadge status={selected.status} />
                  <TransactionAmount t={selected} className="text-2xl font-semibold tracking-tight" />
                </div>
                <p className="text-sm text-muted-foreground">{amountMeaning(selected)}</p>
                <Facts>
                  <Fact label="Created">
                    <LocalTime value={selected.createdAt} />
                  </Fact>
                  <Fact label="Last update">
                    <LocalTime value={selected.updatedAt} />
                  </Fact>
                  <Fact label="Provider">{providerLabel(selected.provider)}</Fact>
                  <Fact label="Provider id">
                    <Id value={selected.providerObjectId} />
                  </Fact>
                  <Fact label="Transaction id">
                    <Id value={selected.id} />
                  </Fact>
                </Facts>
                <Button asChild className="h-9 w-full">
                  <Link href={`/transactions/${selected.id}`}>
                    Open money trace
                    <ArrowUpRight aria-hidden />
                  </Link>
                </Button>
              </div>
            </>
          )}
        </SheetContent>
      </Sheet>
    </>
  );
}
