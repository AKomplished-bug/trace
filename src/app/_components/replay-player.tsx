"use client";

import { useState, type KeyboardEvent } from "react";
import { formatCents } from "../../lib/money";
import { Money } from "./money";

interface Balances {
  ledgerCents: number;
  availableCents: number;
}

export interface PlayerStep {
  id: string;
  seq: number;
  title: string;
  detail: string;
  effect: string;
  before: Balances;
  after: Balances;
  otherActivity: Balances | null;
  matches: boolean;
}

export interface PlayerProps {
  initial: Balances;
  steps: PlayerStep[];
  why: string[];
}

const percent = (cents: number, max: number) => `${(Math.max(cents, 0) / max) * 100}%`;

/** One balance, before → after: the bar is the value after; the changed part is highlighted. */
function BalanceBar({ label, before, after, max, tone }: { label: string; before: number; after: number; max: number; tone: string }) {
  const delta = after - before;
  const low = Math.max(Math.min(before, after), 0);
  const high = Math.max(before, after, 0);
  return (
    <div className="grid grid-cols-[5.5rem_minmax(0,1fr)] items-center gap-x-3 gap-y-1 sm:grid-cols-[5.5rem_minmax(0,1fr)_minmax(13rem,max-content)]">
      <span className="text-xs font-medium text-neutral-600">{label}</span>
      <div className="relative h-4 overflow-hidden rounded-sm bg-neutral-100" aria-hidden>
        <div className={`absolute inset-y-0 left-0 ${tone} transition-[width] duration-300`} style={{ width: percent(after, max) }} />
        {delta !== 0 && (
          <div
            className={`absolute inset-y-0 transition-all duration-300 ${
              delta < 0 ? "bg-[repeating-linear-gradient(45deg,#fca5a5_0,#fca5a5_3px,#fee2e2_3px,#fee2e2_6px)]" : "bg-emerald-300"
            }`}
            style={{ left: percent(low, max), width: `calc(${percent(high, max)} - ${percent(low, max)})` }}
          />
        )}
      </div>
      <p className="col-start-2 whitespace-nowrap text-sm sm:col-start-3 sm:text-right">
        <Money cents={before} className="text-neutral-500" /> <span aria-hidden>→</span>
        <span className="sr-only">to</span> <Money cents={after} className="font-medium" />
        <span className={`ml-2 font-mono text-xs ${delta < 0 ? "text-red-700" : delta > 0 ? "text-emerald-700" : "text-neutral-400"}`}>
          {delta === 0 ? "no change" : formatCents(delta, { signed: true })}
        </span>
      </p>
    </div>
  );
}

/** Ledger (solid) and available (dashed) as step lines across the replay, with the current position. */
function SteppedChart({ points, position, max, min }: { points: Balances[]; position: number; max: number; min: number }) {
  const width = Math.max(points.length - 1, 1);
  const range = max - min || 1;
  const y = (cents: number) => 4 + (1 - (cents - min) / range) * 52;
  // Each step is a vertical move at its x position: M0 y0 H1 Vy1 H2 Vy2 …
  const path = (key: keyof Balances) => points.map((point, i) => (i === 0 ? `M0 ${y(point[key])}` : `H${i} V${y(point[key])}`)).join(" ");
  return (
    <svg viewBox={`0 0 ${width} 60`} preserveAspectRatio="none" className="h-16 w-full" aria-hidden>
      <line x1={position} x2={position} y1={0} y2={60} className="stroke-neutral-300" strokeWidth={1} vectorEffect="non-scaling-stroke" />
      <path d={path("ledgerCents")} fill="none" className="stroke-neutral-800" strokeWidth={2} vectorEffect="non-scaling-stroke" />
      <path d={path("availableCents")} fill="none" className="stroke-emerald-600" strokeWidth={2} strokeDasharray="5 3" vectorEffect="non-scaling-stroke" />
    </svg>
  );
}

/**
 * Step-through replay (spec §11): position 0 is the account just before the transaction, then
 * one position per trace step. Buttons, the step list and ←/→/Home/End move through it; each
 * move is announced via aria-live.
 */
