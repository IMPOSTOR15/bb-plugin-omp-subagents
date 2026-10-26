// Host tests for the live-roster path: incremental parsing, watch signals and
// the idle-watch sweep. Run: npm test  (node:test + type stripping)
import assert from "node:assert/strict";
import { appendFile, mkdir, mkdtemp, realpath, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, afterEach, before, describe, it, mock } from "node:test";

const tmp = await mkdtemp(join(tmpdir(), "omp-watch-"));
process.env.OMP_SESSIONS_DIR = tmp;
const root = await realpath(tmp);

import host, { sweepIdleWatches } from "../src/host.ts";

type Handler = (input: unknown, context?: unknown) => Promise<unknown>;
const handlers = host.handlers as unknown as Record<string, Handler>;

const UUID = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
const session = join(root, "-ws", `2026-02-02T00-00-00-000Z_${UUID}`);

type Event =
  | { kind: "changed"; changes: Array<{ path: string; type: "update" }> }
  | { kind: "rescan-required" }
  | { kind: "watch-error"; message: string };

/** A fake host context: records watches, leases and emitted signals. */
function fakeContext() {
  const state = {
    watches: 0,
    disposedWatches: 0,
    leases: 0,
    releasedLeases: 0,
    listener: null as ((event: Event) => Promise<void> | void) | null,
    signals: [] as Array<{ name: string; payload: { sessionUuid: string; paths: string[] } }>,
  };
  const context = {
    experimental_watch: async (_options: unknown, listener: (event: Event) => Promise<void> | void) => {
      state.watches += 1;
      state.listener = listener;
      return {
        dispose: async () => {
          state.disposedWatches += 1;
        },
      };
    },
    experimental_retainWorker: () => {
      state.leases += 1;
      return {
        dispose: async () => {
          state.releasedLeases += 1;
        },
      };
    },
    experimental_emitSignal: async (name: string, payload: { sessionUuid: string; paths: string[] }) => {
      state.signals.push({ name, payload });
    },
  };
  return { state, context };
}

const iso = (ms: number) => new Date(ms).toISOString();
const assistantRow = (ms: number, toolCall: boolean) =>
  JSON.stringify({
    type: "message",
    timestamp: iso(ms),
    message: {
      role: "assistant",
      stopReason: toolCall ? "toolUse" : "stop",
      content: toolCall ? [{ type: "toolCall", name: "bash", arguments: { command: "ls" } }] : [{ type: "text", text: "done" }],
    },
  });

type Roster = { agents: Array<{ id: string; status: string; toolCount: number; hasPatch: boolean; hasMd: boolean; lastActivityAtMs: number | null; indicator: string }> };
const roster = async (context: unknown, dir = session) => (await handlers.agents_list!({ artifactsDir: dir }, context)) as Roster;

