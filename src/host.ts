// bb-plugin-omp-subagents — the bb.host entry.
//
// Runs inside the host daemon on each enrolled machine. It owns every read of
// the OMP session tree and emits `changed` signals whenever a watched session's
// files change, so live rosters update in BB without polling loops.
import { readdir, realpath, stat } from "node:fs/promises";
import { basename, isAbsolute, join, relative, sep, type PlatformPath } from "node:path";
import { homedir } from "node:os";
import {
  experimental_defineHostEntry,
  type ExperimentalHostRpcContext,
} from "@get-bb/plugin-sdk/host";
import {
  clipOutput,
  finalizeAgent,
  parseAgentRows,
  parseLatestTaskAgents,
  parseTranscript,
} from "./omp.ts";
import type { ParsedAgent } from "./omp.ts";
import { hostContract, hostSignals } from "./contract.ts";
import { readHead, readLines, regularFileSize, regularFileStat } from "./bounded-read.ts";
import type { AgentSummary } from "./contract.ts";

// Matches the contract's sessions_list `limit` ceiling.
const MAX_SESSION_SCAN = 200;

/** Agent ids are file basenames: flat name, no separators, no dotfiles. */
const AGENT_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/;

class UnsafePathError extends Error {}

/**
 * The path functions that parse a host path. The host's own flavor by default;
 * Windows paths use `\` and a drive letter, so nothing here splits on `/`.
 */
export type PathFlavor = Pick<PlatformPath, "basename" | "isAbsolute" | "relative" | "sep">;

const NATIVE_PATH: PathFlavor = { basename, isAbsolute, relative, sep };

/**
 * True when `dir` is exactly `<root>/<workspace>/<session>`. Both must already
 * be realpath'ed. On Windows `relative` compares case-insensitively and returns
 * an absolute path when `dir` is on another drive.
 */
export function isSessionDirUnder(root: string, dir: string, p: PathFlavor = NATIVE_PATH): boolean {
  const rel = p.relative(root, dir);
  if (rel === "" || p.isAbsolute(rel)) return false;
  const parts = rel.split(p.sep);
  return parts.length === 2 && !parts.includes("..");
}

/**
 * Confinement: every caller-supplied artifactsDir/agentId pair must resolve
 * to a real directory directly inside the OMP sessions root, and the agent
 * id must be a flat basename. `realpath` defeats `..`, symlinks, and encoded
 * variants; the sessions listing is the source of truth for what exists.
 */
async function confinedArtifactsDir(artifactsDir: string): Promise<string> {
  if (!isAbsolute(artifactsDir)) {
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
  if (!isSessionDirUnder(realRoot, realDir)) {
    throw new UnsafePathError("artifactsDir is not a session directory");
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

/** Every file an agent leaves: transcript, final output, isolated-run patch. */
const AGENT_ARTIFACT = /^[A-Za-z0-9][A-Za-z0-9._-]*\.(jsonl|md|json|patch)$/;

/** A changed path matters to rosters only when it is an agent's own file. */
export function isAgentArtifact(file: string, p: PathFlavor = NATIVE_PATH): boolean {
  const name = p.basename(file);
  return name !== "__advisor.jsonl" && AGENT_ARTIFACT.test(name);
}

type AgentFileInfo = { file: string; id: string; mtimeMs: number; size: number };

async function listAgentFiles(artifactsDir: string): Promise<AgentFileInfo[]> {
  const out: AgentFileInfo[] = [];
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
          size: st.size,
        });
      } catch {
        // raced away; skip
      }
    }
  }
  return out;
}

// ---- Parse caches -------------------------------------------------------------
//
// A roster is refetched often while agents run, but most transcripts (and the
// parent session file) have not changed between two calls. The now-independent
// parse is cached per file version (mtime + size); the clock- and
// artifact-dependent fields are recomputed on every call (`finalizeAgent`).
// Both caches are LRU-bounded, pruned to what a session still lists, and
// dropped with the session's watch.

const MAX_CACHED_TRANSCRIPTS = 1000;
const MAX_CACHED_PARENT_BATCHES = 64;

type FileVersion = { mtimeMs: number; size: number };

const transcriptCache = new Map<string, FileVersion & { parsed: ParsedAgent }>();
const parentBatchCache = new Map<string, FileVersion & { batch: Set<string> }>();

