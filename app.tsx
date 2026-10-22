// bb-plugin-omp-subagents — the BB frontend.
//
// Surfaces:
//  * A thread-header chip on every OMP thread: live subagent count + popover
//    roster (click to open the Hub panel for that thread).
//  * `OMP Agents` thread-panel action: the full Agent Hub panel — roster with
//    live progress, per-agent transcript, final output, and message injection.
//  * A nav panel that lists this machine's recent OMP sessions with their
//    subagent counts.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import "./src/theme.css";
import { activityLine } from "./src/activity.ts";
import { OPEN_AGENT_EVENT, parseHubParams, parseOpenAgentRequest } from "./src/open-agent.ts";
import { statusStyle } from "./src/status-style.ts";
import { startTimelineStrip } from "./src/timeline.tsx";
import {
  definePluginApp,
  useRealtime,
  useRealtimeConnectionState,
  useRpc,
  useBbContext,
  useBbNavigate,
  experimental_ThreadStatusGlyph as ThreadStatusGlyph,
  Markdown,
} from "@get-bb/plugin-sdk/app";
import { toast } from "sonner";
import type { rpcContract } from "./server";
import type {
  AgentSummary,
  SessionSummary,
  TranscriptEntry,
} from "./src/contract.ts";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";


const REALTIME_CHANGED = "agents-changed";

