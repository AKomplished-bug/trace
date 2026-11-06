import { describe, expect, it } from "vitest";
import { replayTransaction, type ReplayEvent } from "../../domain/replay";
import type { TransactionReplay } from "../../services/replay-queries";
import { whyFinalBalance } from "./replay-copy";

const hold = { id: "h1", kind: "CARD_AUTHORIZATION" as const };
const row = (accountSeq: number, kind: ReplayEvent["kind"], recorded: [number, number], before: [number, number], extra: Partial<ReplayEvent> = {}): ReplayEvent => ({
  id: `r${accountSeq}`,
  transactionId: "buy",
  accountSeq,
  kind,
  amountCents: 8000,
  ledgerDeltaCents: 0,
  toStatus: null,
  hold,
  recorded: { ledgerCents: recorded[0], availableCents: recorded[1] },
  recordedBefore: { ledgerCents: before[0], availableCents: before[1] },
  ...extra,
});

// The copy only reads the replay's balances, steps and holds.
const view = (events: ReplayEvent[]) => ({ transactionId: "buy", ...replayTransaction(events) }) as unknown as TransactionReplay;

describe("whyFinalBalance", () => {
  it("explains the settled purchase: ledger moved by the settlement, the hold no longer counts", () => {
    const replay = view([
      row(4, "HOLD_CREATED", [50000, 42000], [50000, 50000]),
      row(5, "LEDGER_POSTED", [43500, 43500], [50000, 42000], { amountCents: -6500, ledgerDeltaCents: -6500 }),
      row(6, "HOLD_RELEASED", [43500, 43500], [43500, 43500]),
    ]);
    expect(whyFinalBalance(replay)).toEqual([
      "Ledger $435.00 = $500.00 before this transaction -$65.00 from this transaction.",
      "Available $435.00 = ledger $435.00 − $0.00 on hold; this transaction's $80.00 hold was released and no longer counts.",
    ]);
  });

  it("names other activity in between and a hold that is still active", () => {
    const replay = view([row(2, "HOLD_CREATED", [50000, 42000], [50000, 50000]), row(9, "HOLD_EXCEEDS_AVAILABLE", [60000, 52000], [60000, 52000])]);
    expect(whyFinalBalance(replay)).toEqual([
      "Ledger $600.00 = $500.00 before this transaction +$100.00 from other activity in between (this transaction moved no money).",
      "Available $520.00 = ledger $600.00 − $80.00 on hold, including this transaction's $80.00 hold, still active.",
    ]);
  });
});
