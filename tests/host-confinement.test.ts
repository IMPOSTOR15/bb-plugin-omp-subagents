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
import { parseAgentFile, parseLatestTaskAgents, parseTranscript, taskBody } from "../src/omp.ts";
import { activityLine } from "../src/activity.ts";
import { OPEN_AGENT_EVENT, parseHubParams, parseOpenAgentRequest } from "../src/open-agent.ts";
import { GLYPHS, VERIFIED_BB_GLYPHS } from "../src/glyphs.ts";
import { statusStyle } from "../src/status-style.ts";
import { readHead, readLines } from "../src/bounded-read.ts";
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
  await mkdir(join(session, "Deep", "Deep.Mid"), { recursive: true });
  await writeFile(join(session, "Deep", "Deep.Mid", "Deep.Mid.Leaf.jsonl"), "{}\n");
  await writeFile(join(session, "Deep", "Deep.Mid", "Deep.Mid.Leaf.md"), "leaf out\n");
  await mkdir(join(session, "Other"), { recursive: true });
  await writeFile(join(session, "Other", "Other.Kid.jsonl"), "{}\n");
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
    assert.deepEqual(result.agents.map((a) => a.id).sort(), ["AgentA", "Deep.Mid.Leaf", "Other.Kid", "Parent.Child"]);
  });

  it("reads transcript and output of a nested agent from its subdirectory", async () => {
    const out = (await handlers.agent_output!({ artifactsDir: session, agentId: "Parent.Child" })) as { content: string };
    assert.match(out.content, /child out/);
    await handlers.agent_transcript!({ artifactsDir: session, agentId: "Parent.Child" });
  });

  it("lists, reads and opens a grandchild agent two folders deep", async () => {
    const out = (await handlers.agent_output!({ artifactsDir: session, agentId: "Deep.Mid.Leaf" })) as { content: string };
    assert.match(out.content, /leaf out/);
    await handlers.agent_transcript!({ artifactsDir: session, agentId: "Deep.Mid.Leaf" });
  });

  it("reads only the head of an oversized artifact and flags it truncated", async () => {
    await writeFile(join(session, "Huge.md"), "é".repeat(400_000));
    const out = (await handlers.agent_output!({ artifactsDir: session, agentId: "Huge" })) as { content: string; truncated: boolean };
    assert.equal(out.truncated, true);
    assert.ok(!out.content.includes("\ufffd"), "cut must not split a multi-byte character");
    assert.ok(out.content.length < 400_000);
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

  it("an oversized transcript keeps head and tail, repeats nothing and splits no character", async () => {
    // ~6 MB of Cyrillic rows, over the 2 MB cap, so only head and tail are read.
    const rows = Array.from({ length: 120 }, (_, i) =>
      JSON.stringify({ type: "message", timestamp: new Date(2_000_000 + i * 1000).toISOString(), message: { role: "user", content: `строка-${i}-${"ж".repeat(25_000)}` } }),
    );
    await writeFile(join(session, "Big.jsonl"), rows.join("\n") + "\n");
    const result = (await handlers.agent_transcript!({ artifactsDir: session, agentId: "Big" })) as {
      entries: Array<{ summary: string }>;
    };
    const seen = result.entries.map((e) => e.summary.split("-").slice(0, 2).join("-"));
    assert.equal(new Set(seen).size, seen.length, "no entry may repeat");
    assert.ok(seen.includes("строка-0"), "head kept");
    assert.ok(seen.includes("строка-119"), "newest row kept");
    assert.ok(seen.length < 120, "the middle was skipped, not loaded");
    assert.ok(result.entries.every((e) => !e.summary.includes("\ufffd")), "no broken character");
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
  it("incoming steering after a final turn makes the agent running again", () => {
    const irc = JSON.stringify({ type: "custom_message", customType: "irc:incoming", timestamp: ts(now - 2000), content: "<irc>go on</irc>" });
    const a = parseAgentFile("x", [finalText(now - 20_000), irc], now - 2000, now, artifacts);
    assert.equal(a.status, "running");
    assert.equal(a.lastActivityAtMs, now - 2000);
  });
  const yieldCall = (ms: number) =>
    JSON.stringify({ type: "message", timestamp: ts(ms), message: { role: "assistant", stopReason: "toolUse", content: [{ type: "toolCall", name: "yield", arguments: { result: { data: 1 } } }] } });
  const yieldResult = (ms: number, isError = false) =>
    JSON.stringify({ type: "message", timestamp: ts(ms), message: { role: "toolResult", toolName: "yield", isError, content: [{ type: "text", text: "ok" }] } });

  it("an accepted yield finishes the agent without any session_exit", () => {
    const a = parseAgentFile("x", [toolCall(now - 9000), toolResult(now - 8000), yieldCall(now - 3000), yieldResult(now - 2000)], now - 2000, now, artifacts);
    assert.equal(a.status, "finished");
  });
  it("a yield that was rejected does not finish the agent", () => {
    const a = parseAgentFile("x", [yieldCall(now - 3000), yieldResult(now - 2000, true)], now - 2000, now, artifacts);
    assert.equal(a.status, "running");
  });
  it("a failed agent carries the provider's error text", () => {
    const err = JSON.stringify({ type: "message", timestamp: ts(now - 4000), message: { role: "assistant", stopReason: "error", errorMessage: "401 Invalid API key\nInvalid API key (type=invalid_api_key)", content: [] } });
    const a = parseAgentFile("x", [toolCall(now - 9000), toolResult(now - 8000), err, exit(now - 3000)], now - 3000, now, artifacts);
    assert.equal(a.status, "failed");
    assert.equal(a.error, "401 Invalid API key Invalid API key (type=invalid_api_key)");
    assert.equal(activityLine(a), "401 Invalid API key Invalid API key (type=invalid_api_key)");
  });
  it("a finished agent has no error text", () => {
    const a = parseAgentFile("x", [finalText(now - 4000), exit(now - 3000)], now - 3000, now, artifacts);
    assert.equal(a.error, null);
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

describe("host watch registration", () => {
  it("starts exactly one subscription for concurrent callers", async () => {
    let started = 0;
    const slowCtx = {
      experimental_watch: async () => {
        started += 1;
        await new Promise((resolve) => setTimeout(resolve, 30));
        return { dispose: async () => undefined };
      },
      experimental_retainWorker: () => ({ dispose: async () => undefined }),
      experimental_emitSignal: async () => undefined,
    };
    await Promise.all([
      handlers.watch!({ path: session }, slowCtx),
      handlers.watch!({ path: session }, slowCtx),
      handlers.agents_list!({ artifactsDir: session }, slowCtx),
    ]);
    assert.equal(started, 1);
  });
});

describe("parseLatestTaskAgents", () => {
  const call = (id: string, names: string[]) =>
    JSON.stringify({ type: "message", message: { role: "assistant", content: [{ type: "toolCall", id, name: "task", arguments: { tasks: names.map((name) => ({ name })) } }] } });
  const result = (id: string, text: string) =>
    JSON.stringify({ type: "message", message: { role: "toolResult", toolName: "task", toolCallId: id, content: [{ type: "text", text }] } });

  it("uses the uniquified id from the spawn result, not the requested name", () => {
    const ids = parseLatestTaskAgents([
      call("c1", ["Scout"]),
      result("c1", "Spawned agent.\n- `Scout-2` (job `Scout-2`)"),
    ]);
    assert.deepEqual([...ids], ["Scout-2"]);
  });
  it("falls back to requested names until the spawn result is written", () => {
    assert.deepEqual([...parseLatestTaskAgents([call("c1", ["Scout"])])], ["Scout"]);
  });
  it("only the latest batch counts", () => {
    const ids = parseLatestTaskAgents([
      call("c1", ["Old"]),
      result("c1", "- `Old` (job `Old`)"),
      call("c2", ["New"]),
      result("c2", "- `New` (job `New`)"),
    ]);
    assert.deepEqual([...ids], ["New"]);
  });
});

describe("activityLine", () => {
  const base = { status: "running" as const, task: "audit the parser", currentTool: "grep", currentToolIntent: "status enum" };
  it("shows tool and intent for a running agent", () => {
    assert.equal(activityLine(base), "grep: status enum");
  });
  it("never ends in a dangling colon when the intent is empty", () => {
    assert.equal(activityLine({ ...base, currentToolIntent: "  " }), "grep");
    assert.equal(activityLine({ ...base, currentToolIntent: null }), "grep");
  });
  it("shows waiting, with its intent when it has one, for wait and yield", () => {
    assert.equal(activityLine({ ...base, currentTool: "wait", currentToolIntent: "" }), "waiting");
    assert.equal(activityLine({ ...base, currentTool: "yield", currentToolIntent: null }), "waiting");
    assert.equal(activityLine({ ...base, currentTool: "wait", currentToolIntent: "Waiting for sleep to finish" }), "Waiting for sleep to finish");
  });
  it("calls an agent with no tool call yet starting, not waiting", () => {
    assert.equal(activityLine({ ...base, currentTool: null, currentToolIntent: null }), "starting");
  });
  it("shows the task, not the last tool, once the agent settled", () => {
    assert.equal(activityLine({ ...base, status: "finished" }), "audit the parser");
  });
});

describe("taskBody and non-ASCII text", () => {
  it("never leaves a broken character when a Cyrillic task is cut", () => {
    const long = "Аудит и фикс: таблицы заказов на телефоне — ".repeat(40);
    const out = taskBody(`# Change ${long}`);
    assert.ok(out.length > 0 && !out.includes("\ufffd"));
  });
  it("cuts an emoji-heavy summary on whole code points", () => {
    const a = parseAgentFile("x", [JSON.stringify({ type: "session_init", agent: "task", task: "# Change " + "👍".repeat(500) })], 0, 0, { hasMd: false, hasJson: false, hasPatch: false });
    assert.ok(!a.task.includes("\ufffd"));
    assert.ok(Array.from(a.task).every((ch) => ch === "👍" || ch === "…"));
  });
});

describe("taskBody", () => {
  it("leads with the Change section and drops heading markers", () => {
    const text = "Complete assignment thoroughly:\n\n# Target No files. # Change Run bash `sleep 120`, then yield. # Acceptance Both ran.";
    assert.equal(taskBody(text), "Run bash `sleep 120`, then yield.");
  });
  it("handles headings on their own lines", () => {
    assert.equal(taskBody("# Target\nsrc/a.ts\n\n# Change\nRename foo to bar.\n\n# Acceptance\nTests pass."), "Rename foo to bar.");
  });
  it("falls back to the plain text when there are no headings", () => {
    assert.equal(taskBody("Fix the flaky   login test"), "Fix the flaky login test");
  });
  it("drops a leading None. and keeps what the agent does", () => {
    assert.equal(taskBody("# Target src/omp.ts (read-only). # Change None. Read the file. # Acceptance Done."), "Read the file.");
  });
  it("skips a Change section that is only None and leads with the Target", () => {
    assert.equal(taskBody("# Target\nserver.ts\n# Change\nNone\n# Acceptance\nok"), "server.ts");
  });
  it("uses the Goal when there is no Change", () => {
    assert.equal(taskBody("# Goal\nMap the auth flow.\n# Constraints\nRead-only."), "Map the auth flow.");
  });
});

describe("bounded reads", () => {
  const dir = join(tmp, "reads");
  before(() => mkdir(dir, { recursive: true }));

  it("an oversized file yields only whole lines, none half-read and none repeated", async () => {
    const lines = Array.from({ length: 300 }, (_, i) => `line-${i}-${"ж".repeat(900)}`);
    const file = join(dir, "lines.txt");
    await writeFile(file, lines.join("\n") + "\n");
    const got = await readLines(file, 40_000);
    const whole = new Set(lines.concat([""]));
    assert.ok(got.every((l) => whole.has(l)), "every returned line is a complete original line");
    assert.equal(new Set(got.filter((l) => l !== "")).size, got.filter((l) => l !== "").length, "no line repeats");
    assert.ok(got.includes(lines[0]!), "head kept");
    assert.ok(got.includes(lines[299]!), "newest line kept");
    assert.ok(got.length < 300, "the middle was skipped");
  });

  it("a tail that starts inside a line drops that partial line", async () => {
    // Unequal line lengths put the tail boundary inside a line for most offsets;
    // sweep the cap so at least some cuts are guaranteed to land mid-line.
    const lines = Array.from({ length: 400 }, (_, i) => `row-${i}-${"ж".repeat(37 + (i * 53) % 311)}`);
    const file = join(dir, "sweep.txt");
    await writeFile(file, lines.join("\n") + "\n");
    const whole = new Set(lines.concat([""]));
    let midLineCuts = 0;
    for (let cap = 30_001; cap < 30_001 + 400; cap += 7) {
      const got = await readLines(file, cap);
      const bad = got.filter((l) => !whole.has(l));
      assert.deepEqual(bad.map((l) => l.slice(0, 20)), [], `cap ${cap} returned a partial line`);
      midLineCuts += 1;
    }
    assert.ok(midLineCuts > 40);
  });

  it("a file within the cap is returned whole", async () => {
    const file = join(dir, "small.txt");
    await writeFile(file, "a\nб\nc\n");
    assert.deepEqual(await readLines(file, 1_000), ["a", "б", "c", ""]);
  });

  it("readHead never splits a multi-byte character and reports truncation", async () => {
    const file = join(dir, "head.txt");
    await writeFile(file, "ж".repeat(1000)); // 2 bytes each
    for (const cut of [999, 1000, 1001]) {
      const head = await readHead(file, cut);
      assert.ok(head !== null && head.truncated);
      assert.ok(!head.text.includes("\ufffd"), `cut ${cut} left a broken character`);
      assert.ok([...head.text].every((c) => c === "ж"));
    }
    const all = await readHead(file, 5_000);
    assert.equal(all?.truncated, false);
  });

  it("refuses a symlink", async () => {
    const link = join(dir, "link.txt");
    await symlink(join(dir, "small.txt"), link);
    await assert.rejects(() => readLines(link, 1_000));
    assert.equal(await readHead(link, 100), null);
  });
});

describe("statusStyle", () => {
  it("a killed agent is neutral, never bb's needs-you colour", () => {
    const killed = statusStyle("interrupted");
    assert.equal(killed.glyph, "Square");
    assert.ok(!killed.toneClass.includes("pending"), "the pending/needs-you tone is reserved for requests");
    assert.equal(killed.spin, false);
  });
  it("only a running agent spins, and every status has a distinct glyph or tone", () => {
    const all = (["running", "finished", "failed", "interrupted", "partial"] as const).map((s) => [s, statusStyle(s)] as const);
    assert.deepEqual(all.filter(([, v]) => v.spin).map(([k]) => k), ["running"]);
    assert.equal(new Set(all.map(([, v]) => `${v.glyph}|${v.toneClass}`)).size, 5);
  });
  it("an interrupted agent no longer reports a needs-you indicator", () => {
    const aborted = JSON.stringify({ type: "message", timestamp: new Date(1_000_000).toISOString(), message: { role: "assistant", stopReason: "aborted", content: [] } });
    const a = parseAgentFile("x", [aborted], 1_000_000, 1_000_100, { hasMd: false, hasJson: false, hasPatch: false });
    assert.equal(a.status, "interrupted");
    assert.equal(a.indicator, "none");
  });
});

describe("opening an agent from the strip", () => {
  it("accepts a well-formed request", () => {
    assert.deepEqual(parseOpenAgentRequest({ threadId: "thr_1", agentId: "Scout-2" }), { threadId: "thr_1", agentId: "Scout-2" });
  });
  it("rejects anything else, including extra-shaped junk from the page", () => {
    for (const bad of [null, undefined, 3, "x", {}, { threadId: "t" }, { agentId: "a" }, { threadId: "", agentId: "a" }, { threadId: "t", agentId: 5 }]) {
      assert.equal(parseOpenAgentRequest(bad), null);
    }
  });
  it("panel params carry the thread and the agent to open", () => {
    assert.deepEqual(parseHubParams({ threadId: "thr_1", agentId: "Scout-2", projectId: "p" }), { threadId: "thr_1", agentId: "Scout-2" });
    assert.deepEqual(parseHubParams({ threadId: "thr_1" }), { threadId: "thr_1", agentId: null });
    assert.deepEqual(parseHubParams(null), { threadId: null, agentId: null });
    assert.deepEqual(parseHubParams({ threadId: 7, agentId: "" }), { threadId: null, agentId: null });
  });
  it("uses one stable event name", () => {
    assert.equal(OPEN_AGENT_EVENT, "omp-subagents:open-agent");
  });
  it("only uses glyphs that exist in bb's icon set (an unknown name renders as a lightning bolt)", () => {
    for (const status of ["running", "finished", "failed", "interrupted", "partial"] as const) {
      assert.ok((VERIFIED_BB_GLYPHS as readonly string[]).includes(statusStyle(status).glyph), `${status} uses an unverified glyph`);
    }
  });
  it("every glyph the plugin draws is verified (the unknown ones render as a lightning bolt)", () => {
    for (const [use, name] of Object.entries(GLYPHS)) {
      assert.ok((VERIFIED_BB_GLYPHS as readonly string[]).includes(name), `${use} uses unverified glyph ${name}`);
    }
  });
});
