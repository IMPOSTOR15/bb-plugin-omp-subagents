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
import { clipReport, rosterText, transcriptText } from "./src/text-report.ts";

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
  agent_patch: {
    input: z.object({
      threadId: z.string().min(1),
      agentId: agentIdSchema,
    }),
    output: z.object({
      content: z.string(),
      truncated: z.boolean(),
    }),
  },
  agent_inject: {
    input: z.object({
      threadId: z.string().min(1),
      text: z.string().trim().min(1).max(8000),
      // Address one live subagent: the OMP main agent is asked to forward it.
      agentId: agentIdSchema.nullable().optional(),
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
  /** The session's artifacts dir on the host; null until `session_find` finds it. */
  artifactsDir: string | null;
  /** The thread saw new events since the identity was last checked. */
  identityStale: boolean;
};

/** Where one thread's OMP session lives. */
type Located = { hostId: string; sessionUuid: string; artifactsDir: string };

/** Longest text an agent tool returns, notice included. */
const MAX_TOOL_CHARS = 20_000;

/**
 * `<id>` is the live subagent a message is for. OMP's main agent reaches a
 * subagent by writing to `agent://<id>`; it must relay, not act on the text.
 */
function addressedMessage(agentId: string, text: string): string {
  return [
    `Forward the message below to your live subagent \`${agentId}\`: send it with \`write agent://${agentId}\`. Do not act on it yourself.`,
    "",
    text,
  ].join("\n");
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
  let { maxAgentsPerThread } = await settings.get();
  settings.onChange((next) => {
    maxAgentsPerThread = next.maxAgentsPerThread;
  });

  const host = bb.hosts.experimental_client({
    contract: hostContract,
    experimental_signals: hostSignals,
  });

  // Host file-watch signals -> realtime channel -> the frontend refetches.
  // The host emits the bare OMP session uuid, the same one agents_list returns.
  host.experimental_onSignal("changed", ({ payload }) => {
    bb.realtime.publish(REALTIME_CHANGED, {
      sessionUuid: payload.sessionUuid,
    });
  });

  /** threadId -> resolved OMP binding. Per plugin load, so a reload starts clean. */
  const bindings = new Map<string, OmpBinding>();

  // The SDK's only per-thread event carries no event contents, so a new
  // `thread/identity` cannot be read from it. It does say the thread moved on:
  // mark the binding so its next use re-checks the identity (one cheap query)
  // instead of trusting it forever.
  bb.events.on("experimental_thread.events", ({ thread }) => {
    const binding = bindings.get(thread.id);
    if (binding !== undefined) binding.identityStale = true;
  });

  async function resolveThread(
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

  /** The OMP session UUID: the newest `thread/identity` event for the thread. */
  async function latestIdentity(threadId: string): Promise<string | undefined> {
    const events = await bb.sdk.threads.events.list({
      threadId,
      types: ["thread/identity"],
      order: "desc",
      limit: "1",
    });
    const identity = events[0];
    return identity !== undefined && identity.type === "thread/identity"
      ? identity.data.providerThreadId
      : undefined;
  }

  async function resolveBinding(threadId: string): Promise<OmpBinding | null> {
    const cached = bindings.get(threadId);
    if (cached) {
      if (!cached.identityStale) return cached;
      if ((await latestIdentity(threadId)) === cached.sessionUuid) {
        cached.identityStale = false;
        return cached;
      }
      bindings.delete(threadId);
    }
    const detail = await bb.sdk.threads.get({ threadId });
    if (detail.providerId !== OMP_PROVIDER_ID) return null;
    const sessionUuid = await latestIdentity(threadId);
    const env = await resolveThread(threadId);
    if (sessionUuid === undefined || env === null || env.hostId === "") {
      bb.log.warn(
        `no binding for ${threadId}: uuid=${String(sessionUuid)} env=${String(env?.hostId ?? null)}`,
      );
      return null;
    }
    const binding: OmpBinding = {
      sessionUuid,
      hostId: env.hostId,
      artifactsDir: null,
      identityStale: false,
    };
    bindings.set(threadId, binding);
    return binding;
  }

  async function hostForThread(threadId: string): Promise<{
    hostId: string;
    sessionUuid: string;
  } | null> {
    const binding = await resolveBinding(threadId);
    if (binding === null) return null;
    return { hostId: binding.hostId, sessionUuid: binding.sessionUuid };
  }

  /** Artifacts dir on the host, resolved by session uuid (no listing cap). */
  async function findArtifactsDir(binding: OmpBinding): Promise<string | null> {
    const { artifactsDir } = await host.call(
      "session_find",
      { uuid: binding.sessionUuid },
      { hostId: binding.hostId, timeoutMs: 30000 },
    );
    return artifactsDir;
  }

  /**
   * Binding plus artifacts dir; the dir is cached in the binding, so a session
   * scan runs once per binding, not once per RPC. `fromCache` says the binding
   * was reused rather than resolved by this call. `located` is null when the
   * session is not on the host (yet). The result is null when the thread is
   * not an OMP thread with an identity.
   */
  async function locate(
    threadId: string,
  ): Promise<{ located: Located | null; fromCache: boolean } | null> {
    const before = bindings.get(threadId);
    const binding = await resolveBinding(threadId);
    if (binding === null) {
      bb.log.warn(`locate(${threadId}): no binding`);
      return null;
    }
    const fromCache = before === binding;
    if (binding.artifactsDir === null) {
      const found = await findArtifactsDir(binding);
      if (found === null) {
        bb.log.warn(`locate(${threadId}): uuid ${binding.sessionUuid} not found on host`);
        return { located: null, fromCache };
      }
      binding.artifactsDir = found;
    }
    return {
      located: {
        hostId: binding.hostId,
        sessionUuid: binding.sessionUuid,
        artifactsDir: binding.artifactsDir,
      },
      fromCache,
    };
  }

  /**
   * Run `run` against the thread's session. The cached binding/dir may have
   * gone stale (identity changed, session moved), so it is re-resolved once
   * when the session is not found, or when `run` fails and the dir now resolves
   * elsewhere. A failure with the dir still correct is the real answer and is
   * rethrown. Null: not an OMP thread, or no session on its host.
   */
  async function onThread<T>(
    threadId: string,
    run: (located: Located) => Promise<T>,
  ): Promise<T | null> {
    const first = await locate(threadId);
    if (first === null) return null;
    if (first.located === null) {
      if (!first.fromCache) return null;
      bindings.delete(threadId);
      const retry = await locate(threadId);
      return retry?.located == null ? null : run(retry.located);
    }
    try {
      return await run(first.located);
    } catch (error) {
      if (!first.fromCache) throw error;
      bindings.delete(threadId);
      const retry = await locate(threadId);
      if (retry?.located == null || retry.located.artifactsDir === first.located.artifactsDir) {
        throw error;
      }
      return run(retry.located);
    }
  }

  const notOmp = (threadId: string) =>
    new Error(`Thread ${threadId} is not an OMP session`);

  const agentsList = async (threadId: string) => {
    const result = await onThread(threadId, async (located) => ({
      located,
      // Each call keeps the host's watch for this session alive.
      agents: (
        await host.call(
          "agents_list",
          { artifactsDir: located.artifactsDir },
          { hostId: located.hostId, timeoutMs: 30000 },
        )
      ).agents,
    }));
    if (result === null) {
      return {
        sessionUuid: null,
        artifactsDir: null,
        hostId: null,
        agents: [] satisfies AgentSummary[],
      };
    }
    return {
      sessionUuid: result.located.sessionUuid,
      artifactsDir: result.located.artifactsDir,
      hostId: result.located.hostId,
      agents: result.agents.slice(0, maxAgentsPerThread),
    };
  };

  const agentTranscript = async (threadId: string, agentId: string) => {
    const result = await onThread(threadId, (located) =>
      host.call(
        "agent_transcript",
        { artifactsDir: located.artifactsDir, agentId },
        { hostId: located.hostId, timeoutMs: 30000 },
      ),
    );
    if (result === null) throw notOmp(threadId);
    return result;
  };

  const agentOutput = async (threadId: string, agentId: string) => {
    const result = await onThread(threadId, (located) =>
      host.call(
        "agent_output",
        { artifactsDir: located.artifactsDir, agentId },
        { hostId: located.hostId, timeoutMs: 30000 },
      ),
    );
    if (result === null) throw notOmp(threadId);
    return result;
  };

  const agentPatch = async (threadId: string, agentId: string) => {
    const result = await onThread(threadId, (located) =>
      host.call(
        "agent_patch",
        { artifactsDir: located.artifactsDir, agentId },
        { hostId: located.hostId, timeoutMs: 30000 },
      ),
    );
    if (result === null) throw notOmp(threadId);
    return result;
  };

  const agentInject = async (
    threadId: string,
    text: string,
    agentId: string | null | undefined,
  ) => {
    const addressee =
      agentId === null || agentId === undefined
        ? null
        : agentIdSchema.parse(agentId);
    // Route through bb's own dispatch: send-mode "auto" starts a turn on an
    // idle thread and queues/steers a running one — exactly what steering a
    // live OMP main agent needs.
    const detail = await bb.sdk.threads.get({ threadId });
    if (detail.providerId !== OMP_PROVIDER_ID) {
      throw notOmp(threadId);
    }
    const result = await bb.sdk.threads.send({
      threadId,
      mode: "auto",
      input: [
        {
          type: "text",
          text: addressee === null ? text : addressedMessage(addressee, text),
          mentions: [],
        },
      ],
    });
    return { delivery: result.delivery };
  };

  bb.rpc.register(rpcContract, {
    agents_list: ({ threadId }) => agentsList(threadId),

    agent_transcript: ({ threadId, agentId }) =>
      agentTranscript(threadId, agentId),

    agent_output: ({ threadId, agentId }) =>
      agentOutput(threadId, agentId),

    agent_patch: ({ threadId, agentId }) => agentPatch(threadId, agentId),

    agent_inject: ({ threadId, text, agentId }) =>
      agentInject(threadId, text, agentId),

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
            const binding = await resolveBinding(thread.id);
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

  // ---- Agent tools: read-only, mirroring the CLI read paths -------------------

  bb.agents.registerTool({
    name: "omp_subagents_roster",
    description:
      "List the subagents of an OMP thread: status, tool count and task per agent. Read-only. Defaults to the current thread.",
    presentation: {
      label: {
        pending: "Reading OMP subagents",
        completed: "Read OMP subagents",
      },
    },
    parameters: z.object({
      threadId: z
        .string()
        .min(1)
        .optional()
        .describe("BB thread id of an OMP thread; default: this thread"),
    }),
    async execute({ threadId }, ctx) {
      const target = threadId ?? ctx.threadId;
      const result = await agentsList(target);
      if (result.sessionUuid === null) {
        throw new Error(`Thread ${target} has no OMP session on its host`);
      }
      return clipReport(rosterText(result.agents), MAX_TOOL_CHARS, "head");
    },
  });

  bb.agents.registerTool({
    name: "omp_subagent_read",
    description:
      "Read one OMP subagent's final output or its transcript (agent ids come from omp_subagents_roster). Read-only. Defaults to the current thread.",
    presentation: {
      label: {
        pending: "Reading OMP subagent",
        completed: "Read OMP subagent",
      },
    },
    parameters: z.object({
      agentId: agentIdSchema.describe("Agent id from the roster, e.g. ReviewAuth or Parent.Child"),
      part: z
        .enum(["output", "transcript"])
        .default("output")
        .describe("output: final result artifact; transcript: chronological feed, newest last"),
      threadId: z
        .string()
        .min(1)
        .optional()
        .describe("BB thread id of an OMP thread; default: this thread"),
    }),
    async execute({ agentId, part, threadId }, ctx) {
      const target = threadId ?? ctx.threadId;
      if (part === "transcript") {
        const { entries, truncated } = await agentTranscript(target, agentId);
        const note = truncated ? "[older transcript rows omitted]\n" : "";
        return clipReport(`${note}${transcriptText(entries)}`, MAX_TOOL_CHARS, "tail");
      }
      const result = await agentOutput(target, agentId);
      const note = result.truncated ? "\n[output truncated at the source]" : "";
      return clipReport(`${result.content}${note}`, MAX_TOOL_CHARS, "head");
    },
  });

  // ---- CLI ------------------------------------------------------------------------

  // `bb omp-subagents` — what agents and shells use to inspect and steer.
  const usage = [
    "Usage:",
    "  bb omp-subagents list [--json]                        Sessions on every machine, with subagent counts",
    "  bb omp-subagents agents <thread-id> [--json]          Roster for one OMP thread",
    "  bb omp-subagents transcript <thread-id> <agent> [--json]",
    "  bb omp-subagents output <thread-id> <agent> [--json]  Final output artifact",
    "  bb omp-subagents inject [--json] [--agent <id>] <thread-id> <message>",
    "                                                        Send a message into an OMP thread; with --agent the",
    "                                                        main agent forwards it to that live subagent.",
    "                                                        Everything after <thread-id> is the message.",
  ].join("\n");

  /** Machines to list: every connected one, the primary, and each bound thread's. */
  async function listingHosts(): Promise<string[]> {
    const ids = new Set<string>();
    const primary = await bb.sdk.system.config();
    const primaryId = (primary as { primaryHostId?: string | null }).primaryHostId ?? "";
    if (primaryId !== "") ids.add(primaryId);
    for (const known of await bb.sdk.hosts.list()) {
      if (known.status === "connected" && known.lifecycle.phase === "active") ids.add(known.id);
    }
    for (const binding of bindings.values()) ids.add(binding.hostId);
    return [...ids];
  }

  bb.cli.register({
    name: "omp-subagents",
    summary: "Inspect and steer the subagents of OMP threads",
    commands: [
      { name: "list", summary: "List OMP sessions on every machine", usage: "bb omp-subagents list [--json]" },
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
        summary: "Send a message into an OMP thread, or to one of its live subagents",
        usage: "bb omp-subagents inject [--json] [--agent <id>] <thread-id> <message>",
      },
    ],
    async run(argv) {
      const args = [...argv];
      let json = false;
      while (args[0] === "--json") {
        json = true;
        args.shift();
      }
      const command = args.shift();
      const usageError = (message?: string) => ({
        exitCode: 1,
        stderr: message === undefined ? usage : `${message}\n${usage}`,
      });
      const reply = (value: unknown, text: string) => ({
        exitCode: 0,
        stdout: json ? JSON.stringify(value, null, 2) : text,
      });
      if (command !== "inject" && args.includes("--json")) {
        json = true;
        for (let at = args.indexOf("--json"); at !== -1; at = args.indexOf("--json")) {
          args.splice(at, 1);
        }
      }
      switch (command) {
        case undefined:
        case "help":
        case "--help":
          return { exitCode: 0, stdout: usage };
        case "list": {
          const hostIds = await listingHosts();
          if (hostIds.length === 0) return { exitCode: 1, stderr: "No enrolled host." };
          const settled = await Promise.allSettled(
            hostIds.map(async (hostId) => ({
              hostId,
              sessions: (
                await host.call("sessions_list", { limit: 40 }, { hostId, timeoutMs: 30000 })
              ).sessions,
            })),
          );
          const merged = settled
            .flatMap((result) => (result.status === "fulfilled" ? [result.value] : []))
            .flatMap(({ hostId, sessions }) => sessions.map((session) => ({ ...session, hostId })))
            .sort((a, b) => b.lastModifiedAtMs - a.lastModifiedAtMs)
            .slice(0, 40);
          const failures = settled.flatMap((result, index) =>
            result.status === "rejected"
              ? [`${hostIds[index]}: ${result.reason instanceof Error ? result.reason.message : String(result.reason)}`]
              : [],
          );
          if (merged.length === 0 && failures.length === hostIds.length) {
            return { exitCode: 1, stderr: `Could not list sessions:\n${failures.join("\n")}` };
          }
          const lines = merged.map(
            (session) =>
              `${session.agentCount} agents  ${new Date(session.lastModifiedAtMs).toISOString()}  ${session.dir}/${session.sessionUuid}` +
              (hostIds.length > 1 ? `  [${session.hostId}]` : ""),
          );
          const result = reply(merged, lines.length === 0 ? "No OMP sessions." : lines.join("\n"));
          return failures.length === 0
            ? result
            : { ...result, stderr: `Skipped machines:\n${failures.join("\n")}` };
        }
        case "agents": {
          const threadId = args[0];
          if (threadId === undefined) break;
          const { agents } = await agentsList(threadId);
          return reply(agents, rosterText(agents));
        }
        case "transcript": {
          const [threadId, agentId] = args;
          if (threadId === undefined || agentId === undefined) break;
          const { entries } = await agentTranscript(threadId, agentId);
          return reply(entries, transcriptText(entries));
        }
        case "output": {
          const [threadId, agentId] = args;
          if (threadId === undefined || agentId === undefined) break;
          const result = await agentOutput(threadId, agentId);
          return reply(result, result.content);
        }
        case "inject": {
          // Options come before <thread-id>; everything after it is the message,
          // verbatim — including a literal "--json" or "--agent".
          let agentId: string | null = null;
          while (args[0]?.startsWith("--")) {
            const option = args.shift();
            if (option === "--json") json = true;
            else if (option === "--agent") {
              const value = args.shift();
              const parsed = agentIdSchema.safeParse(value);
              if (!parsed.success) return usageError("--agent needs a valid agent id.");
              agentId = parsed.data;
            } else return usageError(`Unknown option ${option}.`);
          }
          const threadId = args.shift();
          const text = args.join(" ").trim();
          if (threadId === undefined || text === "") break;
          const result = await agentInject(threadId, text, agentId);
          return reply(
            result,
            `Message ${result.delivery} to ${agentId === null ? threadId : `${agentId} via ${threadId}`}`,
          );
        }
      }
      return usageError();
    },
  });

  bb.onDispose(() => {
    bindings.clear();
    bb.log.info("disposed");
  });
}
