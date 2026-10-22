// bb-plugin-omp-subagents — timeline subagent enrichment.
//
// bb renders each OMP `task` call as a generic "Ran tool" row: the item
// arguments carry the full spawn facts (per-agent names) but nothing draws
// them. This content script injects a live subagent strip below every such
// row in the timeline, in bb's own row vocabulary.
//
// The strip is driven by the same agents_list RPC the Hub panel uses, and
// disappears automatically when no listed agent is running.
import { createRoot, type Root } from "react-dom/client";
import { createElement, useEffect, useRef, useState } from "react";
import type { AgentSummary } from "./contract.ts";
import { activityLine } from "./activity.ts";
import { OPEN_AGENT_EVENT } from "./open-agent.ts";
import { statusStyle } from "./status-style.ts";
import { spawnedIdsFromOutput } from "./spawn.ts";
import { Icon } from "@/components/ui/icon";
import { cn } from "@/lib/utils";

/** The React fiber key prefix the React 19 build mangles onto DOM nodes. */
/** The id the build scopes this plugin's CSS utilities to. */
const PLUGIN_ID = "omp-subagents";

const REACT_FIBER_PREFIX = "__reactFiber$";

type TimelineRowObject = {
  id?: unknown;
  threadId?: unknown;
  workKind?: unknown;
  toolArgs?: unknown;
  output?: unknown;
};

type Fiber = {
  memoizedProps?: unknown;
  return?: unknown;
};

function fiberOf(element: Element): Fiber | undefined {
  const key = Object.keys(element).find((candidate) =>
    candidate.startsWith(REACT_FIBER_PREFIX),
  );
  if (key === undefined) return undefined;
  const fiber = (element as unknown as Record<string, unknown>)[key];
  return fiber !== null && typeof fiber === "object"
    ? (fiber as unknown as Fiber)
    : undefined;
}

function rowObjectFromProps(props: unknown): TimelineRowObject | null {
  if (props === null || typeof props !== "object") return null;
  const row = (props as Record<string, unknown>).row;
  return row !== null && typeof row === "object" ? (row as TimelineRowObject) : null;
}

function agentNamesFromTasks(toolArgs: unknown): string[] | null {
  if (toolArgs === null || typeof toolArgs !== "object") return null;
  const tasks = (toolArgs as Record<string, unknown>).tasks;
  if (!Array.isArray(tasks)) return null;
  const names: string[] = [];
  for (const item of tasks) {
    if (item === null || typeof item !== "object") continue;
    const name = (item as Record<string, unknown>).name;
    if (typeof name === "string" && name !== "") names.push(name);
  }
  return names.length > 0 ? names : null;
}

type TaskRow = {
  rowId: string;
  threadId: string;
  agentNames: string[];
};

/**
 * Walk the fiber chain from a row's button to the component whose props hold
 * the timeline row object; return it when the row is a `task` tool call.
 */
function readTaskRow(element: Element): TaskRow | null {
  let fiber: Fiber | undefined = fiberOf(element);
  for (let hop = 0; hop < 12 && fiber !== undefined; hop += 1) {
    for (const props of [fiber.memoizedProps]) {
      const row = rowObjectFromProps(props);
      if (
        row !== null &&
        typeof row.id === "string" &&
        typeof row.threadId === "string" &&
        row.workKind === "tool" &&
        row.id.includes(":tool:")
      ) {
        const requested = agentNamesFromTasks(row.toolArgs);
        if (requested !== null) {
          const spawned = spawnedIdsFromOutput(row.output);
          // The spawn result is authoritative; requested names are only the
          // fallback while the result has not arrived yet.
          const names = spawned.length > 0 ? spawned : requested;
          return { rowId: row.id, threadId: row.threadId, agentNames: names };
        }
      }
    }
    fiber =
      fiber.return !== null && typeof fiber.return === "object"
        ? (fiber.return as Fiber)
        : undefined;
  }
  return null;
}

// ---- The strip --------------------------------------------------------------

function AgentStripLine({ agent, threadId }: { agent: AgentSummary; threadId: string }) {
  const style = statusStyle(agent.status);
  return (
    <button
      type="button"
      onClick={() =>
        window.dispatchEvent(
          new CustomEvent(OPEN_AGENT_EVENT, { detail: { threadId, agentId: agent.id } }),
        )
      }
      title={`${style.label}: open ${agent.id} history`}
      aria-label={`Open ${agent.id} history (${style.label})`}
      className="flex min-w-0 max-w-full cursor-pointer items-center gap-1.5 rounded-sm px-1 py-px text-left hover:bg-accent/60 focus-visible:bg-accent/60 focus-visible:outline-none"
    >
      <span className={cn("shrink-0", style.toneClass)}>
        <Icon
          name={style.glyph}
          className={cn("size-3", style.spin && "animate-spin opacity-75")}
        />
      </span>
      <span className="shrink-0 text-xs font-medium text-foreground">
        {agent.id}
      </span>
      <span className="truncate text-2xs text-muted-foreground">
        {agent.status === "running" || agent.status === "failed"
          ? activityLine(agent)
          : agent.status === "interrupted"
            ? "interrupted"
            : `${agent.toolCount} tools`}
      </span>
    </button>
  );
}

