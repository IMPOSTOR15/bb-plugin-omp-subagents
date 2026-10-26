// Server-entry tests: thread binding, artifacts-dir caching, CLI parsing,
// addressed messages and the realtime relay, driven through the SDK's fake
// plugin host. Run: npm test  (node:test + type stripping)
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createFakePluginHost, makeThreadResponse } from "@get-bb/plugin-sdk/testing";
import plugin from "../server.ts";

const UUID = "11111111-1111-1111-1111-111111111111";
const OTHER_UUID = "22222222-2222-2222-2222-222222222222";
const DIR_A = "/sessions/-ws/2026-01-01T00-00-00-000Z_" + UUID;
const DIR_B = "/sessions/-ws/2026-01-02T00-00-00-000Z_" + UUID;

type HostCall = { method: string; input: Record<string, unknown>; hostId: string };

const agentRow = (id: string) => ({
  id,
  agent: null,
  modelRole: null,
  resolvedModel: null,
  readOnly: null,
  status: "running",
  task: `task of ${id}`,
  createdAtMs: null,
  endedAtMs: null,
  lastActivityAtMs: null,
  currentTool: null,
  currentToolIntent: null,
  toolCount: 2,
  requestCount: 1,
  tokensIn: null,
  tokensOut: null,
  contextTokens: null,
  costTotal: null,
  hasMd: false,
  hasJson: false,
  hasPatch: false,
  nested: [],
  activeSeconds: null,
  indicator: "runtime",
  error: null,
  spawnedInLatestBatch: false,
});

type World = {
  /** uuid -> artifacts dir, as session_find answers; mutable between calls. */
  sessionDirs: Map<string, string>;
  /** dirs the host's confinement accepts for agents_list and reads. */
  validDirs: Set<string>;
  /** identity events per thread; the newest is `[0]`. */
  identity: Map<string, string>;
  hostOf: Map<string, string>;
  provider: Map<string, string>;
  sent: Array<{ threadId: string; text: string }>;
  hostCalls: HostCall[];
  identityLookups: number;
  hostSessions: Map<string, Array<Record<string, unknown>>>;
  unreachable: Set<string>;
  rosterSize: number;
  outputText: string | null;
  transcriptRows: number;
};

async function setup() {
  const world: World = {
    sessionDirs: new Map([[UUID, DIR_A]]),
    validDirs: new Set([DIR_A]),
    identity: new Map([["th_1", UUID]]),
    hostOf: new Map([["th_1", "host-1"]]),
    provider: new Map([["th_1", "acp-omp"]]),
    sent: [],
    hostCalls: [],
    identityLookups: 0,
    hostSessions: new Map(),
    unreachable: new Set(),
    rosterSize: 2,
    outputText: null,
    transcriptRows: 1,
  };
  const { bb, harness } = createFakePluginHost({
    pluginId: "omp-subagents",
    sdk: {
      threads: {
        get: async ({ threadId }: { threadId: string }) =>
          makeThreadResponse({
            id: threadId,
            providerId: world.provider.get(threadId) ?? "acp-omp",
            environmentId: `env-${threadId}`,
          }),
        list: async () =>
          [...world.provider.keys()].map((id) =>
            makeThreadResponse({ id, providerId: world.provider.get(id)!, environmentId: `env-${id}` }),
          ),
        events: {
          list: async ({ threadId }: { threadId: string }) => {
            world.identityLookups += 1;
            const uuid = world.identity.get(threadId);
            return uuid === undefined
              ? []
              : [{ type: "thread/identity", threadId, data: { providerThreadId: uuid } }];
          },
        },
        send: async ({ threadId, input }: { threadId: string; input: Array<{ text: string }> }) => {
          world.sent.push({ threadId, text: input[0]!.text });
          return { delivery: "sent" };
        },
      },
      environments: {
        get: async ({ environmentId }: { environmentId: string }) => ({
          hostId: world.hostOf.get(environmentId.slice("env-".length)) ?? "",
          path: "/work",
        }),
      },
      system: { config: async () => ({ primaryHostId: "host-primary" }) },
      hosts: { list: async () => [] },
    },
    experimental_callHostRpc: async ({ method, input, hostId }: { method: string; input: Record<string, unknown>; hostId: string }) => {
      world.hostCalls.push({ method, input, hostId });
      if (world.unreachable.has(hostId)) throw new Error(`host ${hostId} offline`);
      switch (method) {
        case "session_find":
          return { artifactsDir: world.sessionDirs.get(input.uuid as string) ?? null };
        case "sessions_list":
          return { sessions: world.hostSessions.get(hostId) ?? [] };
        case "hostInfo":
          return { sessionsRoot: "/sessions", exists: true };
        default: {
          const dir = input.artifactsDir as string;
          if (!world.validDirs.has(dir)) throw new Error("artifactsDir is not a session directory");
          if (method === "agents_list") {
            const ids = ["Alpha", "Beta"];
            for (let i = ids.length; i < world.rosterSize; i += 1) ids.push(`Agent${i}`);
            return { agents: ids.slice(0, world.rosterSize).map(agentRow) };
          }
          if (method === "agent_transcript") {
            return {
              entries: Array.from({ length: world.transcriptRows }, (_, i) => ({ t: i, role: "assistant", summary: `row ${i} hello there`, text: null, toolName: null, intent: null, tokensIn: null, tokensOut: null, costTotal: null, model: null })),
              truncated: false,
            };
          }
          if (method === "agent_output") return { kind: "md", content: world.outputText ?? `output of ${input.agentId}`, truncated: false };
          if (method === "agent_patch") return { content: "diff", truncated: false };
          throw new Error(`unexpected host method ${method}`);
        }
      }
    },
  } as never);
  await plugin(bb);
  const calls = (method: string) => world.hostCalls.filter((call) => call.method === method);
  return { bb, harness, world, calls };
}