/** Re-insert as newest, then evict the oldest entries beyond `max`. */
function remember<V>(cache: Map<string, V>, key: string, value: V, max: number): void {
  cache.delete(key);
  cache.set(key, value);
  while (cache.size > max) {
    const oldest = cache.keys().next();
    if (oldest.done) break;
    cache.delete(oldest.value);
  }
}

/** Forget cached parses under `confined` that `keep` does not list. */
function pruneSessionCache(confined: string, keep: ReadonlySet<string>): void {
  const prefix = `${confined}${sep}`;
  for (const file of transcriptCache.keys()) {
    if (file.startsWith(prefix) && !keep.has(file)) transcriptCache.delete(file);
  }
}

function dropSessionCache(confined: string): void {
  pruneSessionCache(confined, new Set());
  parentBatchCache.delete(`${confined}.jsonl`);
}

async function readAgent(
  info: AgentFileInfo,
  now: number,
): Promise<AgentSummary | null> {
  try {
    let parsed: ParsedAgent;
    const cached = transcriptCache.get(info.file);
    if (cached !== undefined && cached.mtimeMs === info.mtimeMs && cached.size === info.size) {
      parsed = cached.parsed;
      remember(transcriptCache, info.file, cached, MAX_CACHED_TRANSCRIPTS);
    } else {
      // Keyed by the version stat'ed BEFORE the read: a file that grows
      // meanwhile only costs one extra parse next call, never a stale hit.
      parsed = parseAgentRows(info.id, await readLines(info.file, 1_500_000));
      remember(
        transcriptCache,
        info.file,
        { mtimeMs: info.mtimeMs, size: info.size, parsed },
        MAX_CACHED_TRANSCRIPTS,
      );
    }
    const base = info.file.slice(0, -".jsonl".length);
    // Artifacts appear without the transcript changing: checked on every call.
    const [hasMd, hasJson, hasPatch] = await Promise.all([
      pathExists(`${base}.md`),
      pathExists(`${base}.json`),
      pathExists(`${base}.patch`),
    ]);
    return finalizeAgent(parsed, info.mtimeMs, now, { hasMd, hasJson, hasPatch });
  } catch {
    transcriptCache.delete(info.file);
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
    const version = await regularFileStat(sessionFile);
    if (version === null) throw new Error("not a regular file");
    const cached = parentBatchCache.get(sessionFile);
    if (cached !== undefined && cached.mtimeMs === version.mtimeMs && cached.size === version.size) {
      remember(parentBatchCache, sessionFile, cached, MAX_CACHED_PARENT_BATCHES);
      return cached.batch;
    }
    const batch = parseLatestTaskAgents(await readLines(sessionFile, 4_000_000));
    remember(
      parentBatchCache,
      sessionFile,
      { mtimeMs: version.mtimeMs, size: version.size, batch },
      MAX_CACHED_PARENT_BATCHES,
    );
    return batch;
  } catch {
    parentBatchCache.delete(sessionFile);
    return new Set();
  }
}

// One watch per session dir. Leases keep the worker alive while anything is
// watched; a watch nobody has read for WATCH_IDLE_MS is released by the sweep.
type WatchState = {
  sessionUuid: string;
  subscription: { dispose(): Promise<void> };
  lease: { dispose(): Promise<void> };
  lastUsedAtMs: number;
};

const watches = new Map<string, WatchState>();

/**
 * Bumped by dispose(). A watch start that began under an older generation (an
 * agents_list still in flight when the entry was disposed) releases its own
 * subscription instead of registering it, so nothing outlives the entry.
 */
let generation = 0;

/** A roster nobody has asked for in this long is not being looked at. */
const WATCH_IDLE_MS = 5 * 60_000;
const WATCH_SWEEP_INTERVAL_MS = 60_000;

let sweepTimer: ReturnType<typeof setInterval> | null = null;

function stopSweepTimer(): void {
  if (sweepTimer === null) return;
  clearInterval(sweepTimer);
  sweepTimer = null;
}

function ensureSweepTimer(): void {
  if (sweepTimer !== null) return;
  sweepTimer = setInterval(() => {
    void sweepIdleWatches(Date.now());
  }, WATCH_SWEEP_INTERVAL_MS);
  sweepTimer.unref();
}

async function releaseWatch(state: WatchState): Promise<void> {
  // Both must run even if the first fails, or the lease would pin the worker.
  await Promise.allSettled([state.subscription.dispose(), state.lease.dispose()]);
}

