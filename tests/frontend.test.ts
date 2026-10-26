// Pure-logic tests for the shared roster store and its derivations.
// Run: npm test  (node:test + type stripping; no extra dependencies)
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { AgentStatus, AgentSummary } from "../src/contract.ts";
import { GLYPHS, VERIFIED_BB_GLYPHS } from "../src/glyphs.ts";
import { PENDING_OPEN_TTL_MS, requestOpenAgent, takePendingOpen } from "../src/open-agent.ts";
import { splitPatchByFile } from "../src/patch-split.ts";
import {
  agentsForRow,
  buildAgentTree,
  filterByStatus,
  flattenAgentTree,
  nextRunningAgent,
  rosterTotals,
  statusCounts,
} from "../src/roster-derive.ts";
import {
  POLL_BACKGROUND_MS,
  POLL_IDLE_MS,
  POLL_RUNNING_MS,
  createRosterStore,
  findNewFailures,
  parseRosterResult,
  type RosterData,
} from "../src/roster-store.ts";
import { deriveRowStatus, syncRowStatuses, type RowStatus } from "../src/row-status.ts";

function agent(id: string, status: AgentStatus = "finished", extra: Partial<AgentSummary> = {}): AgentSummary {
  return {
    id,
    agent: null,
    modelRole: null,
    resolvedModel: null,
    readOnly: null,
    status,
    task: "",
    createdAtMs: null,
    endedAtMs: null,
    lastActivityAtMs: null,
    currentTool: null,
    currentToolIntent: null,
    toolCount: 0,
    requestCount: 0,
    tokensIn: null,
    tokensOut: null,
    contextTokens: null,
    costTotal: null,
    hasMd: false,
    hasJson: false,
    hasPatch: false,
    nested: [],
    activeSeconds: null,
    indicator: "none",
    error: null,
    spawnedInLatestBatch: false,
    ...extra,
  };
}

/** A store on a manual clock with a fetch the test resolves by hand. */
function harness() {
  let now = 0;
  const timers = new Map<number, { at: number; run: () => void }>();
  let nextTimer = 1;
  const pending: Array<{
    threadId: string;
    resolve(data: RosterData): void;
    reject(error: Error): void;
  }> = [];
  const calls: string[] = [];
  const store = createRosterStore({
    fetchRoster: (threadId) => {
      calls.push(threadId);
      return new Promise<RosterData>((resolve, reject) => {
        pending.push({ threadId, resolve, reject });
      });
    },
    setTimer: (run, ms) => {
      const handle = nextTimer++;
      timers.set(handle, { at: now + ms, run });
      return handle;
    },
    clearTimer: (handle) => void timers.delete(handle as number),
    now: () => now,
  });
  const settle = () => new Promise((resolve) => setImmediate(resolve));
  return {
    store,
    calls,
    pending,
    /** Resolve the oldest outstanding fetch, then let the store continue. */
    async answer(data: RosterData) {
      const next = pending.shift();
      assert.ok(next, "no fetch in flight");
      next.resolve(data);
      await settle();
    },
    async fail(message: string) {
      const next = pending.shift();
      assert.ok(next, "no fetch in flight");
      next.reject(new Error(message));
      await settle();
    },
    /** Delay until the earliest pending timer, or null when none is armed. */
    nextTimerDelay: () => {
      const times = [...timers.values()].map((timer) => timer.at - now);
      return times.length === 0 ? null : Math.min(...times);
    },
    async advance(ms: number) {
      now += ms;
      for (const [handle, timer] of [...timers]) {
        if (timer.at <= now) {
          timers.delete(handle);
          timer.run();
        }
      }
      await settle();
    },
  };
}

const roster = (sessionUuid: string | null, ...agents: AgentSummary[]): RosterData => ({
  sessionUuid,
  agents,
});