describe("thread binding and artifacts dir", () => {
  it("resolves the binding and the session dir once across many RPCs", async () => {
    const { harness, world, calls } = await setup();
    await harness.behavior.callRpc("agents_list", { threadId: "th_1" });
    await harness.behavior.callRpc("agents_list", { threadId: "th_1" });
    await harness.behavior.callRpc("agent_output", { threadId: "th_1", agentId: "Alpha" });
    await harness.behavior.callRpc("agent_transcript", { threadId: "th_1", agentId: "Alpha" });
    assert.equal(calls("session_find").length, 1, "the full sessions scan runs once, not per RPC");
    assert.equal(world.identityLookups, 1);
    assert.ok(calls("agents_list").every((call) => call.input.artifactsDir === DIR_A));
    assert.equal(calls("agents_list").length, 2);
  });

  it("answers with the bare session uuid and the dir the host reported", async () => {
    const { harness } = await setup();
    const result = (await harness.behavior.callRpc("agents_list", { threadId: "th_1" })) as {
      sessionUuid: string;
      artifactsDir: string;
      hostId: string;
      agents: unknown[];
    };
    assert.equal(result.sessionUuid, UUID);
    assert.equal(result.artifactsDir, DIR_A);
    assert.equal(result.hostId, "host-1");
    assert.equal(result.agents.length, 2);
  });

  it("re-resolves once when the host rejects the cached dir, and uses the new one", async () => {
    const { harness, world, calls } = await setup();
    await harness.behavior.callRpc("agents_list", { threadId: "th_1" });
    // OMP moved the session: the old dir is gone, session_find now answers DIR_B.
    world.validDirs = new Set([DIR_B]);
    world.sessionDirs.set(UUID, DIR_B);
    const result = (await harness.behavior.callRpc("agents_list", { threadId: "th_1" })) as {
      artifactsDir: string;
      agents: unknown[];
    };
    assert.equal(result.artifactsDir, DIR_B);
    assert.equal(result.agents.length, 2);
    assert.equal(calls("session_find").length, 2);
    // and the new dir is cached from here on
    await harness.behavior.callRpc("agents_list", { threadId: "th_1" });
    assert.equal(calls("session_find").length, 2);
  });

  it("surfaces the host's error when a re-resolve finds the same dir", async () => {
    const { harness, world, calls } = await setup();
    await harness.behavior.callRpc("agents_list", { threadId: "th_1" });
    world.validDirs = new Set();
    await assert.rejects(
      () => harness.behavior.callRpc("agent_output", { threadId: "th_1", agentId: "Alpha" }),
      /not a session directory/,
    );
    assert.equal(calls("session_find").length, 2, "exactly one re-resolve, no retry loop");
  });

  it("does not retry a failure on a freshly resolved dir", async () => {
    const { harness, world, calls } = await setup();
    world.validDirs = new Set();
    await assert.rejects(() => harness.behavior.callRpc("agent_output", { threadId: "th_1", agentId: "Alpha" }));
    assert.equal(calls("session_find").length, 1);
    assert.equal(calls("agent_output").length, 1);
  });

  it("a session that appears later is found on the next call, not cached as missing", async () => {
    const { harness, world, calls } = await setup();
    world.sessionDirs.clear();
    const empty = (await harness.behavior.callRpc("agents_list", { threadId: "th_1" })) as { sessionUuid: string | null; agents: unknown[] };
    assert.equal(empty.sessionUuid, null);
    assert.deepEqual(empty.agents, []);
    world.sessionDirs.set(UUID, DIR_A);
    const found = (await harness.behavior.callRpc("agents_list", { threadId: "th_1" })) as { sessionUuid: string | null };
    assert.equal(found.sessionUuid, UUID);
    assert.ok(calls("session_find").length >= 2);
  });

  it("a thread that is not an OMP thread has no roster and cannot be read", async () => {
    const { harness, world } = await setup();
    world.provider.set("th_x", "claude");
    world.hostOf.set("th_x", "host-1");
    const result = (await harness.behavior.callRpc("agents_list", { threadId: "th_x" })) as { sessionUuid: string | null };
    assert.equal(result.sessionUuid, null);
    await assert.rejects(
      () => harness.behavior.callRpc("agent_output", { threadId: "th_x", agentId: "Alpha" }),
      /not an OMP session/,
    );
  });

  it("picks up a new session identity after the thread moved on", async () => {
    const { harness, world, calls } = await setup();
    await harness.behavior.callRpc("agents_list", { threadId: "th_1" });
    // The thread was resumed under a different OMP session and emitted events.
    world.identity.set("th_1", OTHER_UUID);
    world.sessionDirs.set(OTHER_UUID, "/sessions/-ws/2026-01-03T00-00-00-000Z_" + OTHER_UUID);
    world.validDirs.add("/sessions/-ws/2026-01-03T00-00-00-000Z_" + OTHER_UUID);
    await harness.behavior.emitThreadEvent("experimental_thread.events" as never, {
      thread: makeThreadResponse({ id: "th_1" }),
      sequence: 9,
    } as never);
    const result = (await harness.behavior.callRpc("agents_list", { threadId: "th_1" })) as { sessionUuid: string };
    assert.equal(result.sessionUuid, OTHER_UUID);
    assert.equal(calls("session_find").length, 2);
  });

  it("keeps the binding when thread events arrive but the identity is unchanged", async () => {
    const { harness, world, calls } = await setup();
    await harness.behavior.callRpc("agents_list", { threadId: "th_1" });
    await harness.behavior.emitThreadEvent("experimental_thread.events" as never, {
      thread: makeThreadResponse({ id: "th_1" }),
      sequence: 2,
    } as never);
    await harness.behavior.callRpc("agents_list", { threadId: "th_1" });
    await harness.behavior.callRpc("agents_list", { threadId: "th_1" });
    assert.equal(calls("session_find").length, 1);
    assert.equal(world.identityLookups, 2, "one initial lookup, one re-check after the event");
  });

  it("caps the roster at maxAgentsPerThread and applies a changed setting without a reload", async () => {
    const { harness, world } = await setup();
    world.rosterSize = 30;
    const count = async () =>
      ((await harness.behavior.callRpc("agents_list", { threadId: "th_1" })) as { agents: unknown[] }).agents.length;
    assert.equal(await count(), 30, "default cap 200 keeps everything");
    await harness.behavior.setSettings({ maxAgentsPerThread: 10 });
    assert.equal(await count(), 10);
    await harness.behavior.setSettings({ maxAgentsPerThread: 25 });
    assert.equal(await count(), 25);
  });
});

