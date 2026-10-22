// bb-plugin-omp-subagents — parser for OMP session JSONL rows.
//
// OMP layout on this machine (verified against omp 18.12.5):
//   ~/.omp/agent/sessions/<dir-encoded-workspace>/<timestamp>_<uuid>.jsonl
//   ~/.omp/agent/sessions/<dir>/<timestamp>_<uuid>/            artifacts dir
//     <Agent>.jsonl      subagent transcripts (nested agents one level down)
//     <Agent>.md/.json   final output artifacts; <Agent>.patch for isolated runs
//     local/, N.bash.log, async.log, …            shared tool artifacts
//
// Row shapes are untrusted input: every read is guarded, nothing is assumed.
import { spawnedIdsFromOutput } from "./spawn.ts";
import type {
  AgentStatus,
  AgentIndicator,
  AgentSummary,
  TranscriptEntry,
} from "./contract.ts";

export type OmpRow = Record<string, unknown>;

const TASK_MARKER = "Complete assignment thoroughly:\n";

/** An unfinished agent with no transcript write for this long is orphaned, not live. */
const LIVE_WINDOW_MS = 90_000;

function rowTime(row: OmpRow): number | null {
  const ts = row.timestamp ?? row.recordedAt;
  if (typeof ts !== "string") return null;
  const ms = Date.parse(ts);
  return Number.isFinite(ms) ? ms : null;
}

function textFromContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const part of content) {
    if (
      part !== null &&
      typeof part === "object" &&
      "text" in part &&
      typeof part.text === "string"
    ) {
      parts.push(part.text);
    }
  }
  return parts.join("");
}

