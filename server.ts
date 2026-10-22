// bb-plugin-omp-subagents — the bb.server entry.
//
// Owns the mapping between bb threads (provider `acp-omp`) and OMP session
// artifact dirs on the thread's host: `thread/identity` events carry the OMP
// session UUID, and the workspace path gives the directory-encoded dir.
// All OMP filesystem reads go through this plugin's bb.host entry on the
// thread's own host; nothing here touches `node:fs`.
import {
  defineRpcContract,
  type BbPluginApi,
} from "@get-bb/plugin-sdk";
import { z } from "zod";
import {
  agentIdSchema,
  agentSummarySchema,
  sessionSummarySchema,
  transcriptEntrySchema,
  hostContract,
  hostSignals,
} from "./src/contract.ts";
import type {
  AgentSummary,
  HostSessionsListResult,
  SessionSummary,
} from "./src/contract.ts";

const OMP_PROVIDER_ID = "acp-omp";
const REALTIME_CHANGED = "agents-changed";

// ---- Frontend RPC contract --------------------------------------------------

export const rpcContract = defineRpcContract({
  agents_list: {
    input: z.object({ threadId: z.string().min(1) }),
    output: z.object({
      sessionUuid: z.string().nullable(),
      artifactsDir: z.string().nullable(),
      hostId: z.string().nullable(),
      agents: z.array(agentSummarySchema),
    }),
  },
  agent_transcript: {
    input: z.object({
      threadId: z.string().min(1),
      agentId: agentIdSchema,
    }),
    output: z.object({
      entries: z.array(transcriptEntrySchema),
      truncated: z.boolean(),
    }),
  },
  agent_output: {
    input: z.object({
      threadId: z.string().min(1),
      agentId: agentIdSchema,
    }),
    output: z.object({
      kind: z.enum(["md", "json"]),
      content: z.string(),
      truncated: z.boolean(),
    }),
  },
  agent_inject: {
    input: z.object({
      threadId: z.string().min(1),
      text: z.string().trim().min(1).max(8000),
    }),
    output: z.object({
      delivery: z.enum(["sent", "queued"]),
    }),
  },
  sessions_list: {
    input: z.object({ projectId: z.string().nullable() }),
    output: z.object({
      sessions: z.array(sessionSummarySchema),
      total: z.number().int().min(0),
    }),
  },
  hostStatus: {
    input: z.object({ threadId: z.string().nullable() }),
    output: z.object({
      sessionsRoot: z.string().nullable(),
      exists: z.boolean(),
      error: z.string().nullable(),
    }),
  },
});

// ---- bb thread → OMP session resolution --------------------------------------

type OmpBinding = {
  sessionUuid: string;
  hostId: string;
};

/** A server-side cache: threadId -> resolved OMP binding. */
const bindings = new Map<string, OmpBinding>();

async function resolveThread(
  bb: BbPluginApi,
  threadId: string,
): Promise<{ hostId: string; environmentPath: string | null } | null> {
  const detail = await bb.sdk.threads.get({ threadId });
  const { environmentId } = detail;
  if (environmentId === null) return null;
  const environment = await bb.sdk.environments.get({
    environmentId,
  });
  return {
    hostId: environment.hostId,
    environmentPath: environment.path ?? null,
  };
}

async function resolveBinding(
  bb: BbPluginApi,
  threadId: string,
): Promise<OmpBinding | null> {
  const cached = bindings.get(threadId);
  if (cached) return cached;
  const detail = await bb.sdk.threads.get({ threadId });
  if (detail.providerId !== OMP_PROVIDER_ID) return null;
  // The OMP session UUID: the newest `thread/identity` event for this thread.
  const events = await bb.sdk.threads.events.list({
    threadId,
    types: ["thread/identity"],
    order: "desc",
    limit: "1",
  });
  const identity = events[0];
  const sessionUuid =
    identity !== undefined && identity.type === "thread/identity"
      ? identity.data.providerThreadId
      : undefined;
  const env = await resolveThread(bb, threadId);
  if (sessionUuid === undefined || env === null || env.hostId === "") {
    bb.log.warn(
      `no binding for ${threadId}: uuid=${String(sessionUuid)} env=${String(env?.hostId ?? null)}`,
    );
    return null;
  }
  const binding: OmpBinding = {
    sessionUuid,
    hostId: env.hostId,
  };
  bindings.set(threadId, binding);
  return binding;
}