type AgentsEnvelope = { ok: boolean; result?: { agents: AgentSummary[] } };

/** One mounted strip: polls its thread's roster until no agent runs. */
function TaskStrip({ row }: { row: TaskRow }) {
  const [agents, setAgents] = useState<AgentSummary[] | null>(null);

  useEffect(() => {
    let cancelled = false;
    const names = new Set(row.agentNames);
    const load = () => {
      fetch("/api/v1/plugins/omp-subagents/rpc/agents_list", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ threadId: row.threadId }),
      })
        .then((response) => response.json() as Promise<AgentsEnvelope>)
        .then((envelope) => {
          observe(envelope);
          if (cancelled || !envelope.ok || envelope.result === undefined) return;
          // Keep spawn order: the roster is sorted by activity, which would
          // make the lines swap places on every poll.
          const rank = new Map(row.agentNames.map((name, index) => [name, index]));
          setAgents(
            envelope.result.agents
              .filter((agent) => names.has(agent.id))
              .sort((a, b) => (rank.get(a.id) ?? 0) - (rank.get(b.id) ?? 0)),
          );
        })
        .catch(() => undefined);
    };
    let timer: ReturnType<typeof setInterval> | undefined;
    const schedule = (ms: number) => {
      if (timer !== undefined) clearInterval(timer);
      timer = setInterval(load, ms);
    };
    load();
    let anyRunning = true;
    const observe = (envelope: AgentsEnvelope) => {
      if (envelope.ok && envelope.result !== undefined) {
        const next = envelope.result.agents.some((agent) => agent.status === "running");
        if (next !== anyRunning) {
          anyRunning = next;
          schedule(next ? 4000 : 15000);
        }
      }
    };
    // fast while running, slow once settled (status flips still show)
    schedule(4000);
    return () => {
      cancelled = true;
      if (timer !== undefined) clearInterval(timer);
    };
  }, [row.threadId, row.agentNames]);
  if (agents === null) return null;
  return (
    <div
      role="status"
      className="omp-subagent-strip mx-1 mt-0.5 mb-1 flex flex-col items-start gap-0.5 border-l-2 border-border pl-2"
    >
      {agents.map((agent) => (
        <AgentStripLine key={agent.id} agent={agent} threadId={row.threadId} />
      ))}
    </div>
  );
}

// ---- Mounting ---------------------------------------------------------------

type Mount = {
  host: HTMLDivElement;
  root: Root;
};

export function startTimelineStrip(signal: AbortSignal): void {
  const mounts = new Map<Element, Mount>();

  const attach = (element: Element, taskRow: TaskRow) => {
    if (mounts.has(element)) return;
    const host = document.createElement("div");
    host.className = "omp-subagent-strip-host contents";
    // Plugin utilities are scoped to this attribute; the timeline lives outside
    // any plugin wrapper, so without it none of the strip's classes apply.
    host.setAttribute("data-bb-plugin", PLUGIN_ID);
    element.insertAdjacentElement("afterend", host);
    const root = createRoot(host);
    root.render(createElement(TaskStrip, { row: taskRow }));
    mounts.set(element, { host, root });
  };

  const scanRow = (rowEl: Element) => {
    if (!rowEl.getAttribute("data-timeline-row-id")?.includes(":tool:")) return;
    const button = rowEl.querySelector("button");
    if (button === null) return;
    const taskRow = readTaskRow(button);
    if (taskRow !== null) attach(button, taskRow);
  };

  const scanAll = () => {
    for (const rowEl of Array.from(document.querySelectorAll("[data-timeline-row-id]"))) {
      scanRow(rowEl);
    }
  };

  const pruneMounts = (removed: Element) => {
    for (const [element, mount] of mounts) {
      // A virtualized row that scrolled away leaves a detached anchor.
      if (element.isConnected || mount.host.isConnected) continue;
      mount.root.unmount();
      mount.host.remove();
      mounts.delete(element);
    }
    void removed;
  };

  const observer = new MutationObserver((records) => {
    for (const record of records) {
      if (record.type !== "childList") continue;
      for (const node of Array.from(record.addedNodes)) {
        if (node instanceof Element) {
          if (node.hasAttribute("data-timeline-row-id")) scanRow(node);
          for (const rowEl of Array.from(node.querySelectorAll("[data-timeline-row-id]"))) {
            scanRow(rowEl);
          }
        }
      }
      for (const node of Array.from(record.removedNodes)) {
        if (node instanceof Element) pruneMounts(node);
      }
    }
  });
  observer.observe(document.body, { childList: true, subtree: true });
  scanAll();

  signal.addEventListener(
    "abort",
    () => {
      observer.disconnect();
      for (const mount of mounts.values()) {
        mount.root.unmount();
        mount.host.remove();
      }
      mounts.clear();
    },
    { once: true },
  );
}