describe("realtime relay", () => {
  it("publishes the bare uuid the host reported on the agents-changed channel", async () => {
    const { harness } = await setup();
    await harness.behavior.experimental_emitHostSignal("host-1", "changed", {
      sessionUuid: UUID,
      paths: ["/x/Alpha.jsonl"],
    });
    assert.deepEqual(harness.realtimeSignals, [{ channel: "agents-changed", payload: { sessionUuid: UUID } }]);
  });
});

describe("agent_inject", () => {
  it("sends the text verbatim to the main agent when no subagent is addressed", async () => {
    const { harness, world } = await setup();
    const result = await harness.behavior.callRpc("agent_inject", { threadId: "th_1", text: "  please stop  " });
    assert.deepEqual(result, { delivery: "sent" });
    assert.deepEqual(world.sent, [{ threadId: "th_1", text: "please stop" }]);
  });

  it("wraps an addressed message: forward to that subagent via write agent://<id>, then the text verbatim", async () => {
    const { harness, world } = await setup();
    await harness.behavior.callRpc("agent_inject", { threadId: "th_1", text: "use the v2 API\nnot v1", agentId: "Parent.Child" });
    const sent = world.sent[0]!.text;
    assert.match(sent, /`Parent\.Child`/);
    assert.match(sent, /write agent:\/\/Parent\.Child/);
    assert.match(sent, /Do not act on it yourself/);
    assert.ok(sent.endsWith("\n\nuse the v2 API\nnot v1"), "the message follows the instruction unchanged");
  });

  it("treats a null agentId as unaddressed", async () => {
    const { harness, world } = await setup();
    await harness.behavior.callRpc("agent_inject", { threadId: "th_1", text: "hi", agentId: null });
    assert.equal(world.sent[0]!.text, "hi");
  });

  it("rejects an agent id that is not a flat basename and sends nothing", async () => {
    const { harness, world } = await setup();
    await assert.rejects(() => harness.behavior.callRpc("agent_inject", { threadId: "th_1", text: "hi", agentId: "../etc" }));
    await assert.rejects(() => harness.behavior.callRpc("agent_inject", { threadId: "th_1", text: "hi", agentId: "a/b" }));
    assert.deepEqual(world.sent, []);
  });

  it("refuses a thread that is not an OMP thread", async () => {
    const { harness, world } = await setup();
    world.provider.set("th_x", "claude");
    await assert.rejects(() => harness.behavior.callRpc("agent_inject", { threadId: "th_x", text: "hi" }), /not an OMP session/);
    assert.deepEqual(world.sent, []);
  });
});