describe("roster store: request coalescing", () => {
  it("N requests during one in-flight call produce exactly one follow-up", async () => {
    const h = harness();
    h.store.request("t1");
    assert.equal(h.calls.length, 1);
    for (let i = 0; i < 7; i += 1) h.store.request("t1");
    assert.equal(h.calls.length, 1, "no second request while one is in flight");
    await h.answer(roster("s1"));
    assert.equal(h.calls.length, 2, "exactly one follow-up");
    h.store.request("t1");
    assert.equal(h.calls.length, 2, "the follow-up is itself in flight");
    await h.answer(roster("s1"));
    assert.equal(h.calls.length, 3, "a request during the follow-up queues one more");
    await h.answer(roster("s1"));
    assert.equal(h.calls.length, 3, "and nothing is left over");
  });

  it("keeps threads independent", async () => {
    const h = harness();
    h.store.request("t1");
    h.store.request("t2");
    assert.deepEqual(h.calls, ["t1", "t2"]);
  });

  it("a failed request still releases the slot and surfaces the error", async () => {
    const h = harness();
    h.store.request("t1");
    await h.fail("boom");
    assert.equal(h.store.getView("t1").error, "boom");
    assert.equal(h.store.getView("t1").loading, false);
    h.store.request("t1");
    assert.equal(h.calls.length, 2);
    await h.answer(roster("s1", agent("A")));
    assert.equal(h.store.getView("t1").error, null);
    assert.equal(h.store.getView("t1").roster?.agents.length, 1);
  });

  it("keeps the last good roster when a refetch fails", async () => {
    const h = harness();
    h.store.request("t1");
    await h.answer(roster("s1", agent("A")));
    h.store.request("t1");
    await h.fail("offline");
    assert.equal(h.store.getView("t1").roster?.agents[0]?.id, "A");
    assert.equal(h.store.getView("t1").error, "offline");
  });
});

describe("roster store: realtime filtering", () => {
  it("refetches only threads whose loaded sessionUuid matches, strictly", async () => {
    const h = harness();
    h.store.request("t1");
    h.store.request("t2");
    h.store.request("t3");
    await h.answer(roster("aaa"));
    await h.answer(roster("bbb"));
    await h.answer(roster(null));
    h.calls.length = 0;
    h.store.handleChanged({ sessionUuid: "bbb" });
    assert.deepEqual(h.calls, ["t2"]);
    await h.answer(roster("bbb"));
    h.store.handleChanged({ sessionUuid: "bb" });
    h.store.handleChanged({ sessionUuid: "BBB" });
    h.store.handleChanged({ sessionUuid: "2026-01-01T00-00-00-000Z_bbb" });
    assert.deepEqual(h.calls, ["t2"], "prefix / case / timestamped forms do not match");
  });

  it("ignores malformed payloads instead of refetching everything", async () => {
    const h = harness();
    h.store.request("t1");
    await h.answer(roster("aaa"));
    h.calls.length = 0;
    for (const bad of [null, undefined, "aaa", 7, {}, { sessionUuid: 5 }, { sessionUuid: "" }]) {
      h.store.handleChanged(bad);
    }
    assert.deepEqual(h.calls, []);
  });

  it("does not refetch a thread that has not loaded yet", () => {
    const h = harness();
    h.store.handleChanged({ sessionUuid: "aaa" });
    assert.deepEqual(h.calls, []);
  });

  it("reconcile refetches subscribed and still-running threads, not idle unwatched ones", async () => {
    const h = harness();
    h.store.request("watched");
    h.store.request("bgRunning");
    h.store.request("idle");
    await h.answer(roster("w", agent("A")));
    await h.answer(roster("r", agent("B", "running")));
    await h.answer(roster("i", agent("C")));
    const unsubscribe = h.store.subscribe("watched", () => undefined);
    h.calls.length = 0;
    h.store.reconcile();
    assert.deepEqual(h.calls.sort(), ["bgRunning", "watched"]);
    unsubscribe();
  });
});