function useAgentRoster(threadId: string | null) {
  const rpc = useRpc<typeof rpcContract>();
  const [roster, setRoster] = useState<{
    sessionUuid: string | null;
    agents: AgentSummary[];
  } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const refetch = useCallback(() => {
    if (threadId === null) {
      setRoster(null);
      return;
    }
    setLoading(true);
    rpc
      .call("agents_list", { threadId })
      .then((result) => {
        setRoster({ sessionUuid: result.sessionUuid, agents: result.agents });
        setError(null);
      })
      .catch((cause: unknown) =>
        setError(cause instanceof Error ? cause.message : String(cause)),
      )
      .finally(() => setLoading(false));
  }, [rpc, threadId]);

  useEffect(() => {
    refetch();
  }, [refetch]);

  // Live progress: the server republishes host watch signals on this channel.
  useRealtime(REALTIME_CHANGED, () => refetch());
  // Signals are ephemeral and not replayed: reconcile after a reconnect.
  const connection = useRealtimeConnectionState();
  const wasConnected = useRef(false);
  useEffect(() => {
    if (connection === "connected") {
      if (wasConnected.current) refetch();
      wasConnected.current = true;
    }
  }, [connection, refetch]);

  return { roster, error, loading, refetch };
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
      <Icon name="UserRoundPlus" className="size-3.5" />
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
  projectId,
  isCompactViewport,
}: {
  threadId: string;
  projectId: string;
  isCompactViewport: boolean;
}) {
  const { roster } = useAgentRoster(threadId);
  const navigate = useBbNavigate();
  const agents = roster?.agents ?? [];
  const running = agents.filter((agent) => agent.status === "running").length;

  // A click on an agent in the timeline strip: open that agent's history here.
  useEffect(() => {
    const onOpen = (event: Event) => {
      const request = parseOpenAgentRequest(
        event instanceof CustomEvent ? event.detail : null,
      );
      if (request === null || request.threadId !== threadId) return;
      navigate.openThreadPanel({
        actionId: "hub",
        title: request.agentId,
        params: { threadId, projectId, agentId: request.agentId },
      });
    };
    window.addEventListener(OPEN_AGENT_EVENT, onOpen);
    return () => window.removeEventListener(OPEN_AGENT_EVENT, onOpen);
  }, [navigate, threadId, projectId]);

  if (agents.length === 0) return null;
  return (
    <AgentCountChip
      count={agents.length}
      running={running}
      compact={isCompactViewport}
      onClick={() =>
        navigate.openThreadPanel({
          actionId: "hub",
          title: "OMP Subagents",
          params: { threadId, projectId },
        })
      }
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

function AgentRow({
  agent,
  selected,
  onSelect,
}: {
  agent: AgentSummary;
  selected: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      aria-current={selected}
      className={cn(
        "w-full rounded-md border border-transparent px-3 py-2.5 text-left",
        "hover:border-border hover:bg-accent/50",
        selected && "border-border bg-accent",
      )}
    >
      <div className="flex items-center gap-2">
        <StatusIcon status={agent.status} />
        <span className="min-w-0 flex-1 truncate text-sm font-medium">
          {agent.id}
        </span>
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
              <Icon name="Wrench" className="mt-0.5 size-3 shrink-0 text-muted-foreground" />
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
          <Icon name={follow ? "ArrowDownToLine" : "ArrowUpToLine"} className="size-3.5" />
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
  const [tab, setTab] = useState<"transcript" | "output">("transcript");
  const [transcript, setTranscript] = useState<{
    entries: TranscriptEntry[];
    truncated: boolean;
  } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const realtimeTick = useState(0);

  useEffect(() => {
    rpc
      .call("agent_transcript", { threadId, agentId: agent.id })
      .then(setTranscript)
      .catch((cause: unknown) =>
        setError(cause instanceof Error ? cause.message : String(cause)),
      );
  }, [rpc, threadId, agent.id, realtimeTick[1]]);

  // Follow live updates while this agent is open.
  useRealtime(REALTIME_CHANGED, () => {
    if (agent.status === "running") {
      rpc
        .call("agent_transcript", { threadId, agentId: agent.id })
        .then(setTranscript)
        .catch(() => undefined);
    }
  });

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex items-center gap-2 border-b border-border px-3 py-2">
        <Button variant="ghost" size="sm" onClick={onBack}>
          <Icon name="ArrowLeft" className="size-3.5" />
          Roster
        </Button>
        <span className="min-w-0 flex-1 truncate text-sm font-medium">{agent.id}</span>
      </div>
      <div className="flex items-center gap-1 border-b border-border px-3 py-1.5">
        {(["transcript", "output"] as const).map((value) => (
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
        {error !== null ? (
          <EmptyState>{error}</EmptyState>
        ) : tab === "transcript" ? (
          transcript === null ? (
            <EmptyState>Loading transcript…</EmptyState>
          ) : (
            <TranscriptView entries={transcript.entries} truncated={transcript.truncated} />
          )
        ) : (
          <OutputView threadId={threadId} agentId={agent.id} />
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
    </div>
  );
}

function HubPanel({
  threadId,
  params,
}: {
  threadId: string;
  params: unknown;
}) {
  const hubParams = parseHubParams(params);
  const targetThreadId = hubParams.threadId ?? threadId;
  const rpc = useRpc<typeof rpcContract>();
  const { roster, error, loading, refetch } = useAgentRoster(targetThreadId);
  const [selectedId, setSelectedId] = useState<string | null>(hubParams.agentId);
  // The same tab can be re-pointed at another agent by new params.
  useEffect(() => {
    setSelectedId(hubParams.agentId);
  }, [hubParams.agentId]);
  const [injectText, setInjectText] = useState("");
  const [injecting, setInjecting] = useState(false);

  const selected = useMemo(
    () => roster?.agents.find((agent) => agent.id === selectedId) ?? null,
    [roster, selectedId],
  );

  const inject = async () => {
    const text = injectText.trim();
    if (text === "" || injecting) return;
    setInjecting(true);
    try {
      const result = await rpc.call("agent_inject", {
        threadId: targetThreadId,
        text,
      });
      setInjectText("");
      toast.success(`Message ${result.delivery} to the OMP session`);
      refetch();
    } catch (cause) {
      toast.error(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setInjecting(false);
    }
  };

  if (selected !== null) {
    return (
      <TranscriptPanel
        threadId={targetThreadId}
        agent={selected}
        onBack={() => setSelectedId(null)}
      />
    );
  }

  const agents = roster?.agents ?? [];
  const running = agents.filter((agent) => agent.status === "running").length;
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex items-center gap-2 border-b border-border px-3 py-2 text-xs text-muted-foreground">
        <span className="font-medium text-foreground">
          {agents.length} subagent{agents.length === 1 ? "" : "s"}
        </span>
        <span>· {running} running</span>
        {loading ? <Icon name="Loading" className="size-3 animate-spin" /> : null}
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto p-2">
        {error !== null ? (
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
            {agents.map((agent) => (
              <AgentRow
                key={agent.id}
                agent={agent}
                selected={false}
                onSelect={() => setSelectedId(agent.id)}
              />
            ))}
          </div>
        )}
      </div>
      <div className="border-t border-border p-2">
        <div className="flex items-center gap-2">
          <Input
            value={injectText}
            onChange={(event) => setInjectText(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") void inject();
            }}
            placeholder="Message the OMP session…"
            aria-label="Message the OMP session"
          />
          <Button
            size="sm"
            disabled={injectText.trim() === "" || injecting}
            onClick={() => void inject()}
          >
            <Icon name="SendHorizontal" className="size-3.5" />
            Send
          </Button>
        </div>
        <p className="mt-1 text-2xs text-muted-foreground">
          Sends through BB: starts a turn when idle, steers when running.
        </p>
      </div>
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

export default definePluginApp((app) => {
  app.slots.navPanel({
    id: "sessions",
    title: "OMP sessions",
    icon: "Bot",
    path: "sessions",
    component: SessionsPage,
  });

  app.slots.threadPanelAction({
    id: "hub",
    title: "OMP Subagents",
    icon: "Bot",
    layout: "flush",
    component: HubPanel,
  });

  app.slots.experimental_threadHeaderAction({
    id: "omp-subagents",
    title: "OMP Subagents",
    component: HeaderChip,
  });

  app.contentScripts.register({
    id: "timeline-strip",
    mount({ signal }) {
      startTimelineStrip(signal);
    },
  });
});
