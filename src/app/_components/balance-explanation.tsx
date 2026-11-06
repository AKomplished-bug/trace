import type { Balance } from "../../services/account-queries";
import { Money } from "./money";

/** The balance decomposition — terms, operators and formula all come from the domain via the balance read. */
export function BalanceExplanation({ balance }: { balance: Balance }) {
  const { formula, lines, result } = balance.explanation;
  return (
    <div>
      <table className="w-full max-w-lg text-sm">
        <tbody>
          {lines.map((line) => (
            <tr key={line.key} className="align-top">
              <td className="w-6 py-1 font-mono text-neutral-400">{line.operator}</td>
              <td className="py-1">
                {line.label}
                <span className="block text-xs text-neutral-500">{line.description}</span>
              </td>
              <td className="py-1 pl-4 text-right">
                <Money cents={line.amountCents} />
              </td>
            </tr>
          ))}
          <tr className="border-t border-neutral-300 font-medium">
            <td className="py-1.5 font-mono text-neutral-400">=</td>
            <td className="py-1.5">{result.label}</td>
            <td className="py-1.5 pl-4 text-right">
              <Money cents={result.amountCents} />
            </td>
          </tr>
        </tbody>
      </table>
      <p className="mt-2 font-mono text-xs text-neutral-500">{formula}</p>
    </div>
  );
}
