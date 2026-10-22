// bb-plugin-omp-subagents — the bb.host entry.
//
// Runs inside the host daemon on each enrolled machine. It owns every read of
// the OMP session tree and emits `changed` signals whenever a watched session's
// files change, so live rosters update in BB without polling loops.
import { readdir, realpath, stat } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";
import {
  experimental_defineHostEntry,
  type ExperimentalHostRpcContext,
} from "@get-bb/plugin-sdk/host";
import {
  clipOutput,
  parseAgentFile,
  parseLatestTaskAgents,
  parseTranscript,
} from "./omp.ts";
import { hostContract, hostSignals } from "./contract.ts";
import { readHead, readLines, regularFileSize } from "./bounded-read.ts";
import type { AgentSummary } from "./contract.ts";

// Matches the contract's sessions_list `limit` ceiling.
const MAX_SESSION_SCAN = 200;

/** Agent ids are file basenames: flat name, no separators, no dotfiles. */
const AGENT_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/;

class UnsafePathError extends Error {}

/**
 * Confinement: every caller-supplied artifactsDir/agentId pair must resolve
 * to a real directory directly inside the OMP sessions root, and the agent
 * id must be a flat basename. `realpath` defeats `..`, symlinks, and encoded
 * variants; the sessions listing is the source of truth for what exists.
 */
async function confinedArtifactsDir(artifactsDir: string): Promise<string> {
  if (!artifactsDir.startsWith("/")) {
    throw new UnsafePathError("artifactsDir must be absolute");
  }
  const root = sessionsRoot();
  let realRoot: string;
  let realDir: string;
  try {
    realRoot = await realpath(root);
    realDir = await realpath(artifactsDir);
  } catch {
    throw new UnsafePathError("artifactsDir is not a session directory");
  }
  if (realDir === realRoot || !realDir.startsWith(`${realRoot}/`)) {
    throw new UnsafePathError("artifactsDir is not a session directory");
  }
  // exactly one level below the root: <root>/<workspace>/<session>
  const relative = realDir.slice(realRoot.length + 1);
  if (relative.split("/").length !== 2) {
    throw new UnsafePathError(
      "artifactsDir must be a session directory, not a workspace or nested dir",
    );
  }
  return realDir;
}

function safeAgentId(agentId: string): string {
  if (!AGENT_ID.test(agentId) || agentId.includes("..")) {
    throw new UnsafePathError(`invalid agent id: ${agentId}`);
  }
  return agentId;
}

function sessionsRoot(): string {
  return process.env.OMP_SESSIONS_DIR ?? join(homedir(), ".omp/agent/sessions");
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

type SessionEntry = {
  dir: string;
  sessionUuid: string;
  sessionFile: string;
  artifactsDir: string;
  lastModifiedAtMs: number;
};

async function listSessions(): Promise<SessionEntry[]> {
  const root = sessionsRoot();
  const out: SessionEntry[] = [];
  let workspaces;
  try {
    workspaces = await readdir(root, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const ws of workspaces) {
    if (!ws.isDirectory()) continue;
    const wsPath = join(root, ws.name);
    let entries;
    try {
      entries = await readdir(wsPath, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const sessionFile = join(wsPath, `${entry.name}.jsonl`);
      if (!(await pathExists(sessionFile))) continue;
      const artifactsDir = join(wsPath, entry.name);
      try {
        const st = await stat(sessionFile);
        out.push({
          dir: ws.name,
          sessionUuid: entry.name,
          sessionFile,
          artifactsDir,
          lastModifiedAtMs: st.mtimeMs,
        });
      } catch {
        // raced away; skip
      }
    }
  }
  out.sort((a, b) => b.lastModifiedAtMs - a.lastModifiedAtMs);
  return out.slice(0, MAX_SESSION_SCAN);
}

const AGENT_JSONL = /^[A-Za-z0-9][A-Za-z0-9._-]*\.jsonl$/;

async function listAgentFiles(artifactsDir: string): Promise<Array<{ file: string; id: string; mtimeMs: number }>> {
  const out: Array<{ file: string; id: string; mtimeMs: number }> = [];
  // The session dir plus EVERY subdirectory: each parent agent that spawned
  // children has its own folder (<Parent>/<Parent>.<Child>.jsonl).
  for (const dir of await agentDirs(artifactsDir)) {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isFile() || !AGENT_JSONL.test(entry.name)) continue;
      if (entry.name === "__advisor.jsonl") continue;
      const file = join(dir, entry.name);
      try {
        const st = await stat(file);
        out.push({
          file,
          id: entry.name.slice(0, -".jsonl".length),
          mtimeMs: st.mtimeMs,
        });
      } catch {
        // raced away; skip
      }
    }
  }
  return out;
}

async function readAgent(
  info: { file: string; id: string; mtimeMs: number },
): Promise<AgentSummary | null> {
  try {
    const lines = await readLines(info.file, 1_500_000);
    const base = info.file.slice(0, -".jsonl".length);
    const [hasMd, hasJson, hasPatch] = await Promise.all([
      pathExists(`${base}.md`),
      pathExists(`${base}.json`),
      pathExists(`${base}.patch`),
    ]);
    return parseAgentFile(info.id, lines, info.mtimeMs, Date.now(), {
      hasMd,
      hasJson,
      hasPatch,
    });
  } catch {
    return null;
  }
}

/** The directories an agent's files may live in: the session dir and its subdirs. */
const MAX_AGENT_DIR_DEPTH = 4;
const MAX_AGENT_DIRS = 200;

/**
 * The session dir and its subdirectories, breadth-first: each parent that
 * spawned children has a folder, and grandchildren nest deeper. Capped on depth
 * and count; symlinked directories are never entered (`Dirent.isDirectory()`
 * is false for a symlink).
 */
async function agentDirs(confined: string): Promise<string[]> {
  const dirs = [confined];
  let level = [confined];
  for (let depth = 0; depth < MAX_AGENT_DIR_DEPTH && level.length > 0; depth += 1) {
    const next: string[] = [];
    for (const dir of level) {
      let entries;
      try {
        entries = await readdir(dir, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const entry of entries) {
        if (!entry.isDirectory() || dirs.length >= MAX_AGENT_DIRS) continue;
        const child = join(dir, entry.name);
        dirs.push(child);
        next.push(child);
      }
    }
    level = next;
  }
  return dirs;
}

/** Run `fn` over `items` with at most `limit` in flight; results keep input order. */
async function mapPool<T, R>(items: readonly T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      for (let index = next++; index < items.length; index = next++) {
        results[index] = await fn(items[index]!);
      }
    }),
  );
  return results;
}