describe("roster store: polling cadence", () => {
  it("polls fast while an agent runs, slow otherwise, and never slower than 60s", async () => {
    const h = harness();
    h.store.subscribe("t1", () => undefined);
    await h.answer(roster("s", agent("A", "running")));
    assert.equal(h.nextTimerDelay(), POLL_RUNNING_MS);
    await h.advance(POLL_RUNNING_MS);
    await h.answer(roster("s", agent("A", "finished")));
    assert.equal(h.nextTimerDelay(), POLL_IDLE_MS);
    assert.ok(POLL_IDLE_MS <= 60_000 && POLL_RUNNING_MS < POLL_IDLE_MS);
  });

  it("after the last subscriber leaves, keeps polling only while an agent still runs", async () => {
    const h = harness();
    const unsubscribe = h.store.subscribe("t1", () => undefined);
    await h.answer(roster("s", agent("A", "running")));
    unsubscribe();
    assert.equal(h.nextTimerDelay(), POLL_BACKGROUND_MS);
    await h.advance(POLL_BACKGROUND_MS);
    assert.equal(h.calls.length, 2);
    await h.answer(roster("s", agent("A", "finished")));
    assert.equal(h.nextTimerDelay(), null, "settled and unwatched: polling stops");
  });

  it("an unwatched thread that never ran anything does not poll at all", async () => {
    const h = harness();
    const unsubscribe = h.store.subscribe("t1", () => undefined);
    await h.answer(roster("s", agent("A")));
    unsubscribe();
    assert.equal(h.nextTimerDelay(), null);
  });

  it("a second subscriber reuses fresh data instead of refetching", async () => {
    const h = harness();
    h.store.subscribe("t1", () => undefined);
    await h.answer(roster("s", agent("A")));
    h.store.subscribe("t1", () => undefined);
    assert.equal(h.calls.length, 1);
    await h.advance(60_000);
    h.pending.length = 0;
    h.store.subscribe("t1", () => undefined);
    assert.ok(h.calls.length >= 2, "stale data is refreshed on subscribe");
  });

  it("listeners are told when the view changes, but not when a poll finds the same data", async () => {
    const h = harness();
    let notifications = 0;
    h.store.subscribe("t1", () => (notifications += 1));
    await h.answer(roster("s", agent("A")));
    const after = notifications;
    const view = h.store.getView("t1");
    h.store.request("t1");
    await h.answer(roster("s", agent("A")));
    assert.equal(h.store.getView("t1").roster, view.roster, "identical data keeps the same roster object");
    h.store.request("t1");
    await h.answer(roster("s", agent("A", "failed")));
    assert.ok(notifications > after);
  });
});

describe("running -> failed detection", () => {
  it("reports an agent that was running and is now failed", () => {
    const failed = findNewFailures([agent("A", "running"), agent("B", "running")], [agent("A", "failed"), agent("B", "finished")]);
    assert.deepEqual(failed.map((entry) => entry.id), ["A"]);
  });

  it("never reports on the first load", () => {
    assert.deepEqual(findNewFailures(null, [agent("A", "failed")]), []);
  });

  it("does not repeat a failure that was already failed", () => {
    assert.deepEqual(findNewFailures([agent("A", "failed")], [agent("A", "failed")]), []);
  });

  it("ignores agents that first appear already failed", () => {
    assert.deepEqual(findNewFailures([agent("A", "running")], [agent("A", "running"), agent("B", "failed")]), []);
  });

  it("the store emits one failure per transition and none for the initial load", async () => {
    const h = harness();
    const seen: string[] = [];
    h.store.onFailure(({ threadId, agent: failed }) => seen.push(`${threadId}:${failed.id}`));
    h.store.request("t1");
    await h.answer(roster("s", agent("A", "failed"), agent("B", "running")));
    assert.deepEqual(seen, []);
    h.store.request("t1");
    await h.answer(roster("s", agent("A", "failed"), agent("B", "failed")));
    h.store.request("t1");
    await h.answer(roster("s", agent("A", "failed"), agent("B", "failed")));
    assert.deepEqual(seen, ["t1:B"]);
  });

  it("a failed fetch between two loads does not lose the transition", async () => {
    const h = harness();
    const seen: string[] = [];
    h.store.onFailure(({ agent: failed }) => seen.push(failed.id));
    h.store.request("t1");
    await h.answer(roster("s", agent("A", "running")));
    h.store.request("t1");
    await h.fail("offline");
    h.store.request("t1");
    await h.answer(roster("s", agent("A", "failed")));
    assert.deepEqual(seen, ["A"]);
  });
});

