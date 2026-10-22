// Regression tests for host path confinement and the pure status parser.
// Run: npm test  (node:test + type stripping; no extra dependencies)
import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";

const tmp = await mkdtemp(join(tmpdir(), "omp-sessions-"));
process.env.OMP_SESSIONS_DIR = tmp;
const root = await realpath(tmp);
// A real escape target: a directory shaped like a session dir, outside the root.
const outside = await realpath(await mkdtemp(join(tmpdir(), "omp-outside-")));
const session = join(root, "-ws", "2026-01-01T00-00-00-000Z_aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa");

// The sessions root is read per call, so a static import is safe here.
import host from "../src/host.ts";
import { parseAgentFile, parseTranscript } from "../src/omp.ts";
import { spawnedIdsFromOutput } from "../src/spawn.ts";

type Handler = (input: unknown, context?: unknown) => Promise<unknown>;
const handlers = host.handlers as unknown as Record<string, Handler>;
const ctx = {
  experimental_watch: () => Promise.reject(new Error("watcher unavailable")),
  experimental_retainWorker: () => ({ dispose: async () => undefined }),
  experimental_emitSignal: async () => undefined,
};

before(async () => {
  await mkdir(session, { recursive: true });
  await writeFile(join(session, "AgentA.jsonl"), "{}\n");
  await writeFile(join(session, "AgentA.md"), "out\n");
  await writeFile(`${session}.jsonl`, "{}\n");
  await mkdir(join(session, "Parent"), { recursive: true });
  await writeFile(join(session, "Parent", "Parent.Child.jsonl"), "{}\n");
  await writeFile(join(session, "Parent", "Parent.Child.md"), "child out\n");
  await symlink(outside, join(root, "-ws", "link"));
  await writeFile(join(outside, "secret.md"), "TOP SECRET\n");
  await symlink(join(outside, "secret.md"), join(session, "Leak.md"));
});
after(async () => {
  await rm(root, { recursive: true, force: true });
  await rm(outside, { recursive: true, force: true });
});

describe("host confinement", () => {
  for (const [name, dir] of [
    ["outside root", "/etc"],
    ["dotdot escape", `${session}/../../..`],
    ["workspace level", join(root, "-ws")],
    ["root itself", root],
    ["symlink out of tree", join(root, "-ws", "link")],
    ["relative path", "relative/dir"],
  ] as const) {
    it(`rejects artifactsDir: ${name}`, async () => {
      await assert.rejects(() => handlers.agents_list!({ artifactsDir: dir }, ctx));
    });
  }

  for (const id of ["../../x", "a/b", ".hidden", "", "x".repeat(201)]) {
    it(`rejects agentId ${JSON.stringify(id.slice(0, 12))}`, async () => {
      // The guard's own error, not a downstream "file not found".
      await assert.rejects(
        () => handlers.agent_output!({ artifactsDir: session, agentId: id }),
        /invalid agent id/,
      );
      await assert.rejects(
        () => handlers.agent_transcript!({ artifactsDir: session, agentId: id }),
        /invalid agent id/,
      );
    });
  }

  it("reads a legitimate roster even when the watcher fails", async () => {
    const result = (await handlers.agents_list!({ artifactsDir: session }, ctx)) as {
      agents: Array<{ id: string }>;
    };
    assert.deepEqual(result.agents.map((a) => a.id).sort(), ["AgentA", "Parent.Child"]);
  });

  it("reads transcript and output of a nested agent from its subdirectory", async () => {
    const out = (await handlers.agent_output!({ artifactsDir: session, agentId: "Parent.Child" })) as { content: string };
    assert.match(out.content, /child out/);
    await handlers.agent_transcript!({ artifactsDir: session, agentId: "Parent.Child" });
  });

  it("does not follow a symlinked artifact out of the tree", async () => {
    await assert.rejects(
      () => handlers.agent_output!({ artifactsDir: session, agentId: "Leak" }),
      /No output artifact/,
    );
  });

  it("gives one generic error for missing and out-of-root paths", async () => {
    const messages: string[] = [];
    for (const dir of ["/etc", "/definitely/not/here"]) {
      try {
        await handlers.agents_list!({ artifactsDir: dir }, ctx);
      } catch (error) {
        messages.push(error instanceof Error ? error.message : String(error));
      }
    }
    assert.equal(new Set(messages).size, 1);
  });

  it("watch outside the root is refused, not started", async () => {
    const result = (await handlers.watch!({ path: "/etc" }, ctx)) as { watched: boolean };
    assert.equal(result.watched, false);
  });

  it("session_find resolves a bare uuid", async () => {
    const result = (await handlers.session_find!({
      uuid: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
    })) as { artifactsDir: string | null };
    assert.ok(result.artifactsDir !== null);
    assert.equal(await realpath(result.artifactsDir), session);
  });
});

