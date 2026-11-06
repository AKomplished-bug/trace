/** Amounts are integer cents (USD). Throws on floats or values outside the safe integer range. */
export function assertCents(value: number): number {
  if (!Number.isSafeInteger(value)) throw new Error(`Amount must be integer cents, got ${value}`);
  return value;
}

const dollarsFormat = new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 });

/** 43500 → "$435.00", -8000 → "-$80.00"; `signed` adds "+" to positive amounts. Integer math only. */
export function formatCents(cents: number, options: { signed?: boolean } = {}): string {
  assertCents(cents);
  const abs = Math.abs(cents);
  const rest = abs % 100;
  const dollars = dollarsFormat.format((abs - rest) / 100);
  const sign = cents < 0 ? "-" : options.signed && cents > 0 ? "+" : "";
  return `${sign}$${dollars}.${String(rest).padStart(2, "0")}`;
}
