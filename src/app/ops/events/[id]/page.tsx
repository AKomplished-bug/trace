import Link from "next/link";
import { notFound } from "next/navigation";
import type { ReactNode } from "react";
import { getEventDetail } from "../../../../services/ops-events";
import { apiDeps } from "../../../api/deps";
import { providerLabel, STATUS_LABELS, TYPE_LABELS } from "../../../_components/labels";
import { LocalTime } from "../../../_components/local-time";
import { Money } from "../../../_components/money";
import { EventStatusBadge, Tag } from "../../../_components/status-badge";
import { requirePageSession } from "../../../_lib/auth";
import { eventIdParams } from "../../../_lib/schemas";
import { RetryButton } from "./retry-button";

export const metadata = { title: "Event · Trace" };

function Panel({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="rounded-md border border-neutral-200 bg-white">
      <h2 className="border-b border-neutral-100 px-4 py-2.5 text-sm font-semibold">{title}</h2>
      <div className="p-4">{children}</div>
    </section>
  );
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <>
      <dt className="text-neutral-500">{label}</dt>
      <dd className="min-w-0">{children}</dd>
    </>
  );
}

function Id({ value }: { value: string }) {
  return <code className="break-all font-mono text-xs text-neutral-700">{value}</code>;
}

function stateText(state: unknown): string {
  if (!state || typeof state !== "object") return "—";
  return Object.entries(state)
    .map(([key, value]) => `${key}=${String(value)}`)
    .join(" ");
}