describe("agent tree", () => {
  const ids = (nodes: ReturnType<typeof buildAgentTree>): unknown[] =>
    nodes.map((node) => (node.children.length === 0 ? node.agent.id : [node.agent.id, ids(node.children)]));

  it("nests Parent.Child under Parent, recursively", () => {
    const tree = buildAgentTree([agent("A"), agent("A.B"), agent("A.B.C"), agent("A.D"), agent("E")]);
    assert.deepEqual(ids(tree), [["A", [["A.B", ["A.B.C"]], "A.D"]], "E"]);
  });

  it("a child whose parent is not listed appears at top level", () => {
    const tree = buildAgentTree([agent("X.Kid"), agent("Y"), agent("Y.Kid")]);
    assert.deepEqual(ids(tree), ["X.Kid", ["Y", ["Y.Kid"]]]);
  });

  it("an intermediate missing level orphans only the deeper agent", () => {
    const tree = buildAgentTree([agent("Y"), agent("Y.Mid.Leaf")]);
    assert.deepEqual(ids(tree), ["Y", "Y.Mid.Leaf"]);
  });

  it("flattens depth-first with depths", () => {
    const rows = flattenAgentTree(buildAgentTree([agent("A"), agent("A.B"), agent("A.B.C"), agent("Z")]));
    assert.deepEqual(rows.map((row) => [row.agent.id, row.depth]), [["A", 0], ["A.B", 1], ["A.B.C", 2], ["Z", 0]]);
  });

  it("keeps a leading-dot or dotless id at top level", () => {
    assert.deepEqual(ids(buildAgentTree([agent(".odd"), agent("plain")])), [".odd", "plain"]);
  });
});

describe("roster header derivations", () => {
  it("sums tokens and cost, ignoring nulls", () => {
    const totals = rosterTotals([
      agent("A", "finished", { tokensIn: 100, tokensOut: null, costTotal: 0.5 }),
      agent("B", "finished", { tokensIn: null, tokensOut: 30, costTotal: null }),
      agent("C", "finished", { tokensIn: 20, tokensOut: 5, costTotal: 0.25 }),
    ]);
    assert.deepEqual(totals, { tokensIn: 120, tokensOut: 35, cost: 0.75 });
  });

  it("keeps a column null when every agent is null, but a real zero stays zero", () => {
    assert.deepEqual(rosterTotals([agent("A"), agent("B")]), { tokensIn: null, tokensOut: null, cost: null });
    assert.equal(rosterTotals([agent("A", "finished", { costTotal: 0 })]).cost, 0);
    assert.deepEqual(rosterTotals([]), { tokensIn: null, tokensOut: null, cost: null });
  });

  it("counts each status present and filters by it", () => {
    const agents = [agent("A", "running"), agent("B", "failed"), agent("C", "running"), agent("D", "finished")];
    assert.deepEqual(statusCounts(agents), [
      { status: "running", count: 2 },
      { status: "failed", count: 1 },
      { status: "finished", count: 1 },
    ]);
    assert.deepEqual(filterByStatus(agents, "running").map((entry) => entry.id), ["A", "C"]);
    assert.equal(filterByStatus(agents, "all").length, 4);
    assert.deepEqual(filterByStatus(agents, "partial"), []);
  });

  it("a timeline row shows only its agents, in spawn order, not roster order", () => {
    const agents = [agent("C"), agent("Other"), agent("A"), agent("B")];
    assert.deepEqual(agentsForRow(agents, ["A", "B", "C"]).map((entry) => entry.id), ["A", "B", "C"]);
    assert.deepEqual(agentsForRow(agents, ["Missing"]), []);
  });

  it("cycles through running agents and wraps", () => {
    const agents = [agent("A", "running"), agent("B", "finished"), agent("C", "running")];
    assert.equal(nextRunningAgent(agents, null)?.id, "A");
    assert.equal(nextRunningAgent(agents, "A")?.id, "C");
    assert.equal(nextRunningAgent(agents, "C")?.id, "A");
    assert.equal(nextRunningAgent(agents, "B")?.id, "A", "a no-longer-running anchor restarts");
    assert.equal(nextRunningAgent([agent("A")], null), null);
  });
});