/** Release every watch not used for more than WATCH_IDLE_MS before `now`. */
export async function sweepIdleWatches(now: number): Promise<void> {
  const idle: Array<[string, WatchState]> = [];
  for (const entry of watches) {
    if (now - entry[1].lastUsedAtMs > WATCH_IDLE_MS) idle.push(entry);
  }
  // Leave the map first: a call arriving mid-release starts a fresh watch.
  for (const [key] of idle) {
    watches.delete(key);
    dropSessionCache(key);
  }
  if (watches.size === 0) stopSweepTimer();
  await Promise.all(idle.map(([, state]) => releaseWatch(state)));
}

/** Mark a session's watch as in use; a no-op when it is not watched. */
function touchWatch(confined: string): void {
  const state = watches.get(watchKey(confined));
  if (state !== undefined) state.lastUsedAtMs = Date.now();
}

/** The OMP session uuid: the part of `<timestamp>_<uuid>` after the last `_`. */
export function sessionUuidFromDir(artifactsDir: string, p: PathFlavor = NATIVE_PATH): string {
  const name = p.basename(artifactsDir);
  return name.slice(name.lastIndexOf("_") + 1);
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
      const startedIn = generation;
      const confined = await confinedArtifactsDir(artifactsDir);
      // Watch before reading: a change landing between the read and the watch
      // start would otherwise go unsignalled. Best-effort: a watcher failure
      // must not hide the roster.
      if (watches.has(watchKey(confined))) touchWatch(confined);
      else {
        await startWatch(context, sessionUuidFromDir(confined), confined, startedIn).catch(
          () => undefined,
        );
      }
      const now = Date.now();
      const sessionFile = `${confined}.jsonl`;
      const [agentFiles, latestBatch] = await Promise.all([
        listAgentFiles(confined),
        readParentTaskBatch(sessionFile),
      ]);
      pruneSessionCache(confined, new Set(agentFiles.map((info) => info.file)));
      const agents = (await mapPool(agentFiles, 8, (info) => readAgent(info, now))).flatMap((agent) =>
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
      agents.sort(
        (a, b) => (b.lastActivityAtMs ?? 0) - (a.lastActivityAtMs ?? 0),
      );
      return { agents };
    },

    async agent_transcript({ artifactsDir, agentId }) {
      const confined = await confinedArtifactsDir(artifactsDir);
      touchWatch(confined);
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
      touchWatch(confined);
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

    async agent_patch({ artifactsDir, agentId }) {
      const confined = await confinedArtifactsDir(artifactsDir);
      touchWatch(confined);
      const id = safeAgentId(agentId);
      for (const dir of await agentDirs(confined)) {
        const file = join(dir, `${id}.patch`);
        if ((await regularFileSize(file)) === null) continue;
        const head = await readHead(file, 256 * 1024);
        if (head === null) continue;
        const clipped = clipOutput(head.text);
        return { content: clipped.content, truncated: clipped.truncated || head.truncated };
      }
      throw new Error(`No patch for agent ${id}`);
    },
  },

  async dispose() {
    generation += 1;
    // Starts still in flight see the new generation and release their own
    // subscription; wait for them so dispose returns with nothing left open.
    await Promise.allSettled([...pendingWatches.values()]);
    stopSweepTimer();
    const all = [...watches.values()];
    watches.clear();
    transcriptCache.clear();
    parentBatchCache.clear();
    await Promise.all(all.map(releaseWatch));
  },
});

/** In-flight watch starts, so concurrent callers share one subscription. */
const pendingWatches = new Map<string, Promise<void>>();

async function startWatch(
  context: ExperimentalHostRpcContext<typeof hostSignals>,
  sessionUuid: string,
  artifactsDir: string,
  startedIn: number,
): Promise<void> {
  if (startedIn !== generation) return;
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
        // Tool logs and other shared artifacts churn constantly and change no
        // roster field: only an agent's own files are worth a refetch.
        const paths = event.changes
          .map((change) => change.path)
          .filter((file) => isAgentArtifact(file));
        if (paths.length === 0) return;
        await context.experimental_emitSignal("changed", { sessionUuid, paths });
      },
    );
    if (startedIn !== generation) {
      await subscription.dispose();
      return;
    }
    const lease = context.experimental_retainWorker();
    watches.set(key, { sessionUuid, subscription, lease, lastUsedAtMs: Date.now() });
    ensureSweepTimer();
  })();
  pendingWatches.set(key, created);
  try {
    await created;
  } finally {
    // A failed start must be retryable by the next caller.
    pendingWatches.delete(key);
  }
}
