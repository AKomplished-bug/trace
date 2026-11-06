/**
 * Ledger entry types and their direction. Sign convention: credit = positive, debit = negative.
 * Amounts are integer cents.
 */
export const LEDGER_ENTRY_TYPES = [
  "FUNDING_CREDIT",
  "CARD_SETTLEMENT_DEBIT",
  "CARD_REVERSAL_CREDIT",
  "PAYMENT_DEBIT",
  "PAYMENT_RETURN_CREDIT",
  "ADJUSTMENT",
] as const;

export type LedgerEntryType = (typeof LEDGER_ENTRY_TYPES)[number];

const DIRECTION: Record<LedgerEntryType, "CREDIT" | "DEBIT" | "EITHER"> = {
  FUNDING_CREDIT: "CREDIT",
  CARD_SETTLEMENT_DEBIT: "DEBIT",
  CARD_REVERSAL_CREDIT: "CREDIT",
  PAYMENT_DEBIT: "DEBIT",
  PAYMENT_RETURN_CREDIT: "CREDIT",
  ADJUSTMENT: "EITHER",
};

export const TRANSACTION_TYPES = [
  "FUNDING",
  "CARD_PURCHASE",
  "CARD_REVERSAL",
  "OUTBOUND_PAYMENT",
  "PAYMENT_RETURN",
  "ADJUSTMENT",
] as const;

export type TransactionType = (typeof TRANSACTION_TYPES)[number];

/**
 * The one ledger entry type each transaction type may post. With UNIQUE(transaction_id,
 * entry_type) this means one ledger effect per transaction; a correction is a new ADJUSTMENT
 * transaction, never a second entry on the original.
 */
export const ENTRY_TYPE_FOR_TRANSACTION: Record<TransactionType, LedgerEntryType> = {
  FUNDING: "FUNDING_CREDIT",
  CARD_PURCHASE: "CARD_SETTLEMENT_DEBIT",
  CARD_REVERSAL: "CARD_REVERSAL_CREDIT",
  OUTBOUND_PAYMENT: "PAYMENT_DEBIT",
  PAYMENT_RETURN: "PAYMENT_RETURN_CREDIT",
  ADJUSTMENT: "ADJUSTMENT",
};

export class InvalidLedgerEntryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidLedgerEntryError";
  }
}

/** Throws unless `amountCents` is a non-zero integer with the sign the entry type requires. */
export function assertLedgerEntryAmount(entryType: LedgerEntryType, amountCents: number): void {
  if (!Number.isSafeInteger(amountCents) || amountCents === 0) {
    throw new InvalidLedgerEntryError(`${entryType} amount must be non-zero integer cents, got ${amountCents}`);
  }
  const direction = DIRECTION[entryType];
  if (direction === "CREDIT" && amountCents < 0) {
    throw new InvalidLedgerEntryError(`${entryType} is a credit and must be positive, got ${amountCents}`);
  }
  if (direction === "DEBIT" && amountCents > 0) {
    throw new InvalidLedgerEntryError(`${entryType} is a debit and must be negative, got ${amountCents}`);
  }
}

/** Throws unless `entryType` is the entry type `transactionType` posts. */
export function assertEntryTypeForTransaction(transactionType: TransactionType, entryType: LedgerEntryType): void {
  const expected = ENTRY_TYPE_FOR_TRANSACTION[transactionType];
  if (entryType !== expected) {
    throw new InvalidLedgerEntryError(`${transactionType} transactions post ${expected}, not ${entryType}`);
  }
}

/** Ledger balance is the sum of all entries for the account. */
export function ledgerBalanceCents(entries: ReadonlyArray<{ amountCents: number }>): number {
  return entries.reduce((sum, entry) => sum + entry.amountCents, 0);
}