export default async function plugin(bb: BbPluginApi) {
  bb.log.info("loaded");

  const settings = bb.settings.define({
    maxAgentsPerThread: {
      type: "number",
      label: "Max agents per roster",
      default: 200,
      experimental_schema: z.number().int().min(10).max(500),
    },
  });
  const { maxAgentsPerThread } = await settings.get();

  const host = bb.hosts.experimental_client({
    contract: hostContract,
    experimental_signals: hostSignals,
  });

  // Host file-watch signals -> realtime channel -> the frontend refetches.
  host.experimental_onSignal("changed", ({ payload }) => {
    bb.realtime.publish(REALTIME_CHANGED, {
      sessionUuid: payload.sessionUuid,
    });
  });

  async function hostForThread(threadId: string): Promise<{
    hostId: string;
    sessionUuid: string;
  } | null> {
    const binding = await resolveBinding(bb, threadId);
    if (binding === null) return null;
    return { hostId: binding.hostId, sessionUuid: binding.sessionUuid };
  }

  /** Artifacts dir on the host, resolved by session uuid (no listing cap). */
  async function artifactsDirFor(
    hostId: string,
    sessionUuid: string,
  ): Promise<string | null> {
    const { artifactsDir } = await host.call(
      "session_find",
      { uuid: sessionUuid },
      { hostId, timeoutMs: 30000 },
    );
    return artifactsDir;
  }

  async function threadContext(threadId: string): Promise<{
    hostId: string;
    sessionUuid: string;
    artifactsDir: string | null;
  } | null> {
    const thread = await hostForThread(threadId);
    if (thread === null) {
      bb.log.warn(`threadContext(${threadId}): no binding`);
      return null;
    }
    const artifactsDir = await artifactsDirFor(thread.hostId, thread.sessionUuid);
    if (artifactsDir === null) {
      bb.log.warn(
        `threadContext(${threadId}): uuid ${thread.sessionUuid} not found in sessions_list`,
      );
      return null;
    }
    return { ...thread, artifactsDir };
  }

  const agentsList = async (threadId: string) => {
    const context = await threadContext(threadId);
    if (context === null || context.artifactsDir === null) {
      return {
        sessionUuid: null,
        artifactsDir: null,
        hostId: null,
        agents: [] satisfies AgentSummary[],
      };
    }
    const result = await host.call(
      "agents_list",
      { artifactsDir: context.artifactsDir },
      { hostId: context.hostId, timeoutMs: 30000 },
    );
    // Watch for live updates while the roster is open.
    await host.call(
      "watch",
      { path: context.artifactsDir },
      { hostId: context.hostId, timeoutMs: 30000 },
    );
    return {
      sessionUuid: context.sessionUuid,
      artifactsDir: context.artifactsDir,
      hostId: context.hostId,
      agents: result.agents.slice(0, maxAgentsPerThread),
    };
  };

  const agentTranscript = async (threadId: string, agentId: string) => {
    const context = await threadContext(threadId);
    if (context === null || context.artifactsDir === null) {
      throw new Error(`Thread ${threadId} is not an OMP session`);
    }
    return host.call(
      "agent_transcript",
      { artifactsDir: context.artifactsDir, agentId },
      { hostId: context.hostId, timeoutMs: 30000 },
    );
  };

  const agentOutput = async (threadId: string, agentId: string) => {
    const context = await threadContext(threadId);
    if (context === null || context.artifactsDir === null) {
      throw new Error(`Thread ${threadId} is not an OMP session`);
    }
    return host.call(
      "agent_output",
      { artifactsDir: context.artifactsDir, agentId },
      { hostId: context.hostId, timeoutMs: 30000 },
    );
  };

  const agentInject = async (threadId: string, text: string) => {
    // Route through bb's own dispatch: send-mode "auto" starts a turn on an
    // idle thread and queues/steers a running one — exactly what steering a
    // live OMP main agent needs.
    const detail = await bb.sdk.threads.get({ threadId });
    if (detail.providerId !== OMP_PROVIDER_ID) {
      throw new Error(`Thread ${threadId} is not an OMP session`);
    }
    const result = await bb.sdk.threads.send({
      threadId,
      mode: "auto",
      input: [{ type: "text", text, mentions: [] }],
    });
    return { delivery: result.delivery };
  };

  bb.rpc.register(rpcContract, {
    agents_list: ({ threadId }) => agentsList(threadId),

    agent_transcript: ({ threadId, agentId }) =>
      agentTranscript(threadId, agentId),

    agent_output: ({ threadId, agentId }) =>
      agentOutput(threadId, agentId),

    agent_inject: ({ threadId, text }) => agentInject(threadId, text),

    sessions_list: async ({ projectId }) => {
      const threads = (
        await bb.sdk.threads.list({
          ...(projectId === null ? {} : { projectId }),
          limit: 200,
        })
      ).filter((thread) => thread.providerId === OMP_PROVIDER_ID);
      // Bind each OMP thread (bounded parallelism), then ask each host once.
      const bound: Array<{ thread: (typeof threads)[number]; binding: OmpBinding }> = [];
      const queue = [...threads];
      await Promise.all(
        Array.from({ length: Math.min(6, queue.length) }, async () => {
          for (let thread = queue.shift(); thread; thread = queue.shift()) {
            const binding = await resolveBinding(bb, thread.id);
            if (binding !== null) bound.push({ thread, binding });
          }
        }),
      );
      const hostIds = [...new Set(bound.map(({ binding }) => binding.hostId))];
      const listings = new Map<string, HostSessionsListResult["sessions"]>();
      await Promise.all(
        hostIds.map(async (hostId) => {
          const list = await host.call(
            "sessions_list",
            { limit: 200 },
            { hostId, timeoutMs: 30000 },
          );
          listings.set(hostId, list.sessions);
        }),
      );
      const sessions: SessionSummary[] = [];
      for (const { thread, binding } of bound) {
        const match = listings
          .get(binding.hostId)
          ?.find((session) =>
            session.sessionUuid.endsWith(`_${binding.sessionUuid}`),
          );
        if (match === undefined) continue;
        sessions.push({
          dir: match.dir,
          sessionUuid: match.sessionUuid,
          sessionFile: match.sessionFile,
          threadId: thread.id,
          title: thread.title ?? null,
          lastModifiedAt: match.lastModifiedAtMs,
          subagentCount: match.agentCount,
          ageDays: (Date.now() - match.lastModifiedAtMs) / 86_400_000,
          hostId: binding.hostId,
        });
      }
      sessions.sort((a, b) => (b.lastModifiedAt ?? 0) - (a.lastModifiedAt ?? 0));
      return { sessions: sessions.slice(0, 40), total: sessions.length };
    },

    hostStatus: async ({ threadId }) => {
      const thread = threadId === null ? null : await hostForThread(threadId);
      const hostId = thread?.hostId ?? "";
      if (hostId === "") return { sessionsRoot: null, exists: false, error: null };
      try {
        const info = await host.call("hostInfo", null, { hostId, timeoutMs: 10000 });
        return { sessionsRoot: info.sessionsRoot, exists: info.exists, error: null };
      } catch (cause) {
        return {
          sessionsRoot: null,
          exists: false,
          error: cause instanceof Error ? cause.message : String(cause),
        };
      }
    },
  });

  // `bb omp-subagents` — what agents and shells use to inspect and steer.
  const usage = [
    "Usage:",
    "  bb omp-subagents list [--json]                        Machine sessions with subagent counts",
    "  bb omp-subagents agents <thread-id> [--json]          Roster for one OMP thread",
    "  bb omp-subagents transcript <thread-id> <agent> [--json]",
    "  bb omp-subagents output <thread-id> <agent> [--json]  Final output artifact",
    "  bb omp-subagents inject <thread-id> <message>         Send a message into an OMP thread",
  ].join("\n");
  bb.cli.register({
    name: "omp-subagents",
    summary: "Inspect and steer the subagents of OMP threads",
    commands: [
      { name: "list", summary: "List machine OMP sessions", usage: "bb omp-subagents list [--json]" },
      {
        name: "agents",
        summary: "Subagent roster for a thread",
        usage: "bb omp-subagents agents <thread-id> [--json]",
      },
      {
        name: "transcript",
        summary: "One subagent's transcript",
        usage: "bb omp-subagents transcript <thread-id> <agent> [--json]",
      },
      {
        name: "output",
        summary: "One subagent's final output",
        usage: "bb omp-subagents output <thread-id> <agent> [--json]",
      },
      {
        name: "inject",
        summary: "Send a message into an OMP thread",
        usage: "bb omp-subagents inject <thread-id> <message>",
      },
    ],
    async run(argv) {
      const json = argv.includes("--json");
      const args = argv.filter((arg) => arg !== "--json");
      const [command, ...rest] = args;
      const reply = (value: unknown, text: string) => ({
        exitCode: 0,
        stdout: json ? JSON.stringify(value, null, 2) : text,
      });
      switch (command) {
        case undefined:
        case "help":
        case "--help":
          return { exitCode: 0, stdout: usage };
        case "list": {
          const primary = await bb.sdk.system.config();
          const hostId = (primary as { primaryHostId?: string | null }).primaryHostId ?? "";
          if (hostId === "") return { exitCode: 1, stderr: "No enrolled host." };
          const list = await host.call(
            "sessions_list",
            { limit: 40 },
            { hostId, timeoutMs: 30000 },
          );
          const lines = list.sessions.map(
            (session) =>
              `${session.agentCount} agents  ${new Date(session.lastModifiedAtMs).toISOString()}  ${session.dir}/${session.sessionUuid}`,
          );
          return reply(
            list.sessions,
            lines.length === 0 ? "No OMP sessions." : lines.join("\n"),
          );
        }
        case "agents": {
          const threadId = rest[0];
          if (threadId === undefined) break;
          const { agents } = await agentsList(threadId);
          const lines = agents.map(
            (agent) =>
              `${agent.status.padEnd(10)} ${agent.id.padEnd(24)} ${agent.toolCount} tools  ${agent.task.slice(0, 80)}`,
          );
          return reply(
            agents,
            lines.length === 0 ? "No subagents." : lines.join("\n"),
          );
        }
        case "transcript": {
          const [threadId, agentId] = rest;
          if (threadId === undefined || agentId === undefined) break;
          const { entries } = await agentTranscript(threadId, agentId);
          return reply(
            entries,
            entries.map((e) => `${e.role}: ${e.summary}`).join("\n"),
          );
        }
        case "output": {
          const [threadId, agentId] = rest;
          if (threadId === undefined || agentId === undefined) break;
          const result = await agentOutput(threadId, agentId);
          return reply(result, result.content);
        }
        case "inject": {
          const [threadId, ...messageParts] = rest;
          const text = messageParts.join(" ").trim();
          if (threadId === undefined || text === "") break;
          const result = await agentInject(threadId, text);
          return reply(result, `Message ${result.delivery} to ${threadId}`);
        }
      }
      return { exitCode: 1, stderr: usage };
    },
  });

  bb.onDispose(() => {
    bindings.clear();
    bb.log.info("disposed");
  });
}