describe("parseAgentFile status", () => {
  const artifacts = { hasMd: false, hasJson: false, hasPatch: false };
  const ts = (ms: number) => new Date(ms).toISOString();
  const assistant = (ms: number, stopReason: string) =>
    JSON.stringify({ type: "message", timestamp: ts(ms), message: { role: "assistant", stopReason, content: [] } });
  const exit = (ms: number) =>
    JSON.stringify({ type: "custom", customType: "session_exit", timestamp: ts(ms), data: { reason: "dispose" } });
  const now = 10_000_000;

  it("transient error then clean exit is finished", () => {
    const a = parseAgentFile("x", [assistant(now - 5000, "error"), assistant(now - 4000, "stop"), exit(now - 3000)], now, now, artifacts);
    assert.equal(a.status, "finished");
  });
  it("last turn error then exit is failed", () => {
    const a = parseAgentFile("x", [assistant(now - 4000, "stop"), assistant(now - 3000, "error"), exit(now - 2000)], now, now, artifacts);
    assert.equal(a.status, "failed");
  });
  it("no exit, fresh write is running", () => {
    const a = parseAgentFile("x", [assistant(now - 1000, "toolUse")], now - 1000, now, artifacts);
    assert.equal(a.status, "running");
  });
  it("no exit, stale write is partial", () => {
    const a = parseAgentFile("x", [assistant(now - 600_000, "toolUse")], now - 600_000, now, artifacts);
    assert.equal(a.status, "partial");
  });

  const toolCall = (ms: number) =>
    JSON.stringify({ type: "message", timestamp: ts(ms), message: { role: "assistant", stopReason: "toolUse", content: [{ type: "toolCall", name: "bash", arguments: { command: "x" } }] } });
  const toolResult = (ms: number) =>
    JSON.stringify({ type: "message", timestamp: ts(ms), message: { role: "toolResult", toolName: "bash", content: [{ type: "text", text: "ok" }] } });
  const finalText = (ms: number) =>
    JSON.stringify({ type: "message", timestamp: ts(ms), message: { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "done" }] } });
  const exitNoTime = JSON.stringify({ type: "custom", customType: "session_exit", data: { reason: "dispose" } });

  it("a parked subagent (final stop turn, no exit row) is finished, not partial", () => {
    const a = parseAgentFile("x", [toolCall(now - 700_000), toolResult(now - 699_000), finalText(now - 698_000)], now - 698_000, now, artifacts);
    assert.equal(a.status, "finished");
  });
  it("an aborted last turn is interrupted (killed agent)", () => {
    const aborted = JSON.stringify({ type: "message", timestamp: ts(now - 5000), message: { role: "assistant", stopReason: "aborted", content: [] } });
    const a = parseAgentFile("x", [toolCall(now - 9000), toolResult(now - 8000), aborted], now - 5000, now, artifacts);
    assert.equal(a.status, "interrupted");
  });
  it("a tool result after the last stop turn keeps the agent running", () => {
    const a = parseAgentFile("x", [finalText(now - 3000), toolResult(now - 1000)], now - 1000, now, artifacts);
    assert.equal(a.status, "running");
  });
  it("an orphaned agent has no runtime indicator", () => {
    const a = parseAgentFile("x", [toolCall(now - 900_000)], now - 900_000, now, artifacts);
    assert.equal(a.status, "partial");
    assert.equal(a.indicator, "none");
  });
  it("a second timestampless exit row does not erase the end time", () => {
    const a = parseAgentFile("x", [finalText(now - 4000), exit(now - 3000), exitNoTime], now, now, artifacts);
    assert.equal(a.status, "finished");
    assert.notEqual(a.endedAtMs, null);
  });
});

describe("parseTranscript", () => {
  it("keeps the newest entries when the feed overflows", () => {
    const lines = Array.from({ length: 700 }, (_, i) =>
      JSON.stringify({ type: "message", timestamp: new Date(1_000_000 + i * 1000).toISOString(), message: { role: "user", content: `m${i}` } }),
    );
    const result = parseTranscript(lines);
    assert.equal(result.truncated, true);
    assert.equal(result.entries.length, 500);
    assert.match(result.entries.at(-1)!.summary, /m699/);
    assert.match(result.entries[0]!.summary, /m200/);
  });
});

describe("spawnedIdsFromOutput", () => {
  it("reads the uniquified ids from the spawn result, not the requested names", () => {
    const output = JSON.stringify({ content: [{ type: "text", text: "Spawned 2 background agents using scout.\n- `TScout-2` (job `TScout-2`)\n- `TReviewer` (job `TReviewer`)\n\nTip: ..." }] });
    assert.deepEqual(spawnedIdsFromOutput(output), ["TScout-2", "TReviewer"]);
  });
  it("returns nothing for a non-spawn output", () => {
    assert.deepEqual(spawnedIdsFromOutput("Task failed preflight: bad schema"), []);
    assert.deepEqual(spawnedIdsFromOutput(null), []);
  });
});
