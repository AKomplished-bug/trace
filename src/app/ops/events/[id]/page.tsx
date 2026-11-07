import { ChevronLeft } from "lucide-react";
import Link from "next/link";
import { notFound } from "next/navigation";
import { getEventDetail } from "../../../../services/ops-events";
import { apiDeps } from "../../../api/deps";
import { providerLabel, STATUS_LABELS, TYPE_LABELS } from "../../../_components/labels";
import { LocalTime } from "../../../_components/local-time";
import { Money } from "../../../_components/money";
import { Fact, Facts, Id, linkClass, Panel, stateText } from "../../../_components/page-parts";
import { EventStatusBadge, Tag } from "../../../_components/status-badge";
import { requirePageSession } from "../../../_lib/auth";
import { eventIdParams } from "../../../_lib/schemas";
import { RetryButton } from "./retry-button";

export const metadata = { title: "Event · Trace" };

export default async function EventPage({ params }: { params: Promise<{ id: string }> }) {
  await requirePageSession("OPS");
  const parsed = eventIdParams.safeParse(await params);
  if (!parsed.success) notFound();
  const detail = await getEventDetail(apiDeps().db, parsed.data.id);
  if (!detail) notFound();
  const { event, deliveries, steps, transactions, audit } = detail;

  return (
    <div className="space-y-6">
      <Link href="/ops/events" className={`inline-flex min-h-6 items-center gap-1 text-sm ${linkClass}`}>
        <ChevronLeft aria-hidden className="size-4" />
        Events
      </Link>
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-sm text-muted-foreground">{providerLabel(event.provider)} event</p>
          <h1 className="font-mono text-lg font-semibold tracking-tight break-all">{event.eventType}</h1>
          <p className="mt-1">
            <Id value={event.externalEventId} />
          </p>
        </div>
        <EventStatusBadge status={event.status} />
      </header>

      {event.status === "FAILED" && (
        <section aria-labelledby="failed-heading" className="rounded-xl border border-danger-line/70 bg-danger-soft p-4 sm:p-5">
          <h2 id="failed-heading" className="text-sm font-semibold text-danger">
            Processing failed after {event.attempts} attempt{event.attempts === 1 ? "" : "s"}
          </h2>
          {event.lastError && <p className="mt-1 font-mono text-xs break-words text-danger">{event.lastError}</p>}
          <p className="mt-2 text-sm text-foreground">Retrying gives it a fresh retry budget. Processing is idempotent: steps already applied are not applied again.</p>
          <div className="mt-3">
            <RetryButton eventId={event.id} />
          </div>
        </section>
      )}

      <div className="grid gap-5 lg:grid-cols-2">
        <Panel title="Processing">
          <Facts>
            <Fact label="Status">
              <EventStatusBadge status={event.status} />
            </Fact>
            <Fact label="Attempts">
              <span className="tabular-nums">{event.attempts}</span>
              <span className="text-muted-foreground"> (claims since received or the last Ops retry)</span>
            </Fact>
            <Fact label="Received">
              <LocalTime value={event.receivedAt} />
            </Fact>
            <Fact label="Processed">{event.processedAt ? <LocalTime value={event.processedAt} /> : "—"}</Fact>
            <Fact label={event.status === "PROCESSING" ? "Lease expires" : "Next attempt"}>
              {["RECEIVED", "RETRY", "PROCESSING"].includes(event.status) ? <LocalTime value={event.nextAttemptAt} /> : "—"}
            </Fact>
            <Fact label="Last error">{event.lastError ? <span className="font-mono text-xs break-words">{event.lastError}</span> : "—"}</Fact>
            <Fact label="Event id">
              <Id value={event.id} />
            </Fact>
            <Fact label="Correlation id">
              <Id value={event.correlationId} />
            </Fact>
          </Facts>
        </Panel>

        <Panel title="Payload">
          <p className="rounded-lg border border-dashed px-3 py-4 text-center text-sm text-muted-foreground">Payload withheld: provider payloads can contain personal data.</p>
          <p className="mt-2 text-xs text-muted-foreground">The worker never trusts it either: handlers re-fetch the object from the provider&apos;s API.</p>
        </Panel>
      </div>

      <Panel title={`Deliveries (${deliveries.length})`}>
        {deliveries.length === 0 ? (
          <p className="text-sm text-muted-foreground">No deliveries recorded.</p>
        ) : (
          <ol className="space-y-2 text-sm">
            {deliveries.map((d, i) => (
              <li key={i} className="flex flex-wrap items-center gap-3">
                <LocalTime value={d.receivedAt} />
                {d.isDuplicate ? <Tag tone="amber">Duplicate, no effect</Tag> : <Tag tone="emerald">First delivery</Tag>}
              </li>
            ))}
          </ol>
        )}
      </Panel>

      <Panel title="Transactions it touched" flush>
        {transactions.length === 0 ? (
          <p className="p-4 text-sm text-muted-foreground">None.</p>
        ) : (
          <ul className="divide-y text-sm">
            {transactions.map((t) => (
              <li key={t.id} className="flex flex-wrap items-start justify-between gap-3 px-4 py-3">
                <span className="min-w-0">
                  <span className="font-medium">{TYPE_LABELS[t.type]}</span>, {STATUS_LABELS[t.status].toLowerCase()}
                  <span className="block">
                    <Id value={t.id} />
                  </span>
                  <span className="block text-xs text-muted-foreground">
                    Account <code className="font-mono">{t.accountId.slice(0, 8)}</code>
                  </span>
                </span>
                <Money cents={t.amountCents} className="font-medium" />
              </li>
            ))}
          </ul>
        )}
      </Panel>

      <Panel title="Trace steps it wrote">
        {steps.length === 0 ? (
          <p className="text-sm text-muted-foreground">None.</p>
        ) : (
          <ol className="space-y-2 text-sm">
            {steps.map((s) => (
              <li key={s.id} className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5">
                <span className="font-mono text-xs text-muted-foreground">#{s.accountSeq}</span>
                <span className="font-mono text-xs font-medium">{s.kind}</span>
                {s.fromStatus || s.toStatus ? (
                  <span className="text-xs text-muted-foreground">
                    {s.fromStatus ?? "—"} → {s.toStatus ?? "—"}
                  </span>
                ) : null}
                {s.amountCents !== null && <Money cents={s.amountCents} className="text-xs" />}
                <span className="text-xs text-muted-foreground">
                  on <code className="font-mono">{s.transactionId.slice(0, 8)}</code>
                  {s.providerRef && (
                    <>
                      , ref <code className="font-mono">{s.providerRef}</code>
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
          <p className="text-sm text-muted-foreground">None.</p>
        ) : (
          <ol className="space-y-3 text-sm">
            {audit.map((a) => (
              <li key={a.id}>
                <span className="font-mono text-xs font-medium">{a.action}</span>{" "}
                <span className="text-xs text-muted-foreground">
                  by <code className="font-mono">{a.actorId ?? "system"}</code>, <LocalTime value={a.createdAt} />
                </span>
                <span className="block font-mono text-xs break-words text-muted-foreground">
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
