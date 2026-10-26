// bb-plugin-omp-subagents — the BB frontend.
//
// Surfaces:
//  * A thread-header chip on every OMP thread: live subagent count + popover
//    roster (click to open the Hub panel for that thread).
//  * `OMP Subagents` thread tab: the full Agent Hub panel — roster with
//    live progress, per-agent transcript, final output, and message injection.
//  * A nav panel that lists this machine's recent OMP sessions with their
//    subagent counts.
import { useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import "./src/theme.css";
import { activityLine } from "./src/activity.ts";
import {
  OPEN_AGENT_EVENT,
  onHubOpen,
  openHubPanel,
  parseHubParams,
  parseOpenAgentRequest,
  requestOpenAgent,
  takePendingOpen,
} from "./src/open-agent.ts";
import { GLYPHS } from "./src/glyphs.ts";
import { splitPatchByFile } from "./src/patch-split.ts";
import {
  buildAgentTree,
  filterByStatus,
  flattenAgentTree,
  nextRunningAgent,
  rosterTotals,
  statusCounts,
} from "./src/roster-derive.ts";
import { rosterStore } from "./src/roster-store.ts";
import { syncRowStatuses } from "./src/row-status.ts";
import { statusStyle } from "./src/status-style.ts";
import { startTimelineStrip } from "./src/timeline.tsx";
import { useRoster } from "./src/use-roster.ts";
import {
  definePluginApp,
  useRealtime,
  useRealtimeConnectionState,
  useRpc,
  useBbContext,
  useBbNavigate,
  experimental_Diff as Diff,
  experimental_THREAD_ACTION_GROUPS,
  experimental_ThreadStatusGlyph as ThreadStatusGlyph,
  experimental_useSidebarThreads,
  Markdown,
} from "@get-bb/plugin-sdk/app";
import { toast } from "sonner";
import type { rpcContract } from "./server";
import type {
  AgentStatus,
  AgentSummary,
  SessionSummary,
  TranscriptEntry,
} from "./src/contract.ts";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";


const REALTIME_CHANGED = "agents-changed";

/**
 * Feeds the shared roster store from the plugin tree: the content script runs
 * outside the plugin's providers and cannot use the realtime hooks itself.
 * Mounted once per app window (`experimental_appOverlay`); renders nothing.
 */
function RosterFeed() {
  useRealtime(REALTIME_CHANGED, (payload) => rosterStore.handleChanged(payload));
  // Signals are ephemeral and not replayed: reconcile after a reconnect.
  const connection = useRealtimeConnectionState();
  const wasConnected = useRef(false);
  useEffect(() => {
    if (connection === "connected") {
      if (wasConnected.current) rosterStore.reconcile();
      wasConnected.current = true;
    }
  }, [connection]);

  // A subagent that ended in failure: say so, wherever the user is.
  const navigate = useBbNavigate();
  const { threadId: viewedThreadId } = useBbContext();
  const viewed = useRef(viewedThreadId);
  viewed.current = viewedThreadId;
  useEffect(
    () =>
      rosterStore.onFailure(({ threadId, agent }) => {
        toast.error(`${agent.id} failed`, {
          ...(agent.error === null ? {} : { description: agent.error }),
          action: {
            label: "Open",
            onClick: () => {
              if (viewed.current !== threadId) navigate.toThread(threadId);
              requestOpenAgent({ threadId, agentId: agent.id });
            },
          },
        });
      }),
    [navigate],
  );
  return null;
}

function relativeTime(ms: number | null): string {
  if (ms === null) return "";
  const seconds = Math.round((Date.now() - ms) / 1000);
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.round(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.round(seconds / 3600)}h ago`;
  return `${Math.round(seconds / 86400)}d ago`;
}

function formatDuration(seconds: number | null): string {
  if (seconds === null) return "";
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
  return `${Math.floor(seconds / 3600)}h ${Math.floor((seconds % 3600) / 60)}m`;
}

function formatTokens(n: number | null): string {
  if (n === null) return "—";
  if (n < 1000) return `${n}`;
  if (n < 1_000_000) return `${(n / 1000).toFixed(1)}k`;
  return `${(n / 1_000_000).toFixed(1)}M`;
}

function formatCost(cost: number | null): string {
  if (cost === null) return "—";
  return `$${cost < 1 ? cost.toFixed(3) : cost.toFixed(2)}`;
}

// ---- Status glyph: bb's own vocabulary -------------------------------------

// ---- Header chip -------------------------------------------------------------

function AgentCountChip({
  count,
  running,
  onClick,
  compact,
}: {
  count: number;
  running: number;
  onClick: () => void;
  compact: boolean;
}) {
  if (count === 0) return null;
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={`${count} subagents, ${running} running`}
      className={cn(
        "flex h-7 items-center gap-1.5 rounded-full border border-border px-2 text-2xs",
        running > 0
          ? "bg-accent text-foreground"
          : "text-muted-foreground hover:bg-accent hover:text-foreground",
      )}
    >
      <Icon name={GLYPHS.agentsChip} className="size-3.5" />
      {compact ? null : (
        <span className="truncate">
          {count} subagent{count === 1 ? "" : "s"}
          {running > 0 ? `, ${running} live` : ""}
        </span>
      )}
    </button>
  );
}

function HeaderChip({
  threadId,
  isCompactViewport,
}: {
  threadId: string;
  isCompactViewport: boolean;
}) {
  const { roster } = useRoster(threadId);
  const navigate = useBbNavigate();
  const agents = roster?.agents ?? [];
  const running = agents.filter((agent) => agent.status === "running").length;

  // A click on an agent in the timeline strip (or a failure toast's action):
  // open that agent's history here. A request that arrived before this header
  // mounted (the toast navigated to the thread first) is parked and taken now.
  useEffect(() => {
    const open = (agentId: string) =>
      openHubPanel((options) => navigate.openThreadPanel(options), { threadId, agentId });
    const parked = takePendingOpen(threadId);
    if (parked !== null) open(parked.agentId);
    const onOpen = (event: Event) => {
      const request = parseOpenAgentRequest(
        event instanceof CustomEvent ? event.detail : null,
      );
      if (request === null || request.threadId !== threadId) return;
      takePendingOpen(threadId);
      open(request.agentId);
    };
    window.addEventListener(OPEN_AGENT_EVENT, onOpen);
    return () => window.removeEventListener(OPEN_AGENT_EVENT, onOpen);
  }, [navigate, threadId]);

  if (agents.length === 0) return null;
  return (
    <AgentCountChip
      count={agents.length}
      running={running}
      compact={isCompactViewport}
      onClick={() => openHubPanel((options) => navigate.openThreadPanel(options), { threadId })}
    />
  );
}

// ---- Hub panel ---------------------------------------------------------------

function EmptyState({ children }: { children: ReactNode }) {
  return (
    <div
      role="status"
      className="rounded-lg border border-dashed border-border px-4 py-6 text-center text-sm text-muted-foreground"
    >
      {children}
    </div>
  );
}

function StatusIcon({ status, size = "size-3.5" }: { status: AgentSummary["status"]; size?: string }) {
  const style = statusStyle(status);
  return (
    <span className={cn("shrink-0", style.toneClass)} title={style.label}>
      <Icon
        name={style.glyph}
        aria-label={style.label}
        className={cn(size, style.spin && "animate-spin opacity-75")}
      />
    </span>
  );
}

function ReadOnlyBadge() {
  return (
    <span
      className="shrink-0 rounded-full border border-border px-1.5 text-2xs text-muted-foreground"
      title="This agent cannot modify files"
    >
      read-only
    </span>
  );
}

function AgentRow({
  agent,
  depth,
  selected,
  onSelect,
}: {
  agent: AgentSummary;
  depth: number;
  selected: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      aria-current={selected}
      style={depth > 0 ? { marginLeft: `${depth * 16}px`, width: `calc(100% - ${depth * 16}px)` } : undefined}
      className={cn(
        "w-full rounded-md border border-transparent px-3 py-2.5 text-left",
        "hover:border-border hover:bg-accent/50",
        selected && "border-border bg-accent",
        depth > 0 && "border-l-border",
      )}
    >
      <div className="flex items-center gap-2">
        <StatusIcon status={agent.status} />
        <span className="min-w-0 flex-1 truncate text-sm font-medium">
          {depth > 0 ? agent.id.slice(agent.id.lastIndexOf(".") + 1) : agent.id}
        </span>
        {agent.readOnly === true ? <ReadOnlyBadge /> : null}
        {agent.spawnedInLatestBatch ? (
          <span className="shrink-0 rounded-full border border-border px-1.5 text-2xs text-muted-foreground">
            new
          </span>
        ) : null}
        <span className="shrink-0 text-2xs text-muted-foreground">
          {formatDuration(agent.activeSeconds) || relativeTime(agent.lastActivityAtMs)}
        </span>
      </div>
      <div className="mt-1 flex items-center gap-2 text-2xs text-muted-foreground">
        {agent.agent !== null ? <span className="shrink-0">{agent.agent}</span> : null}
        {agent.resolvedModel !== null ? (
          <span className="shrink-0 truncate">{agent.resolvedModel.split("/").pop()}</span>
        ) : null}
        <span className="shrink-0">{agent.toolCount} tools</span>
        <span className="shrink-0">{formatTokens(agent.tokensIn ?? agent.contextTokens)} in</span>
        <span className="shrink-0">{formatCost(agent.costTotal)}</span>
      </div>
      <p className="mt-1 line-clamp-2 text-xs text-muted-foreground">
        {activityLine(agent)}
      </p>
    </button>
  );
}

function TranscriptView({
  entries,
  truncated,
}: {
  entries: TranscriptEntry[];
  truncated: boolean;
}) {
  const endRef = useRef<HTMLDivElement | null>(null);
  const [follow, setFollow] = useState(true);
  useEffect(() => {
    if (follow) endRef.current?.scrollIntoView({ block: "end" });
  }, [entries.length, follow]);
  if (entries.length === 0) {
    return <EmptyState>Transcript is empty.</EmptyState>;
  }
  return (
    <div className="space-y-3">
      {entries.map((entry, index) => {
        if (entry.role === "toolCall") {
          return (
            <div key={index} className="flex items-start gap-2 text-xs">
              <Icon name={GLYPHS.tool} className="mt-0.5 size-3 shrink-0 text-muted-foreground" />
              <div className="min-w-0 flex-1">
                <span className="font-medium">{entry.toolName ?? "tool"}</span>
                {entry.intent !== null ? (
                  <span className="text-muted-foreground"> — {entry.intent}</span>
                ) : null}
                {entry.summary !== "" ? (
                  <p className="truncate text-muted-foreground">{entry.summary}</p>
                ) : null}
              </div>
            </div>
          );
        }
        if (entry.role === "toolResult") {
          return (
            <div key={index} className="border-l-2 border-border pl-3 text-xs text-muted-foreground">
              <span className="font-medium">{entry.toolName ?? "result"}</span>
              {entry.text !== null ? <p className="mt-0.5 line-clamp-4">{entry.text}</p> : null}
            </div>
          );
        }
        if (entry.role === "irc") {
          return (
            <div
              key={index}
              className="rounded-md border border-border bg-muted/40 px-3 py-2 text-xs"
            >
              <span className="font-medium text-muted-foreground">IRC</span>
              {entry.text !== null ? <p className="mt-0.5 line-clamp-6">{entry.text}</p> : null}
            </div>
          );
        }
        if (entry.role === "notice") {
          return (
            <p key={index} className="text-center text-2xs text-muted-foreground">
              — {entry.summary} —
            </p>
          );
        }
        const isUser = entry.role === "user";
        return (
          <div
            key={index}
            className={cn(
              "rounded-lg border px-3 py-2 text-sm",
              isUser
                ? "ml-8 border-border bg-muted/40"
                : "mr-8 border-border bg-card",
            )}
          >
            {entry.text !== null ? <Markdown content={entry.text} /> : entry.summary}
          </div>
        );
      })}
      {truncated ? (
        <p className="text-center text-2xs text-muted-foreground">
          Transcript clipped to the last {entries.length} entries.
        </p>
      ) : null}
      <div ref={endRef} />
      <div className="sticky bottom-0 flex justify-end">
        <Button
          variant="ghost"
          size="sm"
          onClick={() => setFollow((value) => !value)}
        >
          <Icon name={follow ? GLYPHS.following : GLYPHS.paused} className="size-3.5" />
          {follow ? "Following" : "Paused"}
        </Button>
      </div>
    </div>
  );
}

function OutputView({ threadId, agentId }: { threadId: string; agentId: string }) {
  const rpc = useRpc<typeof rpcContract>();
  const [output, setOutput] = useState<{
    kind: string;
    content: string;
    truncated: boolean;
  } | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    rpc
      .call("agent_output", { threadId, agentId })
      .then(setOutput)
      .catch((cause: unknown) =>
        setError(cause instanceof Error ? cause.message : String(cause)),
      );
  }, [rpc, threadId, agentId]);
  if (error !== null) return <EmptyState>{error}</EmptyState>;
  if (output === null) return <EmptyState>Loading output…</EmptyState>;
  return (
    <div className="space-y-2">
      <p className="text-2xs text-muted-foreground">
        Final artifact ({output.kind}){output.truncated ? " — clipped" : ""}
      </p>
      {output.kind === "json" ? (
        <pre className="overflow-x-auto rounded-md border border-border bg-muted/40 p-3 text-xs">
          {output.content}
        </pre>
      ) : (
        <Markdown content={output.content} />
      )}
    </div>
  );
}

/** Send a message through BB; with `agentId` the OMP main agent forwards it to that subagent. */
function MessageBox({
  threadId,
  agentId,
  placeholder,
  hint,
}: {
  threadId: string;
  agentId: string | null;
  placeholder: string;
  hint: string;
}) {
  const rpc = useRpc<typeof rpcContract>();
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);

  const send = async () => {
    const body = text.trim();
    if (body === "" || sending) return;
    setSending(true);
    try {
      const result = await rpc.call("agent_inject", {
        threadId,
        text: body,
        ...(agentId === null ? {} : { agentId }),
      });
      setText("");
      toast.success(`Message ${result.delivery} to the OMP session`);
      rosterStore.request(threadId);
    } catch (cause) {
      toast.error(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSending(false);
    }
  };

  return (
    <div className="border-t border-border p-2">
      <div className="flex items-center gap-2">
        <Input
          value={text}
          onChange={(event) => setText(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") void send();
          }}
          placeholder={placeholder}
          aria-label={placeholder}
        />
        <Button size="sm" disabled={text.trim() === "" || sending} onClick={() => void send()}>
          <Icon name={GLYPHS.send} className="size-3.5" />
          Send
        </Button>
      </div>
      <p className="mt-1 text-2xs text-muted-foreground">{hint}</p>
    </div>
  );
}

function PatchView({ threadId, agentId }: { threadId: string; agentId: string }) {
  const rpc = useRpc<typeof rpcContract>();
  const [patch, setPatch] = useState<{ content: string; truncated: boolean } | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    rpc
      .call("agent_patch", { threadId, agentId })
      .then((result) => {
        if (!cancelled) setPatch(result);
      })
      .catch((cause: unknown) => {
        if (!cancelled) setError(cause instanceof Error ? cause.message : String(cause));
      });
    return () => {
      cancelled = true;
    };
  }, [rpc, threadId, agentId]);
  const files = useMemo(
    () => (patch === null ? [] : splitPatchByFile(patch.content)),
    [patch],
  );
  if (error !== null) return <EmptyState>{error}</EmptyState>;
  if (patch === null) return <EmptyState>Loading patch…</EmptyState>;
  if (files.length === 0) return <EmptyState>The patch is empty.</EmptyState>;
  return (
    <div className="space-y-3">
      {patch.truncated ? (
        <p className="text-2xs text-muted-foreground">Patch clipped — the end is not shown.</p>
      ) : null}
      {files.map((file, index) => (
        <div key={`${index}:${file.path}`} className="space-y-1">
          <p className="truncate text-xs font-medium">{file.path}</p>
          <Diff patch={file.patch} path={file.path} />
        </div>
      ))}
    </div>
  );
}

type PanelTab = "transcript" | "output" | "patch";

function TranscriptPanel({
  threadId,
  agent,
  onBack,
}: {
  threadId: string;
  agent: AgentSummary;
  onBack: () => void;
}) {
  const rpc = useRpc<typeof rpcContract>();
  const [requestedTab, setTab] = useState<PanelTab>("transcript");
  const [transcript, setTranscript] = useState<{
    entries: TranscriptEntry[];
    truncated: boolean;
  } | null>(null);
  const [error, setError] = useState<string | null>(null);

  const tabs: PanelTab[] = ["transcript"];
  if (agent.hasMd || agent.hasJson) tabs.push("output");
  if (agent.hasPatch) tabs.push("patch");
  // A tab whose artifact vanished from the roster falls back to the transcript.
  const tab = tabs.includes(requestedTab) ? requestedTab : "transcript";

  // Follow the agent through the shared store: refetch when its entry changes,
  // not on every raw realtime signal.
  useEffect(() => {
    let cancelled = false;
    rpc
      .call("agent_transcript", { threadId, agentId: agent.id })
      .then((result) => {
        if (cancelled) return;
        setTranscript(result);
        setError(null);
      })
      .catch((cause: unknown) => {
        if (!cancelled) setError(cause instanceof Error ? cause.message : String(cause));
      });
    return () => {
      cancelled = true;
    };
  }, [rpc, threadId, agent.id, agent.lastActivityAtMs, agent.status, agent.toolCount]);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="border-b border-border px-3 py-2">
        <div className="flex items-center gap-2">
          <Button variant="ghost" size="sm" onClick={onBack}>
            <Icon name={GLYPHS.back} className="size-3.5" />
            Roster
          </Button>
          <span className="min-w-0 flex-1 truncate text-sm font-medium">{agent.id}</span>
          {agent.readOnly === true ? <ReadOnlyBadge /> : null}
        </div>
        {agent.status === "failed" && agent.error !== null ? (
          <p
            role="alert"
            className="mt-2 line-clamp-4 rounded-md border border-border px-2 py-1.5 text-xs text-[color:var(--bb-omp-tone-error)]"
          >
            {agent.error}
          </p>
        ) : null}
      </div>
      <div className="flex items-center gap-1 border-b border-border px-3 py-1.5">
        {tabs.map((value) => (
          <button
            key={value}
            type="button"
            onClick={() => setTab(value)}
            className={cn(
              "rounded-md px-2 py-1 text-xs capitalize",
              tab === value
                ? "bg-accent text-foreground"
                : "text-muted-foreground hover:text-foreground",
            )}
          >
            {value}
          </button>
        ))}
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-3 py-3">
        {tab === "output" ? (
          <OutputView threadId={threadId} agentId={agent.id} />
        ) : tab === "patch" ? (
          <PatchView threadId={threadId} agentId={agent.id} />
        ) : error !== null ? (
          <EmptyState>{error}</EmptyState>
        ) : transcript === null ? (
          <EmptyState>Loading transcript…</EmptyState>
        ) : (
          <TranscriptView entries={transcript.entries} truncated={transcript.truncated} />
        )}
      </div>
      <div className="space-y-1 border-t border-border px-3 py-2 text-2xs text-muted-foreground">
        <p className="truncate">{agent.resolvedModel ?? agent.modelRole ?? "model unknown"}</p>
        <p>
          {agent.requestCount} requests · {agent.toolCount} tools ·{" "}
          {formatTokens(agent.tokensIn ?? agent.contextTokens)} tokens in ·{" "}
          {formatCost(agent.costTotal)}
        </p>
      </div>
      {agent.status === "running" ? (
        <MessageBox
          threadId={threadId}
          agentId={agent.id}
          placeholder={`Message ${agent.id}`}
          hint={`The OMP main agent forwards this to ${agent.id}.`}
        />
      ) : null}
    </div>
  );
}

const STATUS_FILTER_LABEL: Record<AgentStatus, string> = {
  running: "Running",
  failed: "Failed",
  finished: "Finished",
  interrupted: "Interrupted",
  partial: "Stopped",
};

function HubPanel({
  threadId,
  params,
}: {
  threadId: string;
  params: unknown;
}) {
  const hubParams = parseHubParams(params);
  const targetThreadId = hubParams.threadId ?? threadId;
  const { roster, error, loading } = useRoster(targetThreadId);
  const [selectedId, setSelectedId] = useState<string | null>(hubParams.agentId);
  const [requestedFilter, setFilter] = useState<AgentStatus | "all">("all");
  // bb hands one mounted panel the params of whichever hub tab is shown.
  useEffect(() => {
    setSelectedId(hubParams.agentId);
  }, [targetThreadId, hubParams.agentId]);
  // Opening the target this tab already shows only focuses it, with no new
  // params: show the target again (the agent after going back to the roster).
  useEffect(
    () =>
      onHubOpen((opened) => {
        if (opened.threadId === targetThreadId && opened.agentId === hubParams.agentId) {
          setSelectedId(opened.agentId);
        }
      }),
    [targetThreadId, hubParams.agentId],
  );

  const selected = useMemo(
    () => roster?.agents.find((agent) => agent.id === selectedId) ?? null,
    [roster, selectedId],
  );
  const agents = roster?.agents ?? [];
  const counts = useMemo(() => statusCounts(agents), [agents]);
  const totals = useMemo(() => rosterTotals(agents), [agents]);
  // A filter whose status left the roster shows everything again.
  const filter =
    requestedFilter !== "all" && counts.some((entry) => entry.status === requestedFilter)
      ? requestedFilter
      : "all";
  const rows = useMemo(
    () => flattenAgentTree(buildAgentTree(filterByStatus(agents, filter))),
    [agents, filter],
  );

  if (selected !== null) {
    return (
      <TranscriptPanel
        key={selected.id}
        threadId={targetThreadId}
        agent={selected}
        onBack={() => setSelectedId(null)}
      />
    );
  }

  const running = agents.filter((agent) => agent.status === "running").length;
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="space-y-1.5 border-b border-border px-3 py-2 text-xs text-muted-foreground">
        <div className="flex items-center gap-2">
          <span className="font-medium text-foreground">
            {agents.length} subagent{agents.length === 1 ? "" : "s"}
          </span>
          <span>· {running} running</span>
          {loading ? <Icon name={GLYPHS.spinner} className="size-3 animate-spin" /> : null}
        </div>
        {agents.length > 0 ? (
          <>
            <p>
              {formatTokens(totals.tokensIn)} in · {formatTokens(totals.tokensOut)} out ·{" "}
              {formatCost(totals.cost)}
            </p>
            <div className="flex flex-wrap gap-1" role="group" aria-label="Filter by status">
              {([{ status: "all" as const, count: agents.length }, ...counts]).map((entry) => (
                <button
                  key={entry.status}
                  type="button"
                  aria-pressed={filter === entry.status}
                  onClick={() => setFilter(entry.status)}
                  className={cn(
                    "rounded-full border border-border px-2 py-0.5 text-2xs",
                    filter === entry.status
                      ? "bg-accent text-foreground"
                      : "hover:bg-accent/50 hover:text-foreground",
                  )}
                >
                  {entry.status === "all" ? "All" : STATUS_FILTER_LABEL[entry.status]} {entry.count}
                </button>
              ))}
            </div>
          </>
        ) : null}
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto p-2">
        {error !== null && roster === null ? (
          <EmptyState>{error}</EmptyState>
        ) : roster === null ? (
          <EmptyState>Loading roster…</EmptyState>
        ) : roster.sessionUuid === null ? (
          <EmptyState>
            This thread is not an OMP session (provider must be acp-omp).
          </EmptyState>
        ) : agents.length === 0 ? (
          <EmptyState>
            No subagent transcripts on disk yet. Agents appear as they spawn.
          </EmptyState>
        ) : (
          <div className="space-y-1">
            {error !== null ? (
              <p role="alert" className="px-1 text-2xs text-[color:var(--bb-omp-tone-error)]">
                Refresh failed: {error}
              </p>
            ) : null}
            {rows.map(({ agent, depth }) => (
              <AgentRow
                key={agent.id}
                agent={agent}
                depth={depth}
                selected={false}
                onSelect={() => setSelectedId(agent.id)}
              />
            ))}
          </div>
        )}
      </div>
      <MessageBox
        threadId={targetThreadId}
        agentId={null}
        placeholder="Message the OMP session…"
        hint="Sends through BB: starts a turn when idle, steers when running."
      />
    </div>
  );
}

// ---- Nav panel: machine sessions ----------------------------------------------

function SessionsPage() {
  const rpc = useRpc<typeof rpcContract>();
  const context = useBbContext();
  const navigate = useBbNavigate();
  const [sessions, setSessions] = useState<SessionSummary[] | null>(null);
  const [total, setTotal] = useState(0);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    rpc
      .call("sessions_list", { projectId: context.projectId })
      .then((result) => {
        setSessions(result.sessions);
        setTotal(result.total);
        setError(null);
      })
      .catch((cause: unknown) =>
        setError(cause instanceof Error ? cause.message : String(cause)),
      );
  }, [rpc, context.projectId]);

  const openThread = (threadId: string) => navigate.toThread(threadId);

  return (
    <div className="h-full min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto box-border w-full max-w-3xl px-4 pb-4 pt-3 md:px-5 md:pt-4">
        <p className="text-sm text-muted-foreground">
          OMP sessions on this machine with subagent transcripts on disk.
        </p>
        <div className="mt-4">
          {error !== null ? (
            <EmptyState>{error}</EmptyState>
          ) : sessions === null ? (
            <EmptyState>Loading sessions…</EmptyState>
          ) : sessions.length === 0 ? (
            <EmptyState>No OMP sessions found under ~/.omp/agent/sessions.</EmptyState>
          ) : (
            <ul className="divide-y divide-border overflow-hidden rounded-lg border border-border bg-card">
              {sessions.map((session) => (
                <li key={session.sessionUuid}>
                  <button
                    type="button"
                    onClick={() => {
                      if (session.threadId !== null) openThread(session.threadId);
                    }}
                    className="flex w-full items-center gap-3 px-4 py-3 text-left hover:bg-accent/50"
                  >
                    <ThreadStatusGlyph
                      indicator={
                        session.subagentCount > 0 ? "background-agent" : "none"
                      }
                    />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm">
                        {session.title ?? session.sessionUuid.slice(-12)}
                      </span>
                      <span className="block truncate text-2xs text-muted-foreground">
                        {session.subagentCount} agents ·{" "}
                        {relativeTime(session.lastModifiedAt)} ·{" "}
                        {session.dir.replaceAll("-", "/")}
                      </span>
                    </span>
                    {session.subagentCount > 0 ? (
                      <span className="shrink-0 rounded-full border border-border px-1.5 text-2xs text-muted-foreground">
                        {session.subagentCount}
                      </span>
                    ) : null}
                  </button>
                </li>
              ))}
            </ul>
          )}
          {sessions !== null && total > sessions.length ? (
            <p className="mt-2 text-2xs text-muted-foreground">
              {total - sessions.length} older sessions not shown.
            </p>
          ) : null}
        </div>
      </div>
    </div>
  );
}

const OMP_PROVIDER_ID = "acp-omp";

/** Which of the threads on screen run on OMP (the menu item is OMP-only). */
function useOmpThreadIds({ threadIds }: { threadIds: readonly string[] }): ReadonlySet<string> {
  const { threads } = experimental_useSidebarThreads();
  return useMemo(
    () =>
      new Set(
        threads
          .filter((thread) => thread.providerId === OMP_PROVIDER_ID && threadIds.includes(thread.id))
          .map((thread) => thread.id),
      ),
    [threads, threadIds],
  );
}

/** The running agent last opened per thread, so "next" cycles through them. */
const lastOpenedRunning = new Map<string, string>();

export default definePluginApp((app) => {
  app.slots.navPanel({
    id: "sessions",
    title: "OMP sessions",
    icon: GLYPHS.roster,
    path: "sessions",
    component: SessionsPage,
  });

  app.slots.experimental_tab({
    context: { kind: "thread" },
    availability: "action",
    id: "hub",
    title: "OMP Subagents",
    icon: GLYPHS.roster,
    layout: "flush",
    component: HubPanel,
  });

  app.slots.experimental_threadHeaderAction({
    id: "omp-subagents",
    title: "OMP Subagents",
    component: HeaderChip,
  });

  // Mounted once per app window, outside the routes: the single place the
  // realtime feed, reconnect reconciliation and failure toasts are wired.
  app.slots.experimental_appOverlay({
    id: "roster-feed",
    component: RosterFeed,
  });

  app.slots.experimental_threadAction<ReadonlySet<string>>({
    id: "open-hub",
    title: "Open OMP subagents",
    icon: GLYPHS.roster,
    group: experimental_THREAD_ACTION_GROUPS.open,
    useData: useOmpThreadIds,
    item: ({ thread, data, navigate }) =>
      data.has(thread.id)
        ? {
            label: "Open OMP subagents",
            icon: GLYPHS.roster,
            run: () => {
              openHubPanel((options) => navigate.openThreadPanel(options), { threadId: thread.id });
            },
          }
        : null,
  });

  // The command context carries no provider, so "an OMP thread" means one the
  // roster store has loaded as an OMP session (every OMP thread header does).
  app.commands.register({
    id: "open-hub",
    title: "Open OMP subagents",
    isAvailable: ({ threadId }) =>
      threadId !== null && rosterStore.sessionUuidOf(threadId) !== null,
    run: ({ threadId, openPanel }) => {
      if (threadId === null) return;
      openHubPanel(openPanel, { threadId });
    },
  });

  app.commands.register({
    id: "open-next-running",
    title: "Open next running subagent",
    isAvailable: ({ threadId }) =>
      threadId !== null &&
      nextRunningAgent(rosterStore.getView(threadId).roster?.agents ?? [], null) !== null,
    run: ({ threadId, openPanel }) => {
      if (threadId === null) return;
      const agents = rosterStore.getView(threadId).roster?.agents ?? [];
      const next = nextRunningAgent(agents, lastOpenedRunning.get(threadId) ?? null);
      if (next === null) return;
      lastOpenedRunning.set(threadId, next.id);
      openHubPanel(openPanel, { threadId, agentId: next.id });
    },
  });

  app.contentScripts.register({
    id: "timeline-strip",
    mount(context) {
      startTimelineStrip(context.signal);
      // Older bb clients lack the row-status setter: feature-detect it.
      if (context.experimental_setThreadRowStatus !== undefined) {
        syncRowStatuses(
          rosterStore,
          (threadId, status) => context.experimental_setThreadRowStatus?.(threadId, status),
          context.signal,
        );
      }
    },
  });
});