describe("thread row status", () => {
  it("running wins over failures and counts agents", () => {
    const status = deriveRowStatus([
      agent("A", "running"),
      agent("B", "running"),
      agent("C", "failed", { spawnedInLatestBatch: true }),
    ]);
    assert.deepEqual(status && [status.label, status.tone], ["2 subagents running", "running"]);
    assert.equal(deriveRowStatus([agent("A", "running")])?.label, "1 subagent running");
  });

  it("failures count only in the latest batch", () => {
    const status = deriveRowStatus([
      agent("Old", "failed", { spawnedInLatestBatch: false }),
      agent("New", "failed", { spawnedInLatestBatch: true }),
      agent("Fine", "finished", { spawnedInLatestBatch: true }),
    ]);
    assert.deepEqual(status && [status.label, status.tone], ["1 subagent failed", "error"]);
    assert.equal(deriveRowStatus([agent("Old", "failed")]), null);
  });

  it("is null for an empty or settled roster", () => {
    assert.equal(deriveRowStatus([]), null);
    assert.equal(deriveRowStatus([agent("A", "finished"), agent("B", "interrupted")]), null);
  });

  it("only uses verified glyphs", () => {
    for (const status of [deriveRowStatus([agent("A", "running")]), deriveRowStatus([agent("A", "failed", { spawnedInLatestBatch: true })])]) {
      assert.ok(status && (VERIFIED_BB_GLYPHS as readonly string[]).includes(status.icon));
    }
    assert.ok(Object.values(GLYPHS).every((name) => (VERIFIED_BB_GLYPHS as readonly string[]).includes(name)));
  });

  it("pushes changes only, clears when agents settle, and clears everything on abort", async () => {
    const h = harness();
    const calls: Array<[string, RowStatus | null]> = [];
    const abort = new AbortController();
    syncRowStatuses(h.store, (threadId, status) => calls.push([threadId, status]), abort.signal);
    h.store.request("t1");
    h.store.request("t2");
    await h.answer(roster("s1", agent("A", "running")));
    await h.answer(roster("s2", agent("B", "running")));
    assert.deepEqual(calls.map(([id, status]) => [id, status?.label]), [
      ["t1", "1 subagent running"],
      ["t2", "1 subagent running"],
    ]);
    h.store.request("t1");
    await h.answer(roster("s1", agent("A", "running"), agent("A2", "running")));
    assert.equal(calls.at(-1)?.[1]?.label, "2 subagents running");
    h.store.request("t1");
    await h.answer(roster("s1", agent("A", "finished"), agent("A2", "finished")));
    assert.deepEqual(calls.at(-1), ["t1", null]);
    const before = calls.length;
    h.store.request("t1");
    await h.answer(roster("s1", agent("A", "finished"), agent("A2", "finished")));
    assert.equal(calls.length, before, "no repeated null for an already-clear row");
    abort.abort();
    assert.deepEqual(calls.at(-1), ["t2", null], "abort clears the status still showing");
    assert.equal(calls.filter(([id, status]) => id === "t1" && status === null).length, 1);
    h.store.request("t2");
    await h.answer(roster("s2", agent("B", "finished")));
    assert.equal(calls.at(-1)?.[0], "t2");
    assert.equal(calls.length, before + 1, "nothing is pushed after abort");
  });

  it("statuses already known when the sync starts are applied", async () => {
    const h = harness();
    h.store.request("t1");
    await h.answer(roster("s1", agent("A", "running")));
    const calls: string[] = [];
    syncRowStatuses(h.store, (threadId) => calls.push(threadId), new AbortController().signal);
    assert.deepEqual(calls, ["t1"]);
  });
});