async function readParentTaskBatch(
  sessionFile: string,
): Promise<Set<string>> {
  try {
    const lines = await readLines(sessionFile, 4_000_000);
    return parseLatestTaskAgents(lines);
  } catch {
    return new Set();
  }
}

// One watch per session dir: sessionUuid -> subscription. Leases keep the
// worker alive while anything is watched.
type WatchState = {
  sessionUuid: string;
  subscription: { dispose(): Promise<void> };
  lease: { dispose(): Promise<void> };
};

const watches = new Map<string, WatchState>();

function sessionUuidFromDir(artifactsDir: string): string {
  const parts = artifactsDir.split("/");
  return parts[parts.length - 1] ?? artifactsDir;
}

/** Watch identity is the full confined path: two workspaces may share a dir name. */
const watchKey = (confined: string): string => confined;

export default experimental_defineHostEntry({
  contract: hostContract,
  experimental_signals: hostSignals,
  handlers: {
    async hostInfo() {
      const root = sessionsRoot();
      return { sessionsRoot: root, exists: await pathExists(root) };
    },

    async sessions_list({ limit }) {
      const sessions = await listSessions();
      let remaining = limit;
      const out: Array<{
        dir: string;
        sessionUuid: string;
        sessionFile: string;
        artifactsDir: string;
        lastModifiedAtMs: number;
        agentCount: number;
      }> = [];
      for (const session of sessions) {
        if (remaining <= 0) break;
        remaining -= 1;
        const agentFiles = await listAgentFiles(session.artifactsDir);
        out.push({
          dir: session.dir,
          sessionUuid: session.sessionUuid,
          sessionFile: session.sessionFile,
          artifactsDir: session.artifactsDir,
          lastModifiedAtMs: session.lastModifiedAtMs,
          agentCount: agentFiles.length,
        });
      }
      return { sessions: out };
    },

    async session_find({ uuid }) {
      // Resolve a bare OMP session uuid to its directory without any listing cap.
      const root = sessionsRoot();
      let workspaces;
      try {
        workspaces = await readdir(root, { withFileTypes: true });
      } catch {
        return { artifactsDir: null };
      }
      for (const ws of workspaces) {
        if (!ws.isDirectory()) continue;
        let entries;
        try {
          entries = await readdir(join(root, ws.name), { withFileTypes: true });
        } catch {
          continue;
        }
        const hit = entries.find(
          (entry) => entry.isDirectory() && entry.name.endsWith(`_${uuid}`),
        );
        if (hit) return { artifactsDir: join(root, ws.name, hit.name) };
      }
      return { artifactsDir: null };
    },

    async agents_list({ artifactsDir }, context) {
      const confined = await confinedArtifactsDir(artifactsDir);
      const sessionFile = `${confined}.jsonl`;
      const [agentFiles, latestBatch] = await Promise.all([
        listAgentFiles(confined),
        readParentTaskBatch(sessionFile),
      ]);
      const agents = (await mapPool(agentFiles, 8, readAgent)).flatMap((agent) =>
        agent === null ? [] : [agent],
      );
      // lineage: "Parent.Child" ids nest under "Parent"
      const nestedByParent = new Map<string, string[]>();
      for (const agent of agents) {
        const dot = agent.id.indexOf(".");
        if (dot <= 0) continue;
        const parent = agent.id.slice(0, dot);
        const siblings = nestedByParent.get(parent) ?? [];
        siblings.push(agent.id);
        nestedByParent.set(parent, siblings);
      }
      for (const agent of agents) {
        agent.nested = nestedByParent.get(agent.id) ?? [];
        agent.spawnedInLatestBatch =
          latestBatch.size > 0 && latestBatch.has(agent.id);
      }
      // keep the worker alive while a roster is being watched
      // Watching is best-effort: a watcher failure must not hide the roster.
      if (!watches.has(watchKey(confined))) {
        await startWatch(context, sessionUuidFromDir(confined), confined).catch(() => undefined);
      }
      agents.sort(
        (a, b) => (b.lastActivityAtMs ?? 0) - (a.lastActivityAtMs ?? 0),
      );
      return { agents };
    },

    async agent_transcript({ artifactsDir, agentId }) {
      const confined = await confinedArtifactsDir(artifactsDir);
      const id = safeAgentId(agentId);
      for (const dir of await agentDirs(confined)) {
        const file = join(dir, `${id}.jsonl`);
        if ((await regularFileSize(file)) === null) continue;
        const lines = await readLines(file, 2_000_000);
        return parseTranscript(lines);
      }
      throw new Error(`No transcript for agent ${id}`);
    },

    async agent_output({ artifactsDir, agentId }) {
      const confined = await confinedArtifactsDir(artifactsDir);
      const id = safeAgentId(agentId);
      for (const dir of await agentDirs(confined)) {
        for (const kind of ["json", "md"] as const) {
          const file = join(dir, `${id}.${kind}`);
          if ((await regularFileSize(file)) === null) continue;
          const head = await readHead(file, 256 * 1024);
          if (head === null) continue;
          const clipped = clipOutput(head.text);
          return { kind, content: clipped.content, truncated: clipped.truncated || head.truncated };
        }
      }
      throw new Error(`No output artifact for agent ${id}`);
    },

    async watch({ path }, context) {
      // watch accepts the same session dirs as agents_list; confinement is
      // the same, but an invalid dir is merely not watched (boolean result).
      const confined = await confinedArtifactsDir(path).catch(() => null);
      if (confined === null) return { watched: false };
      if (watches.has(watchKey(confined))) return { watched: true };
      await startWatch(context, sessionUuidFromDir(confined), confined);
      return { watched: true };
    },
  },

  async dispose() {
    for (const state of watches.values()) {
      await state.subscription.dispose();
      await state.lease.dispose();
    }
    watches.clear();
  },
});

