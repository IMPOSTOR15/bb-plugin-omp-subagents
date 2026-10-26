// Pure derivations over a roster: the nesting tree, header totals, status
// counts/filter, a timeline row's agents, and the "next running" pick.
import type { AgentStatus, AgentSummary } from "./contract.ts";

export interface AgentNode {
  agent: AgentSummary;
  children: AgentNode[];
}

/**
 * Nest `Parent.Child` ids under `Parent`, recursively (`A.B.C` under `A.B`).
 * The parent is the id up to its last dot; an agent whose parent is not in the
 * list stays at top level. Sibling order is the input order.
 */
export function buildAgentTree(agents: readonly AgentSummary[]): AgentNode[] {
  const nodes = new Map<string, AgentNode>(
    agents.map((agent) => [agent.id, { agent, children: [] }]),
  );
  const roots: AgentNode[] = [];
  for (const agent of agents) {
    const node = nodes.get(agent.id);
    if (node === undefined) continue;
    const dot = agent.id.lastIndexOf(".");
    const parent = dot > 0 ? nodes.get(agent.id.slice(0, dot)) : undefined;
    if (parent === undefined || parent === node) roots.push(node);
    else parent.children.push(node);
  }
  return roots;
}

export interface AgentTreeRow {
  agent: AgentSummary;
  depth: number;
}

/** Depth-first rows (parent before its children) for rendering. */
export function flattenAgentTree(nodes: readonly AgentNode[], depth = 0): AgentTreeRow[] {
  return nodes.flatMap((node) => [
    { agent: node.agent, depth },
    ...flattenAgentTree(node.children, depth + 1),
  ]);
}

export interface RosterTotals {
  tokensIn: number | null;
  tokensOut: number | null;
  cost: number | null;
}

const sumKnown = (values: Array<number | null>): number | null => {
  let total: number | null = null;
  for (const value of values) {
    if (value !== null) total = (total ?? 0) + value;
  }
  return total;
};

/** Sums ignoring nulls; a column that is null for every agent stays null. */
export function rosterTotals(agents: readonly AgentSummary[]): RosterTotals {
  return {
    tokensIn: sumKnown(agents.map((agent) => agent.tokensIn)),
    tokensOut: sumKnown(agents.map((agent) => agent.tokensOut)),
    cost: sumKnown(agents.map((agent) => agent.costTotal)),
  };
}

const STATUS_ORDER: readonly AgentStatus[] = [
  "running",
  "failed",
  "finished",
  "interrupted",
  "partial",
];

/** Each status present in the roster, with its count, in a fixed order. */
export function statusCounts(
  agents: readonly AgentSummary[],
): Array<{ status: AgentStatus; count: number }> {
  return STATUS_ORDER.flatMap((status) => {
    const count = agents.filter((agent) => agent.status === status).length;
    return count > 0 ? [{ status, count }] : [];
  });
}

/** The agents a status filter shows; `"all"` shows everything. */
export function filterByStatus(
  agents: readonly AgentSummary[],
  filter: AgentStatus | "all",
): AgentSummary[] {
  return filter === "all" ? [...agents] : agents.filter((agent) => agent.status === filter);
}

/**
 * The agents of one timeline row, in the row's spawn order. The roster itself
 * is sorted by activity, which would make the strip lines swap on every poll.
 */
export function agentsForRow(
  agents: readonly AgentSummary[],
  rowAgentNames: readonly string[],
): AgentSummary[] {
  const rank = new Map(rowAgentNames.map((name, index) => [name, index]));
  return agents
    .filter((agent) => rank.has(agent.id))
    .sort((a, b) => (rank.get(a.id) ?? 0) - (rank.get(b.id) ?? 0));
}

/**
 * The running agent after `afterId` in roster order, wrapping around; the first
 * running agent when `afterId` is null or no longer running. Null when none run.
 */
export function nextRunningAgent(
  agents: readonly AgentSummary[],
  afterId: string | null,
): AgentSummary | null {
  const running = agents.filter((agent) => agent.status === "running");
  if (running.length === 0) return null;
  const at = afterId === null ? -1 : running.findIndex((agent) => agent.id === afterId);
  return running[(at + 1) % running.length] ?? null;
}
