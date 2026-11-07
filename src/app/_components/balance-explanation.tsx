import type { Balance } from "../../services/account-queries";
import { Money } from "./money";

const OPERATOR_WORDS: Record<string, string> = { "+": "plus", "−": "minus", "-": "minus" };

/** The balance decomposition: terms, operators and formula all come from the domain via the balance read. */
export function BalanceExplanation({ balance }: { balance: Balance }) {
  const { formula, lines, result } = balance.explanation;
  return (
    <div>
      <table className="w-full text-sm">
        <caption className="sr-only">How the available balance is calculated</caption>
        <thead className="sr-only">
          <tr>
            <th scope="col">Operation</th>
            <th scope="col">Term</th>
            <th scope="col">Amount</th>
          </tr>
        </thead>
        <tbody>
          {lines.map((line) => (
            <tr key={line.key} className="border-b align-top">
              <td className="w-8 py-3 text-center text-base text-muted-foreground">
                <span aria-hidden>{line.operator}</span>
                <span className="sr-only">{OPERATOR_WORDS[line.operator] ?? line.operator}</span>
              </td>
              <th scope="row" className="py-3 text-left font-normal">
                <span className="font-medium">{line.label}</span>
                <span className="block text-xs text-muted-foreground">{line.description}</span>
              </th>
              <td className={`py-3 pl-4 text-right text-base font-medium ${line.key !== lines[0].key && line.amountCents > 0 ? "text-pending" : ""}`}>
                <Money cents={line.amountCents} />
              </td>
            </tr>
          ))}
          <tr className="align-top">
            <td className="w-8 py-3 text-center text-base text-muted-foreground">
              <span aria-hidden>=</span>
              <span className="sr-only">equals</span>
            </td>
            <th scope="row" className="py-3 text-left font-semibold">
              {result.label}
            </th>
            <td className="py-3 pl-4 text-right text-lg font-semibold">
              <Money cents={result.amountCents} />
            </td>
          </tr>
        </tbody>
      </table>
      <p className="mt-2 text-xs text-muted-foreground">{formula}</p>
    </div>
  );
}
