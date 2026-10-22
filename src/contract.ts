// bb-plugin-omp-subagents — shared schemas, the bb.host RPC contract, and the
// host signal set. One schema source feeds the host contract, the server RPC
// (frontend), and the frontend's type-only import.
import { defineRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod";

// ---- Shared shapes --------------------------------------------------------

export const agentStatusSchema = z.enum([
  "running",
  "finished",
  "interrupted",
  "failed",
  "partial",
]);

export const agentIndicatorSchema = z.enum([
  "runtime",
  "unread-success",
  "unread-error",
  "waiting-for-input",
  "none",
]);

export const agentSummarySchema = z.object({
  id: z.string(),
  agent: z.string().nullable(),
  modelRole: z.string().nullable(),
  resolvedModel: z.string().nullable(),
  readOnly: z.boolean().nullable(),
  status: agentStatusSchema,
  task: z.string(),
  createdAtMs: z.number().nullable(),
  endedAtMs: z.number().nullable(),
  lastActivityAtMs: z.number().nullable(),
  currentTool: z.string().nullable(),
  currentToolIntent: z.string().nullable(),
  toolCount: z.number().int().min(0),
  requestCount: z.number().int().min(0),
  tokensIn: z.number().nullable(),
  tokensOut: z.number().nullable(),
  contextTokens: z.number().nullable(),
  costTotal: z.number().nullable(),
  hasMd: z.boolean(),
  hasJson: z.boolean(),
  hasPatch: z.boolean(),
  nested: z.array(z.string()),
  activeSeconds: z.number().nullable(),
  indicator: agentIndicatorSchema,
  spawnedInLatestBatch: z.boolean(),
});

export const transcriptEntrySchema = z.object({
  t: z.number(),
  role: z.enum(["user", "assistant", "toolCall", "toolResult", "notice", "irc"]),
  summary: z.string(),
  text: z.string().nullable(),
  toolName: z.string().nullable(),
  intent: z.string().nullable(),
  tokensIn: z.number().nullable(),
  tokensOut: z.number().nullable(),
  costTotal: z.number().nullable(),
  model: z.string().nullable(),
});

export const sessionSummarySchema = z.object({
  /** Directory-encoded workspace path, e.g. "-Documents-projects-foo". */
  dir: z.string(),
  sessionUuid: z.string(),
  sessionFile: z.string(),
  /** The bb thread mapped to this OMP session; null when unmapped. */
  threadId: z.string().nullable(),
  title: z.string().nullable(),
  lastModifiedAt: z.number().nullable(),
  subagentCount: z.number().int().min(0),
  ageDays: z.number(),
  hostId: z.string(),
});

export type AgentStatus = z.infer<typeof agentStatusSchema>;
export type AgentIndicator = z.infer<typeof agentIndicatorSchema>;
export type AgentSummary = z.infer<typeof agentSummarySchema>;
export type TranscriptEntry = z.infer<typeof transcriptEntrySchema>;
export type SessionSummary = z.infer<typeof sessionSummarySchema>;

// ---- bb.host contract ------------------------------------------------------
//
// The host owns every read of the OMP session tree on the machine that holds
// it. `artifactsDir` is an absolute path the server entry resolved from a bb
// thread; `sessionsRoot` is the machine's `~/.omp/agent/sessions`.

export const agentIdSchema = z
  .string()
  .min(1)
  .max(200)
  .regex(
    /^[A-Za-z0-9][A-Za-z0-9._-]*$/,
    "agentId must be a flat file basename",
  );

export const hostContract = defineRpcContract({
  hostInfo: {
    input: z.null(),
    output: z.object({
      sessionsRoot: z.string(),
      exists: z.boolean(),
    }),
  },
  sessions_list: {
    input: z.object({ limit: z.number().int().min(1).max(200) }),
    output: z.object({
      sessions: z.array(
        z.object({
          dir: z.string(),
          sessionUuid: z.string(),
          sessionFile: z.string(),
          artifactsDir: z.string(),
          lastModifiedAtMs: z.number(),
          agentCount: z.number().int().min(0),
        }),
      ),
    }),
  },
  session_find: {
    input: z.object({ uuid: z.string().regex(/^[0-9a-f-]{36}$/) }),
    output: z.object({ artifactsDir: z.string().nullable() }),
  },
  agents_list: {
    input: z.object({ artifactsDir: z.string().min(1) }),
    output: z.object({
      agents: z.array(agentSummarySchema),
    }),
  },
  agent_transcript: {
    input: z.object({
      artifactsDir: z.string().min(1),
      agentId: agentIdSchema,
    }),
    output: z.object({
      entries: z.array(transcriptEntrySchema),
      truncated: z.boolean(),
    }),
  },
  agent_output: {
    input: z.object({
      artifactsDir: z.string().min(1),
      agentId: agentIdSchema,
    }),
    output: z.object({
      kind: z.enum(["md", "json"]),
      content: z.string(),
      truncated: z.boolean(),
    }),
  },
  watch: {
    input: z.object({ path: z.string().min(1) }),
    output: z.object({ watched: z.boolean() }),
  },
});

export type HostSessionsListResult = z.infer<
  (typeof hostContract)["sessions_list"]["output"]
>;

// Host → server signals. `changed` fires when files under a watched session
// artifacts dir change (live subagent progress); `sessionsChanged` fires for
// anything under the sessions root (new sessions, new agents).
export const hostSignals = {
  changed: {
    payload: z.object({
      sessionUuid: z.string(),
      paths: z.array(z.string()),
    }),
  },
  sessionsChanged: {
    payload: z.object({ paths: z.array(z.string()) }),
  },
} as const;