export function ReplayPlayer({ initial, steps, why }: PlayerProps) {
  const [position, setPosition] = useState(0);
  const last = steps.length;
  const go = (to: number) => setPosition(Math.min(Math.max(to, 0), last));
  const step = position > 0 ? steps[position - 1] : null;
  const current = step ? step.after : initial;
  const before = step ? step.before : initial;
  const points = [initial, ...steps.map((s) => s.after)];
  const values = points.flatMap((p) => [p.ledgerCents, p.availableCents]).concat(steps.flatMap((s) => [s.before.ledgerCents, s.before.availableCents]));
  const max = Math.max(...values, 1);
  const min = Math.min(...values, 0);

  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    const moves: Record<string, number> = { ArrowLeft: position - 1, ArrowRight: position + 1, Home: 0, End: last };
    if (event.key in moves) {
      event.preventDefault();
      go(moves[event.key]);
    }
  }

  const announcement = step
    ? `Step ${position} of ${last}: ${step.title}. Ledger ${formatCents(step.before.ledgerCents)} to ${formatCents(step.after.ledgerCents)}, available ${formatCents(step.before.availableCents)} to ${formatCents(step.after.availableCents)}.`
    : `Start: ledger ${formatCents(initial.ledgerCents)}, available ${formatCents(initial.availableCents)}.`;
  const button = "rounded border border-neutral-200 px-2.5 py-1 text-xs font-medium text-neutral-700 hover:bg-neutral-50 disabled:cursor-not-allowed disabled:opacity-40";

  return (
    <div
      role="group"
      aria-label="Replay player. Use the left and right arrow keys to step through."
      tabIndex={0}
      onKeyDown={onKeyDown}
      className="space-y-4 rounded outline-none focus-visible:ring-2 focus-visible:ring-neutral-400"
    >
      <p className="sr-only" aria-live="polite">
        {announcement}
      </p>

      <div className="flex flex-wrap items-center gap-2">
        <button type="button" className={button} onClick={() => go(0)} disabled={position === 0}>
          <span aria-hidden>⏮</span> Start
        </button>
        <button type="button" className={button} onClick={() => go(position - 1)} disabled={position === 0} aria-label="Previous step">
          ← Prev
        </button>
        <button type="button" className={button} onClick={() => go(position + 1)} disabled={position === last} aria-label="Next step">
          Next →
        </button>
        <button type="button" className={button} onClick={() => go(last)} disabled={position === last}>
          End <span aria-hidden>⏭</span>
        </button>
        <span className="ml-auto font-mono text-xs text-neutral-500">{position === 0 ? "start" : `step ${position} / ${last}`}</span>
      </div>

      <ol className="flex flex-wrap gap-1" aria-label="Steps">
        <li>
          <button
            type="button"
            onClick={() => go(0)}
            aria-current={position === 0 ? "step" : undefined}
            className={`h-6 rounded px-2 font-mono text-[11px] ${position === 0 ? "bg-neutral-900 text-white" : "bg-neutral-100 text-neutral-600 hover:bg-neutral-200"}`}
          >
            start
          </button>
        </li>
        {steps.map((s, i) => (
          <li key={s.id}>
            <button
              type="button"
              onClick={() => go(i + 1)}
              aria-current={position === i + 1 ? "step" : undefined}
              aria-label={`Step ${i + 1}: ${s.title}${s.matches ? "" : " (doesn't match the recorded balances)"}`}
              className={`h-6 min-w-6 rounded px-1.5 font-mono text-[11px] ${
                position === i + 1
                  ? s.matches
                    ? "bg-neutral-900 text-white"
                    : "bg-red-700 text-white"
                  : s.matches
                    ? "bg-neutral-100 text-neutral-600 hover:bg-neutral-200"
                    : "bg-red-50 text-red-800 ring-1 ring-inset ring-red-200"
              }`}
            >
              {i + 1}
            </button>
          </li>
        ))}
      </ol>

      <div className="rounded border border-neutral-100 bg-neutral-50 p-3">
        {step ? (
          <>
            <p className="font-mono text-xs text-neutral-500">step {step.seq}</p>
            <p className="mt-0.5 text-sm font-medium">{step.title}</p>
            {step.detail && <p className="mt-0.5 text-xs text-neutral-600">{step.detail}</p>}
            <p className="mt-1.5 text-xs text-neutral-800">{step.effect}</p>
            {step.otherActivity && (
              <p className="mt-1.5 text-xs text-neutral-500">
                Before this step, other activity on your account moved the ledger by{" "}
                <Money cents={step.otherActivity.ledgerCents} signed /> and available by <Money cents={step.otherActivity.availableCents} signed />.
              </p>
            )}
            {!step.matches && <p className="mt-1.5 text-xs font-medium text-red-700">The recorded balances after this step differ from the replay.</p>}
          </>
        ) : (
          <>
            <p className="text-sm font-medium">Start</p>
            <p className="mt-0.5 text-xs text-neutral-600">Your account just before this transaction&apos;s first step.</p>
          </>
        )}
      </div>

      <div className="space-y-2">
        <BalanceBar label="Ledger" before={before.ledgerCents} after={current.ledgerCents} max={max} tone="bg-neutral-800" />
        <BalanceBar label="Available" before={before.availableCents} after={current.availableCents} max={max} tone="bg-emerald-600" />
        {current.availableCents < 0 && <p className="text-xs text-red-700">Available is below zero.</p>}
      </div>

      {steps.length > 0 && (
        <figure>
          <SteppedChart points={points} position={position} max={max} min={min} />
          <figcaption className="mt-1 flex gap-4 text-[11px] text-neutral-500">
            <span>
              <span aria-hidden className="mr-1 inline-block h-0.5 w-4 bg-neutral-800 align-middle" />
              Ledger
            </span>
            <span>
              <span aria-hidden className="mr-1 inline-block w-4 border-t-2 border-dashed border-emerald-600 align-middle" />
              Available
            </span>
          </figcaption>
        </figure>
      )}

      {why.length > 0 && (
        <div className="border-t border-neutral-100 pt-3">
          <p className="text-xs font-medium uppercase tracking-wide text-neutral-500">Why the final balance is what it is</p>
          <ul className="mt-1 space-y-0.5 font-mono text-xs text-neutral-800">
            {why.map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