before(async () => {
  await mkdir(session, { recursive: true });
  await writeFile(`${session}.jsonl`, "{}\n");
});
afterEach(async () => {
  mock.timers.reset();
  await host.dispose?.();
});
after(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("roster freshness with cached parses", () => {
  it("a changed transcript yields a fresh summary, an unchanged one is served again", async () => {
    const { context } = fakeContext();
    const file = join(session, "Live.jsonl");
    const t0 = Date.now();
    await writeFile(file, `${assistantRow(t0, true)}\n`);
    const first = (await roster(context)).agents.find((a) => a.id === "Live")!;
    assert.equal(first.toolCount, 1);
    const again = (await roster(context)).agents.find((a) => a.id === "Live")!;
    assert.equal(again.toolCount, 1);

    await appendFile(file, `${assistantRow(t0 + 1000, true)}\n${assistantRow(t0 + 2000, true)}\n`);
    const grown = (await roster(context)).agents.find((a) => a.id === "Live")!;
    assert.equal(grown.toolCount, 3);
    assert.equal(grown.lastActivityAtMs, t0 + 2000);
  });

  it("a rewrite with the same size and a newer mtime is re-read", async () => {
    const { context } = fakeContext();
    const file = join(session, "Rewrite.jsonl");
    const t0 = Date.now();
    await writeFile(file, `${assistantRow(t0, true)}\n`);
    await utimes(file, new Date(t0), new Date(t0));
    assert.equal((await roster(context)).agents.find((a) => a.id === "Rewrite")!.toolCount, 1);
    // same byte length: a tool call becomes a final text turn of equal size
    const swapped = assistantRow(t0, false).padEnd(assistantRow(t0, true).length, " ");
    assert.equal(swapped.length, assistantRow(t0, true).length);
    await writeFile(file, `${swapped}\n`);
    await utimes(file, new Date(t0 + 5000), new Date(t0 + 5000));
    const after = (await roster(context)).agents.find((a) => a.id === "Rewrite")!;
    assert.equal(after.toolCount, 0);
    assert.equal(after.status, "finished");
  });

  it("an unchanged running transcript turns partial once the live window passes", async () => {
    const { context } = fakeContext();
    const file = join(session, "Quiet.jsonl");
    const t0 = 1_800_000_000_000;
    await writeFile(file, `${assistantRow(t0, true)}\n`);
    await utimes(file, new Date(t0), new Date(t0));
    mock.timers.enable({ apis: ["Date"], now: t0 + 10_000 });
    const running = (await roster(context)).agents.find((a) => a.id === "Quiet")!;
    assert.equal(running.status, "running");
    assert.equal(running.indicator, "runtime");

    mock.timers.setTime(t0 + 200_000);
    const stale = (await roster(context)).agents.find((a) => a.id === "Quiet")!;
    assert.equal(stale.status, "partial");
    assert.equal(stale.indicator, "none");
  });

  it("a final output or patch appearing next to an unchanged transcript shows up", async () => {
    const { context } = fakeContext();
    const file = join(session, "Late.jsonl");
    await writeFile(file, `${assistantRow(Date.now(), false)}\n`);
    const before = (await roster(context)).agents.find((a) => a.id === "Late")!;
    assert.deepEqual([before.hasMd, before.hasPatch], [false, false]);
    await writeFile(join(session, "Late.md"), "result\n");
    await writeFile(join(session, "Late.patch"), "diff\n");
    const after = (await roster(context)).agents.find((a) => a.id === "Late")!;
    assert.deepEqual([after.hasMd, after.hasPatch], [true, true]);
  });

  it("an agent whose transcript was deleted leaves the roster", async () => {
    const { context } = fakeContext();
    const file = join(session, "Gone.jsonl");
    await writeFile(file, `${assistantRow(Date.now(), false)}\n`);
    assert.ok((await roster(context)).agents.some((a) => a.id === "Gone"));
    await rm(file);
    assert.ok(!(await roster(context)).agents.some((a) => a.id === "Gone"));
  });
});

describe("changed signals", () => {
  const emitChanges = async (state: ReturnType<typeof fakeContext>["state"], names: string[]) => {
    await state.listener!({
      kind: "changed",
      changes: names.map((name) => ({ path: join(session, name), type: "update" as const })),
    });
  };

  it("carries the bare session uuid, not the timestamped directory name", async () => {
    const { state, context } = fakeContext();
    await roster(context);
    await emitChanges(state, ["Live.jsonl"]);
    assert.equal(state.signals.length, 1);
    assert.equal(state.signals[0]!.payload.sessionUuid, UUID);
  });

  it("ignores shared tool logs and the advisor transcript", async () => {
    const { state, context } = fakeContext();
    await roster(context);
    await emitChanges(state, ["1.bash.log", "async.log", "__advisor.jsonl", "local"]);
    assert.deepEqual(state.signals, []);
  });

  it("fires for outputs and patches, and lists only the agent files", async () => {
    const { state, context } = fakeContext();
    await roster(context);
    await emitChanges(state, ["Late.md", "1.bash.log"]);
    await emitChanges(state, ["Late.patch"]);
    await emitChanges(state, ["Late.json"]);
    assert.equal(state.signals.length, 3);
    assert.deepEqual(state.signals[0]!.payload.paths, [join(session, "Late.md")]);
  });

  it("a lost watch asks for a full refetch", async () => {
    const { state, context } = fakeContext();
    await roster(context);
    await state.listener!({ kind: "rescan-required" });
    await state.listener!({ kind: "watch-error", message: "boom" });
    assert.deepEqual(
      state.signals.map((s) => [s.payload.sessionUuid, s.payload.paths]),
      [
        [UUID, []],
        [UUID, []],
      ],
    );
  });
});

describe("idle watch sweep", () => {
  it("releases a watch idle for over five minutes, subscription and lease, and restarts it on demand", async () => {
    const { state, context } = fakeContext();
    const t0 = 1_800_000_000_000;
    mock.timers.enable({ apis: ["Date"], now: t0 });
    await roster(context);
    assert.equal(state.watches, 1);

    await sweepIdleWatches(t0 + 4 * 60_000);
    assert.equal(state.disposedWatches, 0, "four minutes idle is still in use");

    await sweepIdleWatches(t0 + 5 * 60_000 + 1);
    assert.equal(state.disposedWatches, 1);
    assert.equal(state.releasedLeases, 1);

    await roster(context);
    assert.equal(state.watches, 2, "the next read starts a fresh watch");
  });

  it("keeps a watch that is still being read, whichever read touched it", async () => {
    const { state, context } = fakeContext();
    const t0 = 1_800_000_000_000;
    mock.timers.enable({ apis: ["Date"], now: t0 });
    await roster(context);
    for (const [at, read] of [
      [4 * 60_000, () => handlers.agent_transcript!({ artifactsDir: session, agentId: "Live" })],
      [8 * 60_000, () => handlers.agent_output!({ artifactsDir: session, agentId: "Late" })],
      [12 * 60_000, () => handlers.agent_patch!({ artifactsDir: session, agentId: "Late" })],
    ] as const) {
      mock.timers.setTime(t0 + at);
      await read();
      await sweepIdleWatches(t0 + at + 60_000);
      assert.equal(state.disposedWatches, 0, `touched at +${at / 60_000} min`);
    }
    await sweepIdleWatches(t0 + 12 * 60_000 + 5 * 60_000 + 1);
    assert.equal(state.disposedWatches, 1);
  });

  it("releases only the idle one of two sessions", async () => {
    const other = join(root, "-ws", "2026-02-03T00-00-00-000Z_cccccccc-cccc-cccc-cccc-cccccccccccc");
    await mkdir(other, { recursive: true });
    await writeFile(`${other}.jsonl`, "{}\n");
    const a = fakeContext();
    const b = fakeContext();
    const t0 = 1_800_000_000_000;
    mock.timers.enable({ apis: ["Date"], now: t0 });
    await roster(a.context, session);
    await roster(b.context, other);
    mock.timers.setTime(t0 + 4 * 60_000);
    await roster(b.context, other);
    await sweepIdleWatches(t0 + 6 * 60_000);
    assert.equal(a.state.disposedWatches, 1);
    assert.equal(b.state.disposedWatches, 0);
  });

  it("dispose releases every watch and lease", async () => {
    const { state, context } = fakeContext();
    await roster(context);
    await host.dispose?.();
    assert.equal(state.disposedWatches, 1);
    assert.equal(state.releasedLeases, 1);
  });

  it("dispose while the watcher is still starting releases that watch", async () => {
    const { state, context } = fakeContext();
    // tsconfig's lib is ES2022: no Promise.withResolvers.
    let entered!: () => void;
    const watchEntered = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const slow = {
      ...context,
      experimental_watch: async (options: unknown, listener: (event: Event) => Promise<void> | void) => {
        entered();
        await gate;
        return context.experimental_watch(options, listener);
      },
    };
    const reading = roster(slow);
    await watchEntered;
    const disposing = host.dispose?.();
    release();
    await Promise.all([reading, disposing]);
    assert.equal(state.watches, 1);
    assert.equal(state.disposedWatches, 1, "the late subscription outlived dispose");
    assert.equal(state.releasedLeases, state.leases, "the late lease outlived dispose");
  });

  it("a roster read in flight across dispose leaves nothing watched", async () => {
    const { state, context } = fakeContext();
    // Dispose before the read has even resolved its path.
    const reading = roster(context);
    const disposing = host.dispose?.();
    await Promise.all([reading, disposing]);
    assert.equal(state.disposedWatches, state.watches, "a watch outlived dispose");
    assert.equal(state.releasedLeases, state.leases, "a lease outlived dispose");
    // A read after dispose watches again as usual.
    await roster(context);
    assert.equal(state.watches - state.disposedWatches, 1);
  });

  it("a failing subscription disposal still releases the lease", async () => {
    const { state, context } = fakeContext();
    const failing = {
      ...context,
      experimental_watch: async () => ({
        dispose: async () => {
          throw new Error("gone");
        },
      }),
    };
    await roster(failing);
    await sweepIdleWatches(Date.now() + 6 * 60_000);
    assert.equal(state.leases, 1);
    assert.equal(state.releasedLeases, 1);
  });
});