describe("agent_patch", () => {
  it("routes to the host with the cached dir and returns its content", async () => {
    const { harness, calls } = await setup();
    const result = await harness.behavior.callRpc("agent_patch", { threadId: "th_1", agentId: "Alpha" });
    assert.deepEqual(result, { content: "diff", truncated: false });
    assert.deepEqual(calls("agent_patch")[0]!.input, { artifactsDir: DIR_A, agentId: "Alpha" });
  });
});

describe("bb omp-subagents CLI", () => {
  it("inject keeps a --json that is part of the message, and replies in plain text", async () => {
    const { harness, world } = await setup();
    const result = await harness.behavior.runCli(["inject", "th_1", "please", "print", "--json", "output"]);
    assert.equal(result.exitCode, 0);
    assert.deepEqual(world.sent, [{ threadId: "th_1", text: "please print --json output" }]);
    assert.match(result.stdout ?? "", /^Message sent to th_1/);
  });

  it("inject keeps a leading --agent that sits inside the message", async () => {
    const { harness, world } = await setup();
    await harness.behavior.runCli(["inject", "th_1", "--agent", "Alpha", "go"]);
    assert.deepEqual(world.sent, [{ threadId: "th_1", text: "--agent Alpha go" }]);
  });

  it("a --json before the positional arguments switches inject to JSON output", async () => {
    const { harness } = await setup();
    const result = await harness.behavior.runCli(["inject", "--json", "th_1", "hello"]);
    assert.equal(result.exitCode, 0);
    assert.deepEqual(JSON.parse(result.stdout ?? ""), { delivery: "sent" });
  });

  it("inject --agent addresses a subagent through the main agent", async () => {
    const { harness, world } = await setup();
    const result = await harness.behavior.runCli(["inject", "--agent", "Alpha", "th_1", "check", "the", "tests"]);
    assert.equal(result.exitCode, 0);
    assert.match(world.sent[0]!.text, /write agent:\/\/Alpha/);
    assert.ok(world.sent[0]!.text.endsWith("\n\ncheck the tests"));
    assert.match(result.stdout ?? "", /Alpha/);
  });

  for (const [name, argv] of [
    ["inject without a message", ["inject", "th_1"]],
    ["inject without a thread", ["inject"]],
    ["inject with only whitespace", ["inject", "th_1", "  "]],
    ["inject --agent without an id", ["inject", "--agent"]],
    ["inject --agent with a bad id", ["inject", "--agent", "../x", "th_1", "hi"]],
    ["inject with an unknown option", ["inject", "--bogus", "th_1", "hi"]],
    ["agents without a thread", ["agents"]],
    ["transcript without an agent", ["transcript", "th_1"]],
    ["output without an agent", ["output", "th_1"]],
    ["an unknown command", ["frobnicate"]],
  ] as const) {
    it(`${name} returns usage with exit 1 and sends nothing`, async () => {
      const { harness, world } = await setup();
      const result = await harness.behavior.runCli([...argv]);
      assert.equal(result.exitCode, 1);
      assert.match(result.stderr ?? "", /Usage:/);
      assert.deepEqual(world.sent, []);
    });
  }

  it("--json works anywhere for the read commands", async () => {
    const { harness } = await setup();
    const before = await harness.behavior.runCli(["--json", "agents", "th_1"]);
    const after = await harness.behavior.runCli(["agents", "th_1", "--json"]);
    for (const result of [before, after]) {
      assert.equal(result.exitCode, 0);
      assert.equal((JSON.parse(result.stdout ?? "") as unknown[]).length, 2);
    }
  });

  it("list covers the primary machine and every machine with an OMP thread, once each", async () => {
    const { harness, world, calls } = await setup();
    world.hostOf.set("th_2", "host-2");
    world.provider.set("th_2", "acp-omp");
    world.identity.set("th_2", OTHER_UUID);
    world.sessionDirs.set(OTHER_UUID, "/s/-ws/t_" + OTHER_UUID);
    world.hostOf.set("th_3", "host-primary"); // same as the primary: not listed twice
    world.provider.set("th_3", "acp-omp");
    world.identity.set("th_3", "33333333-3333-3333-3333-333333333333");
    const session = (dir: string, mtime: number) => ({
      dir: "-ws",
      sessionUuid: dir,
      sessionFile: `/s/${dir}.jsonl`,
      artifactsDir: `/s/${dir}`,
      lastModifiedAtMs: mtime,
      agentCount: 1,
    });
    world.hostSessions.set("host-primary", [session("p", 1000)]);
    world.hostSessions.set("host-2", [session("two", 3000)]);
    world.hostSessions.set("host-1", [session("one", 2000)]);
    // bind the threads so the CLI knows their hosts
    for (const threadId of ["th_1", "th_2", "th_3"]) await harness.behavior.callRpc("hostStatus", { threadId });
    const result = await harness.behavior.runCli(["list", "--json"]);
    assert.equal(result.exitCode, 0);
    const listed = JSON.parse(result.stdout ?? "") as Array<{ sessionUuid: string; hostId: string }>;
    assert.deepEqual(listed.map((s) => [s.sessionUuid, s.hostId]), [["two", "host-2"], ["one", "host-1"], ["p", "host-primary"]]);
    const hosts = calls("sessions_list").map((call) => call.hostId).sort();
    assert.deepEqual(hosts, ["host-1", "host-2", "host-primary"]);
  });

  it("list still shows the reachable machines when one is offline, and names the failure", async () => {
    const { harness, world } = await setup();
    world.unreachable.add("host-primary");
    world.hostSessions.set("host-1", [{ dir: "-ws", sessionUuid: "one", sessionFile: "/s/one.jsonl", artifactsDir: "/s/one", lastModifiedAtMs: 5, agentCount: 3 }]);
    await harness.behavior.callRpc("hostStatus", { threadId: "th_1" });
    const result = await harness.behavior.runCli(["list"]);
    assert.equal(result.exitCode, 0);
    assert.match(result.stdout ?? "", /3 agents/);
    assert.match(result.stderr ?? "", /host-primary: host host-primary offline/);
  });

  it("list fails with exit 1 when no machine can be listed", async () => {
    const { harness, world } = await setup();
    world.unreachable.add("host-primary");
    const result = await harness.behavior.runCli(["list"]);
    assert.equal(result.exitCode, 1);
    assert.match(result.stderr ?? "", /Could not list sessions/);
  });
});