describe("agents_list result parsing", () => {
  it("drops entries without a string id or a known status", () => {
    const parsed = parseRosterResult({
      sessionUuid: "s",
      agents: [agent("A"), { id: 4, status: "running" }, { id: "B", status: "weird" }, null, "x", agent("C", "failed")],
    });
    assert.deepEqual(parsed.agents.map((entry) => entry.id), ["A", "C"]);
  });

  it("a non-OMP thread has a null session and no agents", () => {
    assert.deepEqual(parseRosterResult({ sessionUuid: null, agents: [] }), { sessionUuid: null, agents: [] });
  });

  it("rejects payloads that are not rosters", () => {
    for (const bad of [null, "x", {}, { sessionUuid: "s", agents: "no" }]) {
      assert.throws(() => parseRosterResult(bad));
    }
  });
});

describe("parked open requests", () => {
  const globals = globalThis as unknown as { window?: unknown; CustomEvent?: unknown };
  const withWindow = (run: () => void) => {
    const saved = { window: globals.window, CustomEvent: globals.CustomEvent };
    globals.window = { dispatchEvent: () => true };
    globals.CustomEvent = class {};
    try {
      run();
    } finally {
      globals.window = saved.window;
      globals.CustomEvent = saved.CustomEvent;
    }
  };

  it("is taken once, only by the thread it names", () => {
    withWindow(() => {
      requestOpenAgent({ threadId: "t1", agentId: "A" }, 1000);
      assert.equal(takePendingOpen("t2", 1001), null);
      assert.deepEqual(takePendingOpen("t1", 1002), { threadId: "t1", agentId: "A" });
      assert.equal(takePendingOpen("t1", 1003), null);
    });
  });

  it("expires so a stale toast click cannot open an agent later", () => {
    withWindow(() => {
      requestOpenAgent({ threadId: "t1", agentId: "A" }, 1000);
      assert.equal(takePendingOpen("t1", 1000 + PENDING_OPEN_TTL_MS + 1), null);
    });
  });
});

describe("splitPatchByFile", () => {
  const two = [
    "diff --git a/src/a.ts b/src/a.ts",
    "--- a/src/a.ts",
    "+++ b/src/a.ts",
    "@@ -1 +1 @@",
    "-x",
    "+y",
    "diff --git a/b.md b/b.md",
    "--- a/b.md",
    "+++ b/b.md",
    "@@ -1 +1 @@",
    "-1",
    "+2",
    "",
  ].join("\n");

  it("splits a multi-file patch so each file goes to the one-file viewer", () => {
    const files = splitPatchByFile(two);
    assert.deepEqual(files.map((file) => file.path), ["src/a.ts", "b.md"]);
    assert.ok(files[0]?.patch.includes("+y") && !files[0].patch.includes("b.md"));
    assert.ok(files[1]?.patch.startsWith("diff --git a/b.md"));
  });

  it("keeps a headerless hunk as one file and an empty patch as none", () => {
    assert.equal(splitPatchByFile("@@ -1 +1 @@\n-a\n+b\n").length, 1);
    assert.deepEqual(splitPatchByFile("  \n"), []);
    assert.deepEqual(splitPatchByFile(""), []);
  });
});