/** In-flight watch starts, so concurrent callers share one subscription. */
const pendingWatches = new Map<string, Promise<void>>();

async function startWatch(
  context: ExperimentalHostRpcContext<typeof hostSignals>,
  sessionUuid: string,
  artifactsDir: string,
): Promise<void> {
  const key = watchKey(artifactsDir);
  if (watches.has(key)) return;
  const inflight = pendingWatches.get(key);
  if (inflight !== undefined) return inflight;
  const created = (async () => {
    const subscription = await context.experimental_watch(
      {
        rootPath: artifactsDir,
        debounceMs: 400,
        maxWaitMs: 1500,
      },
      async (event) => {
        if (event.kind !== "changed") {
          // rescan-required / watch-error: ask the server to refetch everything
          await context.experimental_emitSignal("changed", {
            sessionUuid,
            paths: [],
          });
          return;
        }
        await context.experimental_emitSignal("changed", {
          sessionUuid,
          paths: event.changes
            .map((change) => change.path)
            .filter((path) => AGENT_JSONL.test(path.split("/").pop() ?? "")),
        });
      },
    );
    const lease = context.experimental_retainWorker();
    watches.set(key, { sessionUuid, subscription, lease });
  })();
  pendingWatches.set(key, created);
  try {
    await created;
  } finally {
    // A failed start must be retryable by the next caller.
    pendingWatches.delete(key);
  }
}