describe("agent tools", () => {
  it("registers exactly the two read-only tools, no inject", async () => {
    const { harness } = await setup();
    const names = harness.registrations.agentTools.map((tool: { name: string }) => tool.name).sort();
    assert.deepEqual(names, ["omp_subagent_read", "omp_subagents_roster"]);
  });

  it("the roster tool lists the current thread's agents", async () => {
    const { harness } = await setup();
    const result = await harness.behavior.callAgentTool("omp_subagents_roster", {}, { threadId: "th_1" } as never);
    assert.match(JSON.stringify(result), /Alpha/);
    assert.match(JSON.stringify(result), /Beta/);
  });

  it("the read tool returns the output by default and the transcript on request", async () => {
    const { harness } = await setup();
    const output = await harness.behavior.callAgentTool("omp_subagent_read", { agentId: "Alpha" }, { threadId: "th_1" } as never);
    assert.match(JSON.stringify(output), /output of Alpha/);
    const transcript = await harness.behavior.callAgentTool("omp_subagent_read", { agentId: "Alpha", part: "transcript" }, { threadId: "th_1" } as never);
    assert.match(JSON.stringify(transcript), /assistant: row 0 hello there/);
  });

  it("rejects an agent id that is a path", async () => {
    const { harness } = await setup();
    await assert.rejects(() => harness.behavior.callAgentTool("omp_subagent_read", { agentId: "../x" }, { threadId: "th_1" } as never));
  });

  it("clips a huge output to 20 000 characters and says it was cut", async () => {
    const { harness, world } = await setup();
    world.outputText = "x".repeat(60_000);
    const result = await harness.behavior.callAgentTool("omp_subagent_read", { agentId: "Alpha" }, { threadId: "th_1" } as never);
    const text = toolText(result);
    assert.ok(text.length <= 20_000, `got ${text.length}`);
    assert.match(text, /\[cut: first \d+ of 60000 characters shown\]/);
    assert.ok(text.startsWith("xxxx"), "an output keeps its opening");
  });

  it("clips a long transcript from the front, keeping the newest rows", async () => {
    const { harness, world } = await setup();
    world.transcriptRows = 2000;
    const result = await harness.behavior.callAgentTool("omp_subagent_read", { agentId: "Alpha", part: "transcript" }, { threadId: "th_1" } as never);
    const text = toolText(result);
    assert.ok(text.length <= 20_000, `got ${text.length}`);
    assert.match(text, /^\[cut: last/);
    assert.match(text, /row 1999 hello there/);
    assert.ok(!text.includes("row 0 hello there"));
  });

  it("does not cut a result that fits", async () => {
    const { harness } = await setup();
    const result = await harness.behavior.callAgentTool("omp_subagents_roster", {}, { threadId: "th_1" } as never);
    assert.ok(!toolText(result).includes("[cut"));
  });

  it("reads another thread when asked, and fails clearly for a non-OMP thread", async () => {
    const { harness, world } = await setup();
    world.provider.set("th_x", "claude");
    await assert.rejects(
      () => harness.behavior.callAgentTool("omp_subagent_read", { agentId: "Alpha", threadId: "th_x" }, { threadId: "th_1" } as never),
      /not an OMP session/,
    );
  });
});

/** The text of a tool result, whichever of the two result shapes it uses. */
function toolText(result: unknown): string {
  if (typeof result === "string") return result;
  const content = (result as { content?: Array<{ text?: string }> }).content ?? [];
  return content.map((part) => part.text ?? "").join("");
}