export default async function EventPage({ params }: { params: Promise<{ id: string }> }) {
  await requirePageSession("OPS");
  const parsed = eventIdParams.safeParse(await params);
  if (!parsed.success) notFound();
  const detail = await getEventDetail(apiDeps().db, parsed.data.id);
  if (!detail) notFound();
  const { event, deliveries, steps, transactions, audit } = detail;

  return (
    <div className="space-y-4">
      <Link href="/ops/events" className="text-sm text-neutral-600 hover:text-neutral-900">
        ← All events
      </Link>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h1 className="break-all font-mono text-lg font-semibold tracking-tight">{event.eventType}</h1>
          <p className="text-sm text-neutral-600">
            {providerLabel(event.provider)} · <Id value={event.externalEventId} />
          </p>
        </div>
        <EventStatusBadge status={event.status} />
      </div>

      {event.status === "FAILED" && (
        <div className="rounded-md border border-red-200 bg-red-50 p-4">
          <p className="text-sm font-medium text-red-900">Processing failed after {event.attempts} attempt{event.attempts === 1 ? "" : "s"}.</p>
          {event.lastError && <p className="mt-1 break-words font-mono text-xs text-red-800">{event.lastError}</p>}
          <p className="mt-2 text-sm text-red-900">
            Retrying gives it a fresh retry budget. Processing is idempotent: steps already applied are not applied again.
          </p>
          <div className="mt-3">
            <RetryButton eventId={event.id} />
          </div>
        </div>
      )}

      <div className="grid gap-4 lg:grid-cols-2">
        <Panel title="Processing">
          <dl className="grid grid-cols-[max-content_minmax(0,1fr)] gap-x-4 gap-y-2 text-sm">
            <Row label="Status">
              <EventStatusBadge status={event.status} />
            </Row>
            <Row label="Attempts">
              <span className="font-mono tabular-nums">{event.attempts}</span>
              <span className="text-neutral-500"> (claims since received or last Ops retry)</span>
            </Row>
            <Row label="Received">
              <LocalTime value={event.receivedAt} />
            </Row>
            <Row label="Processed">{event.processedAt ? <LocalTime value={event.processedAt} /> : "—"}</Row>
            <Row label={event.status === "PROCESSING" ? "Lease expires" : "Next attempt"}>
              {["RECEIVED", "RETRY", "PROCESSING"].includes(event.status) ? <LocalTime value={event.nextAttemptAt} /> : "—"}
            </Row>
            <Row label="Last error">{event.lastError ? <span className="break-words font-mono text-xs">{event.lastError}</span> : "—"}</Row>
            <Row label="Event id">
              <Id value={event.id} />
            </Row>
            <Row label="Correlation id">
              <Id value={event.correlationId} />
            </Row>
          </dl>
        </Panel>

        <Panel title="Payload">
          <p className="rounded border border-dashed border-neutral-300 px-3 py-4 text-center text-sm text-neutral-600">
            Payload withheld — provider payloads can contain personal data.
          </p>
          <p className="mt-2 text-xs text-neutral-500">
            The worker never trusts it either: handlers re-fetch the object from the provider&apos;s API.
          </p>
        </Panel>
      </div>

      <Panel title={`Deliveries (${deliveries.length})`}>
        {deliveries.length === 0 ? (
          <p className="text-sm text-neutral-600">No deliveries recorded.</p>
        ) : (
          <ol className="space-y-1 text-sm">
            {deliveries.map((d, i) => (
              <li key={i} className="flex items-center gap-3">
                <LocalTime value={d.receivedAt} />
                {d.isDuplicate ? <Tag tone="amber">duplicate · no effect</Tag> : <Tag tone="emerald">first delivery</Tag>}
              </li>
            ))}
          </ol>
        )}
      </Panel>

      <Panel title="Transactions it touched">
        {transactions.length === 0 ? (
          <p className="text-sm text-neutral-600">None.</p>
        ) : (
          <table className="w-full text-sm">
            <thead className="text-left text-xs text-neutral-500">
              <tr>
                <th className="py-1 pr-4 font-medium">Transaction</th>
                <th className="py-1 pr-4 font-medium">Type</th>
                <th className="py-1 pr-4 font-medium">Status</th>
                <th className="py-1 text-right font-medium">Amount</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-neutral-100">
              {transactions.map((t) => (
                <tr key={t.id}>
                  <td className="py-1.5 pr-4">
                    <Id value={t.id} />
                    <span className="block text-xs text-neutral-500">
                      account <code className="font-mono">{t.accountId.slice(0, 8)}</code>
                    </span>
                  </td>
                  <td className="py-1.5 pr-4">{TYPE_LABELS[t.type]}</td>
                  <td className="py-1.5 pr-4">{STATUS_LABELS[t.status]}</td>
                  <td className="py-1.5 text-right">
                    <Money cents={t.amountCents} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Panel>

      <Panel title="Trace steps it wrote">
        {steps.length === 0 ? (
          <p className="text-sm text-neutral-600">None.</p>
        ) : (
          <ol className="space-y-1.5 text-sm">
            {steps.map((s) => (
              <li key={s.id} className="flex flex-wrap items-baseline gap-x-3">
                <span className="font-mono text-xs text-neutral-500">#{s.accountSeq}</span>
                <span className="font-mono text-xs font-medium">{s.kind}</span>
                {s.fromStatus || s.toStatus ? (
                  <span className="text-xs text-neutral-600">
                    {s.fromStatus ?? "—"} → {s.toStatus ?? "—"}
                  </span>
                ) : null}
                {s.amountCents !== null && <Money cents={s.amountCents} className="text-xs" />}
                <span className="text-xs text-neutral-500">
                  on <code className="font-mono">{s.transactionId.slice(0, 8)}</code>
                  {s.providerRef && (
                    <>
                      {" "}
                      · ref <code className="font-mono">{s.providerRef}</code>
                    </>
                  )}
                </span>
              </li>
            ))}
          </ol>
        )}
      </Panel>

      <Panel title="Ops actions">
        {audit.length === 0 ? (
          <p className="text-sm text-neutral-600">None.</p>
        ) : (
          <ol className="space-y-2 text-sm">
            {audit.map((a) => (
              <li key={a.id}>
                <span className="font-mono text-xs font-medium">{a.action}</span>{" "}
                <span className="text-xs text-neutral-500">
                  by <code className="font-mono">{a.actorId ?? "system"}</code> · <LocalTime value={a.createdAt} />
                </span>
                <span className="block font-mono text-xs text-neutral-600">
                  {stateText(a.previousState)} → {stateText(a.newState)}
                </span>
              </li>
            ))}
          </ol>
        )}
      </Panel>
    </div>
  );
}