function clip(text: string, max = 200): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`;
}

/**
 * A readable one-line summary of an assignment. OMP assignments follow
 * "# Target / # Change / # Acceptance"; the "Change" section says what the
 * agent does, so it leads, and the heading markers never reach the UI.
 */
export function taskBody(text: string): string {
  const at = text.indexOf(TASK_MARKER);
  const body = at === -1 ? text : text.slice(at + TASK_MARKER.length);
  const sections = new Map<string, string>();
  let name: string | null = null;
  let buffer: string[] = [];
  const flush = () => {
    if (name !== null) sections.set(name, buffer.join(" ").trim());
  };
  // Headings may sit on their own line or inline ("# Target x. # Change y.").
  for (const part of body.split(/(?:^|\s)#{1,3}\s+(?=[A-Za-z])/m)) {
    const match = /^(Target|Change|Acceptance|Goal|Constraints)\b[:\s]*([\s\S]*)$/.exec(part);
    if (match === null) {
      buffer.push(part.trim());
      continue;
    }
    flush();
    name = (match[1] ?? "").toLowerCase();
    buffer = [(match[2] ?? "").trim()];
  }
  flush();
  const lead = sections.get("change") ?? sections.get("goal") ?? sections.get("target");
  const picked = lead !== undefined && lead !== "" ? lead : body.replace(/#{1,3}\s+/g, "");
  return picked.replace(/\s+/g, " ").trim();
}

/** One short line from a tool's args: the path/command/query it worked on. */
function summarizeArgs(args: unknown): string {
  if (args === null || typeof args !== "object") return "";
  const record = args as Record<string, unknown>;
  const picked: string[] = [];
  for (const key of ["command", "path", "pattern", "code", "query", "content", "i"]) {
    const value = record[key];
    if (typeof value === "string" && value.trim() !== "") {
      picked.push(clip(value, 120));
      if (picked.length >= 2) break;
    }
  }
  return picked.join(" · ");
}

function readUsage(message: Record<string, unknown>): {
  input: number | null;
  output: number | null;
  costTotal: number | null;
  contextTokens: number | null;
} {
  const usage = message.usage;
  if (usage === null || typeof usage !== "object") {
    return { input: null, output: null, costTotal: null, contextTokens: null };
  }
  const u = usage as Record<string, unknown>;
  const input = typeof u.input === "number" ? u.input : null;
  const output = typeof u.output === "number" ? u.output : null;
  const cost = u.cost;
  let costTotal: number | null = null;
  if (cost !== null && typeof cost === "object") {
    const c = cost as Record<string, unknown>;
    costTotal = typeof c.total === "number" ? c.total : null;
  }
  const snapshot = message.contextSnapshot;
  let contextTokens: number | null = null;
  if (snapshot !== null && typeof snapshot === "object") {
    const s = snapshot as Record<string, unknown>;
    contextTokens = typeof s.promptTokens === "number" ? s.promptTokens : null;
  }
  return { input, output, costTotal, contextTokens };
}

/** Parse one subagent transcript into a roster row. */
export function parseAgentFile(
  id: string,
  lines: readonly string[],
  mtimeMs: number,
  now: number,
  artifacts: {
    hasMd: boolean;
    hasJson: boolean;
    hasPatch: boolean;
  },
): AgentSummary {
  let agent: string | null = null;
  let modelRole: string | null = null;
  let resolvedModel: string | null = null;
  let readOnly: boolean | null = null;
  let task = "";
  let createdAtMs: number | null = null;
  let endedAtMs: number | null = null;
  let lastActivityAtMs: number | null = null;
  let currentTool: string | null = null;
  let currentToolIntent: string | null = null;
  let toolCount = 0;
  let requestCount = 0;
  let tokensIn = 0;
  let tokensOut = 0;
  let costTotal = 0;
  let sawUsage = false;
  let sawCost = false;
  let lastContextTokens: number | null = null;
  let lastStopReason: string | null = null;
  let lastAssistantHadToolCall = false;
  let exitReason: string | null = null;

  for (const line of lines) {
    let row: OmpRow;
    try {
      row = JSON.parse(line) as OmpRow;
    } catch {
      continue;
    }
    if (row.type === "session_init") {
      if (typeof row.agent === "string") agent = row.agent;
      if (typeof row.modelRole === "string") modelRole = row.modelRole;
      if (typeof row.resolvedModel === "string") resolvedModel = row.resolvedModel;
      if (typeof row.readOnly === "boolean") readOnly = row.readOnly;
      if (typeof row.task === "string" && task === "") {
        task = clip(taskBody(row.task), 300);
      }
      createdAtMs ??= rowTime(row);
      continue;
    }
    if (row.type === "message") {
      const message = row.message;
      if (message === null || typeof message !== "object") continue;
      const m = message as Record<string, unknown>;
      const ms = rowTime(row);
      if (ms !== null) lastActivityAtMs = ms;
      if (m.role === "assistant") {
        requestCount += 1;
        const usage = readUsage(m);
        if (usage.input !== null || usage.output !== null) {
          sawUsage = true;
          tokensIn += usage.input ?? 0;
          tokensOut += usage.output ?? 0;
        }
        if (usage.costTotal !== null) {
          sawCost = true;
          costTotal += usage.costTotal;
        }
        if (usage.contextTokens !== null) lastContextTokens = usage.contextTokens;
        lastStopReason = typeof m.stopReason === "string" ? m.stopReason : null;
        lastAssistantHadToolCall = false;
        if (Array.isArray(m.content)) {
          for (const part of m.content) {
            if (part === null || typeof part !== "object") continue;
            const p = part as Record<string, unknown>;
            if (p.type === "toolCall") {
              lastAssistantHadToolCall = true;
              toolCount += 1;
              currentTool = typeof p.name === "string" ? p.name : currentTool;
              if (typeof p.intent === "string") {
                currentToolIntent = p.intent;
              } else if (currentTool !== null) {
                currentToolIntent = summarizeArgs(p.arguments) || null;
              }
            }
          }
        }
      } else if (m.role === "toolResult" || m.role === "user") {
        // Work resumed after the last assistant turn: it is not a final turn.
        lastAssistantHadToolCall = lastAssistantHadToolCall || m.role === "toolResult";
        if (m.role === "user") lastStopReason = null;
      }
      if (m.role === "user" && task === "") {
        const text = textFromContent(m.content);
        if (text !== "") task = clip(taskBody(text), 300);
      }
      continue;
    }
    if (row.type === "custom") {
      if (row.customType === "session_exit") {
        endedAtMs ??= rowTime(row) ?? lastActivityAtMs;
        const data = row.data;
        if (data !== null && typeof data === "object") {
          const d = data as Record<string, unknown>;
          if (typeof d.reason === "string") exitReason = d.reason;
        }
      }
      continue;
    }
    if (row.type === "custom_message" && row.customType === "irc:incoming") {
      // Steering input reopens a settled agent: it is live until it answers.
      const ms = rowTime(row);
      if (ms !== null) lastActivityAtMs = ms;
      lastStopReason = null;
      lastAssistantHadToolCall = false;
    }
  }

  const interrupted =
    exitReason !== null && exitReason !== "dispose" && exitReason !== "normal";
  // OMP keeps a finished subagent's session open (it parks it later), so a
  // clean end is the transcript's own final turn, not a `session_exit` row.
  const settledTurn =
    lastStopReason === "stop" && !lastAssistantHadToolCall;
  const aborted = lastStopReason === "aborted";
  const failedTurn = lastStopReason === "error" || lastStopReason === "length";
  const exited = endedAtMs !== null;
  const fresh = now - (lastActivityAtMs ?? mtimeMs) <= LIVE_WINDOW_MS;
  let status: AgentStatus;
  if (interrupted || aborted) status = "interrupted";
  else if (failedTurn && (exited || !fresh)) status = "failed";
  else if (exited || settledTurn) status = "finished";
  else if (fresh) status = "running";
  else status = "partial";

  const indicator: AgentIndicator =
    status === "running"
      ? "runtime"
      : status === "finished"
        ? "unread-success"
        : status === "failed"
          ? "unread-error"
          : status === "interrupted"
            ? "waiting-for-input"
            : "none";

  const from = createdAtMs ?? lastActivityAtMs ?? mtimeMs;
  const to = lastActivityAtMs ?? mtimeMs;
  const activeSeconds = to > from ? Math.round((to - from) / 1000) : null;

  return {
    id,
    agent,
    modelRole,
    resolvedModel,
    readOnly,
    status,
    task,
    createdAtMs,
    endedAtMs,
    lastActivityAtMs,
    currentTool,
    currentToolIntent,
    toolCount,
    requestCount,
    tokensIn: sawUsage ? tokensIn : null,
    tokensOut: sawUsage ? tokensOut : null,
    contextTokens: lastContextTokens,
    costTotal: sawCost ? Number(costTotal.toFixed(4)) : null,
    hasMd: artifacts.hasMd,
    hasJson: artifacts.hasJson,
    hasPatch: artifacts.hasPatch,
    nested: [],
    activeSeconds,
    indicator,
    spawnedInLatestBatch: false, // caller sets from the parent's newest batch
  };
}

/**
 * Agent ids assigned in the parent's most recent `task` toolCall. The spawn
 * result is authoritative (OMP renames a taken name to `Name-2`); the
 * requested names are the fallback while that result has not been written.
 */
export function parseLatestTaskAgents(lines: readonly string[]): Set<string> {
  let latestCallId: string | null = null;
  let latestNames: string[] = [];
  let latestSpawned: string[] = [];
  for (const line of lines) {
    let row: OmpRow;
    try {
      row = JSON.parse(line) as OmpRow;
    } catch {
      continue;
    }
    if (row.type !== "message") continue;
    const message = row.message;
    if (message === null || typeof message !== "object") continue;
    const m = message as Record<string, unknown>;
    if (m.role === "toolResult") {
      if (m.toolName === "task" && m.toolCallId === latestCallId) {
        latestSpawned = spawnedIdsFromOutput(textFromContent(m.content));
      }
      continue;
    }
    if (m.role !== "assistant" || !Array.isArray(m.content)) continue;
    for (const part of m.content) {
      if (part === null || typeof part !== "object") continue;
      const p = part as Record<string, unknown>;
      if (p.type !== "toolCall" || p.name !== "task") continue;
      latestCallId = typeof p.id === "string" ? p.id : null;
      latestSpawned = [];
      const args = p.arguments;
      const tasks =
        args !== null && typeof args === "object" && "tasks" in args
          ? (args as { tasks: unknown }).tasks
          : null;
      latestNames = Array.isArray(tasks)
        ? tasks.flatMap((item) => {
            if (item === null || typeof item !== "object" || !("name" in item)) return [];
            const name = (item as { name: unknown }).name;
            return typeof name === "string" && name !== "" ? [name] : [];
          })
        : [];
    }
  }
  return new Set(latestSpawned.length > 0 ? latestSpawned : latestNames);
}

const MAX_TRANSCRIPT_ENTRIES = 500;

/** Parse a subagent transcript into a chronological feed. */
export function parseTranscript(lines: readonly string[]): {
  entries: TranscriptEntry[];
  truncated: boolean;
} {
  const entries: TranscriptEntry[] = [];
  let truncated = false;

  for (const line of lines) {
    let row: OmpRow;
    try {
      row = JSON.parse(line) as OmpRow;
    } catch {
      continue;
    }
    const t = rowTime(row) ?? 0;
    if (row.type === "session_init") {
      entries.push({
        t,
        role: "notice",
        summary: "session start",
        text: null,
        toolName: null,
        intent: null,
        tokensIn: null,
        tokensOut: null,
        costTotal: null,
        model: null,
      });
      continue;
    }
    if (row.type === "message") {
      const message = row.message;
      if (message === null || typeof message !== "object") continue;
      const m = message as Record<string, unknown>;
      const usage = readUsage(m);
      if (m.role === "user") {
        const text = textFromContent(m.content);
        entries.push({
          t,
          role: "user",
          summary: clip(text, 300),
          text: clip(text, 2000),
          toolName: null,
          intent: null,
          tokensIn: null,
          tokensOut: null,
          costTotal: null,
          model: null,
        });
      } else if (m.role === "assistant" && Array.isArray(m.content)) {
        for (const part of m.content) {
          if (part === null || typeof part !== "object") continue;
          const p = part as Record<string, unknown>;
          if (p.type === "toolCall") {
            entries.push({
              t,
              role: "toolCall",
              summary: summarizeArgs(p.arguments),
              text: null,
              toolName: typeof p.name === "string" ? p.name : null,
              intent: typeof p.intent === "string" ? p.intent : null,
              tokensIn: null,
              tokensOut: null,
              costTotal: null,
              model: null,
            });
          } else if (p.type === "text" && typeof p.text === "string") {
            entries.push({
              t,
              role: "assistant",
              summary: clip(p.text, 300),
              text: clip(p.text, 4000),
              toolName: null,
              intent: null,
              tokensIn: usage.input,
              tokensOut: usage.output,
              costTotal: usage.costTotal,
              model: typeof m.model === "string" ? m.model : null,
            });
          }
        }
      } else if (m.role === "toolResult") {
        const text = textFromContent(m.content);
        entries.push({
          t,
          role: "toolResult",
          summary: clip(text, 160),
          text: clip(text, 4000),
          toolName: typeof m.toolName === "string" ? m.toolName : null,
          intent: null,
          tokensIn: null,
          tokensOut: null,
          costTotal: null,
          model: null,
        });
      }
      continue;
    }
    if (row.type === "custom_message" && row.customType === "irc:incoming") {
      const content = typeof row.content === "string" ? row.content : "";
      entries.push({
        t,
        role: "irc",
        summary: clip(content, 300),
        text: clip(content, 3000),
        toolName: null,
        intent: null,
        tokensIn: null,
        tokensOut: null,
        costTotal: null,
        model: null,
      });
      continue;
    }
    if (row.type === "custom" && row.customType === "session_exit") {
      const data = row.data;
      const reason =
        data !== null && typeof data === "object" && "reason" in data
          ? (data as { reason: unknown }).reason
          : null;
      entries.push({
        t,
        role: "notice",
        summary:
          typeof reason === "string" ? `session exit: ${reason}` : "session exit",
        text: null,
        toolName: null,
        intent: null,
        tokensIn: null,
        tokensOut: null,
        costTotal: null,
        model: null,
      });
    }
  }
  // A live viewer needs the newest activity: drop the oldest overflow.
  if (entries.length > MAX_TRANSCRIPT_ENTRIES) {
    truncated = true;
    entries.splice(0, entries.length - MAX_TRANSCRIPT_ENTRIES);
  }
  return { entries, truncated };
}

const MAX_OUTPUT_CHARS = 60000;

export function clipOutput(content: string): { content: string; truncated: boolean } {
  return content.length > MAX_OUTPUT_CHARS
    ? { content: content.slice(0, MAX_OUTPUT_CHARS), truncated: true }
    : { content, truncated: false };
}
