import Link from "next/link";
import type { GraphEdge, GraphNode, MoneyGraph as Graph } from "../../domain/replay";
import type { TransactionType } from "./labels";
import { Money } from "./money";
import { EDGE_COPY, graphNodeHref, graphNodeTitle } from "./replay-copy";
import { Tag } from "./status-badge";

function NodeBody({ node }: { node: GraphNode }) {
  switch (node.type) {
    case "external":
      return node.providerRef || node.externalEventIds[0] ? (
        <code className="block truncate font-mono text-[11px] text-muted-foreground">{node.providerRef ?? node.externalEventIds[0]}</code>
      ) : null;
    case "hold":
      return (
        <p className="text-sm">
          <Money cents={node.amountCents} /> <Tag tone={node.status === "ACTIVE" ? "amber" : "neutral"}>{node.status === "ACTIVE" ? "Active" : node.status === "RELEASED" ? "Released" : "Expired"}</Tag>
        </p>
      );
    case "ledger_entry":
      return <Money cents={node.amountCents} signed className="text-sm" />;
    case "balance":
      return (
        <p className="text-xs text-muted-foreground">
          Ledger <Money cents={node.ledgerCents} className="text-foreground" /> · Available <Money cents={node.availableCents} className="text-foreground" />
        </p>
      );
    case "transaction":
      return null;
  }
}

/**
 * The money graph (spec §25) as plain DOM: nodes in causal order, each arrow naming the edge
 * from the node above; edges from further up are listed on the node. Nodes link to the timeline
 * step, ledger entry, external record or linked transaction behind them. The timeline stays.
 */
export function MoneyGraph({ graph, type }: { graph: Graph; type: TransactionType }) {
  const byId = new Map(graph.nodes.map((node) => [node.id, node]));
  const incoming = (id: string) => graph.edges.filter((edge) => edge.to === id);
  const titleOf = (id: string) => {
    const node = byId.get(id);
    return node ? graphNodeTitle(node, type).title : id;
  };

  if (graph.nodes.length === 0) return <p className="text-sm text-muted-foreground">Nothing has happened to this transaction yet.</p>;

  return (
    <ol className="flex flex-col items-stretch" aria-label="Money graph, in causal order">
      {graph.nodes.map((node, i) => {
        const previous = graph.nodes[i - 1];
        const edges = incoming(node.id);
        const fromPrevious: GraphEdge | undefined = previous && edges.find((edge) => edge.from === previous.id);
        const fromEarlier = edges.filter((edge) => edge !== fromPrevious);
        const { title, subtitle } = graphNodeTitle(node, type);
        const href = graphNodeHref(node);
        const external = node.type === "external";
        const card = (
          <span
            className={`block rounded border px-3 py-2 ${
              external ? "border-dashed border-primary/50 bg-accent/40" : node.type === "balance" ? "border-foreground/70 bg-card" : "border-border bg-card"
            } ${href ? "hover:border-ring" : ""}`}
          >
            <span className="flex flex-wrap items-baseline justify-between gap-x-3">
              <span className="text-sm font-medium">{title}</span>
              <span className="text-[11px] text-muted-foreground">{subtitle}</span>
            </span>
            <span className="mt-1 block">
              <NodeBody node={node} />
            </span>
            {fromEarlier.length > 0 && (
              <span className="mt-1 block text-[11px] text-muted-foreground">
                {fromEarlier.map((edge) => `${titleOf(edge.from)} ${EDGE_COPY[edge.kind]} this`).join(" · ")}
              </span>
            )}
          </span>
        );
        return (
          <li key={node.id} className="flex flex-col">
            {i > 0 && (
              <span className="flex items-center gap-2 py-1 pl-4 text-[11px] text-muted-foreground" aria-hidden={!fromPrevious}>
                <span aria-hidden className="text-muted-foreground">
                  ↓
                </span>
                {fromPrevious ? EDGE_COPY[fromPrevious.kind] : ""}
              </span>
            )}
            {href ? (
              href.startsWith("/") ? (
                <Link href={href}>{card}</Link>
              ) : (
                <a href={href}>{card}</a>
              )
            ) : (
              card
            )}
            {node.type === "external" && node.eventIds.length > 0 && (
              <span className="mt-0.5 flex flex-wrap gap-x-2 pl-3 text-[11px]">
                {node.eventIds.map((id, k) => (
                  <a key={id} href={`#event-${id}`} className="font-mono text-primary hover:underline">
                    {node.externalEventIds[k]}
                  </a>
                ))}
              </span>
            )}
          </li>
        );
      })}
    </ol>
  );
}
