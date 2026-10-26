// Sidebar thread-row status: derived from a thread's roster and pushed through
// the content-script context's optional `experimental_setThreadRowStatus`.
import type { AgentSummary } from "./contract.ts";
import { GLYPHS } from "./glyphs.ts";
import type { RosterStore, RosterView } from "./roster-store.ts";

export interface RowStatus {
  icon: string;
  label: string;
  tone: "running" | "error";
}

export type SetThreadRowStatus = (threadId: string, status: RowStatus | null) => void;

const subagents = (count: number): string => `${count} subagent${count === 1 ? "" : "s"}`;

/**
 * Running agents win; otherwise failures in the latest spawn batch (older
 * failures are history, not news); otherwise nothing.
 */
export function deriveRowStatus(agents: readonly AgentSummary[]): RowStatus | null {
  const running = agents.filter((agent) => agent.status === "running").length;
  if (running > 0) {
    return { icon: GLYPHS.running, label: `${subagents(running)} running`, tone: "running" };
  }
  const failed = agents.filter(
    (agent) => agent.status === "failed" && agent.spawnedInLatestBatch,
  ).length;
  if (failed > 0) {
    return { icon: GLYPHS.failed, label: `${subagents(failed)} failed`, tone: "error" };
  }
  return null;
}

/**
 * Keep every thread's row status in step with the store. Only changes are
 * forwarded; on abort every status this call set is cleared.
 */
export function syncRowStatuses(
  store: RosterStore,
  setStatus: SetThreadRowStatus,
  signal: AbortSignal,
): void {
  const applied = new Map<string, RowStatus>();
  const apply = (threadId: string, view: RosterView) => {
    if (view.roster === null) return;
    const next = deriveRowStatus(view.roster.agents);
    const previous = applied.get(threadId);
    if (next === null) {
      if (previous === undefined) return;
      applied.delete(threadId);
      setStatus(threadId, null);
      return;
    }
    if (previous?.label === next.label && previous.tone === next.tone) return;
    applied.set(threadId, next);
    setStatus(threadId, next);
  };
  for (const [threadId, view] of store.entries()) apply(threadId, view);
  const unsubscribe = store.subscribeAll(apply);
  signal.addEventListener(
    "abort",
    () => {
      unsubscribe();
      for (const threadId of applied.keys()) setStatus(threadId, null);
      applied.clear();
    },
    { once: true },
  );
}
