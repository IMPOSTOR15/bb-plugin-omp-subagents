// bb-plugin-omp-subagents — the shared per-thread roster store.
//
// One module instance serves every consumer in the bundle: the header chip, the
// Hub panel, the transcript panel and each timeline strip (the content script
// runs outside the plugin's React providers, so it cannot use `useRpc`). The
// store owns the single `agents_list` request per thread, the refresh cadence,
// the realtime filter, and the running -> failed transition detection.
//
// Pure TypeScript: timers, clock and transport are injected so the logic is
// testable without a browser.
import type { AgentSummary } from "./contract.ts";

export interface RosterData {
  sessionUuid: string | null;
  agents: AgentSummary[];
}

export interface RosterView {
  /** Null until the first successful load. */
  roster: RosterData | null;
  /** The last failure, cleared by the next success. */
  error: string | null;
  /** True while a request for this thread is in flight. */
  loading: boolean;
}

/** Fallback poll while a thread has subscribers and an agent is running. */
export const POLL_RUNNING_MS = 10_000;
/** Fallback poll while a thread has subscribers and nothing is running. */
export const POLL_IDLE_MS = 30_000;
/** Poll after the last subscriber left, only while an agent still runs. */
export const POLL_BACKGROUND_MS = 30_000;
/** A subscriber arriving within this window of a fetch reuses its data. */
export const STALE_MS = 5_000;

/** The view of a thread nothing is known about. */
export const EMPTY_VIEW: RosterView = { roster: null, error: null, loading: false };

export interface RosterStoreOptions {
  fetchRoster(threadId: string): Promise<RosterData>;
  setTimer(run: () => void, ms: number): unknown;
  clearTimer(handle: unknown): void;
  now(): number;
}

export interface RosterFailure {
  threadId: string;
  agent: AgentSummary;
}

/**
 * Agents that went from running to failed between two loads of one thread.
 * The first load (`previous === null`) never reports: an agent that was already
 * failed when the thread was opened is not news.
 */
export function findNewFailures(
  previous: readonly AgentSummary[] | null,
  next: readonly AgentSummary[],
): AgentSummary[] {
  if (previous === null) return [];
  const wasRunning = new Set(
    previous.filter((agent) => agent.status === "running").map((agent) => agent.id),
  );
  return next.filter((agent) => agent.status === "failed" && wasRunning.has(agent.id));
}

/** The session uuid carried by an `agents-changed` payload; null when malformed. */
export function parseChangedPayload(payload: unknown): string | null {
  if (payload === null || typeof payload !== "object") return null;
  const uuid = (payload as Record<string, unknown>).sessionUuid;
  return typeof uuid === "string" && uuid !== "" ? uuid : null;
}

const hasRunning = (roster: RosterData | null): boolean =>
  roster !== null && roster.agents.some((agent) => agent.status === "running");

interface Subscription {
  listener: () => void;
}

interface ThreadState {
  threadId: string;
  view: RosterView;
  subscriptions: Set<Subscription>;
  inFlight: boolean;
  followUp: boolean;
  timer: unknown;
  fetchedAt: number | null;
}

export interface RosterStore {
  /** Subscribe to one thread's view; returns the unsubscribe function. */
  subscribe(threadId: string, listener: () => void): () => void;
  /** The current view; the same object until the thread's data changes. */
  getView(threadId: string): RosterView;
  /** Ask for a fresh roster (coalesced: one in flight, at most one follow-up). */
  request(threadId: string): void;
  /** An `agents-changed` payload: refetch only threads of that session. */
  handleChanged(payload: unknown): void;
  /** After a realtime reconnect: refetch every active thread. */
  reconcile(): void;
  /** Session uuid of a loaded thread; null when unknown or not OMP. */
  sessionUuidOf(threadId: string): string | null;
  /** Every thread the store has loaded, with its view. */
  entries(): Array<[string, RosterView]>;
  /** Observe every view change of every thread (row statuses). */
  subscribeAll(listener: (threadId: string, view: RosterView) => void): () => void;
  /** Observe running -> failed transitions. */
  onFailure(listener: (failure: RosterFailure) => void): () => void;
}

export function createRosterStore(options: RosterStoreOptions): RosterStore {
  const threads = new Map<string, ThreadState>();
  const anyListeners = new Set<(threadId: string, view: RosterView) => void>();
  const failureListeners = new Set<(failure: RosterFailure) => void>();

  const stateOf = (threadId: string): ThreadState => {
    let state = threads.get(threadId);
    if (state === undefined) {
      state = {
        threadId,
        view: EMPTY_VIEW,
        subscriptions: new Set(),
        inFlight: false,
        followUp: false,
        timer: null,
        fetchedAt: null,
      };
      threads.set(threadId, state);
    }
    return state;
  };

  const setView = (state: ThreadState, next: RosterView): void => {
    const previous = state.view;
    // Keep the old roster object when nothing changed so consumers do not
    // re-render on every poll that found the same data.
    const roster =
      previous.roster !== null &&
      next.roster !== null &&
      JSON.stringify(previous.roster) === JSON.stringify(next.roster)
        ? previous.roster
        : next.roster;
    if (
      roster === previous.roster &&
      next.error === previous.error &&
      next.loading === previous.loading
    ) {
      return;
    }
    state.view = { roster, error: next.error, loading: next.loading };
    for (const subscription of Array.from(state.subscriptions)) subscription.listener();
    for (const listener of Array.from(anyListeners)) listener(state.threadId, state.view);
  };

  const clearTimer = (state: ThreadState): void => {
    if (state.timer !== null) options.clearTimer(state.timer);
    state.timer = null;
  };

  /** The fallback cadence; null means "do not poll this thread". */
  const intervalFor = (state: ThreadState): number | null => {
    const running = hasRunning(state.view.roster);
    if (state.subscriptions.size > 0) return running ? POLL_RUNNING_MS : POLL_IDLE_MS;
    return running ? POLL_BACKGROUND_MS : null;
  };

  const reschedule = (state: ThreadState): void => {
    clearTimer(state);
    const ms = intervalFor(state);
    if (ms === null) return;
    state.timer = options.setTimer(() => {
      state.timer = null;
      request(state.threadId);
    }, ms);
  };

  const run = async (state: ThreadState): Promise<void> => {
    state.inFlight = true;
    state.followUp = false;
    setView(state, { ...state.view, loading: true });
    let loaded: RosterData | null = null;
    let failure = "";
    try {
      loaded = await options.fetchRoster(state.threadId);
    } catch (cause) {
      failure = cause instanceof Error ? cause.message : String(cause);
    }
    state.inFlight = false;
    state.fetchedAt = options.now();
    if (loaded !== null) {
      const previousAgents = state.view.roster?.agents ?? null;
      const failures = findNewFailures(previousAgents, loaded.agents);
      setView(state, { roster: loaded, error: null, loading: false });
      for (const agent of failures) {
        for (const listener of Array.from(failureListeners)) {
          listener({ threadId: state.threadId, agent });
        }
      }
    } else {
      setView(state, { ...state.view, error: failure, loading: false });
    }
    if (state.followUp) {
      await run(state);
      return;
    }
    reschedule(state);
  };

  /**
   * Ask for a fresh roster. At most one request per thread is in flight; any
   * number of requests made meanwhile collapse into exactly one follow-up.
   */
  function request(threadId: string): void {
    const state = stateOf(threadId);
    if (state.inFlight) {
      state.followUp = true;
      return;
    }
    void run(state);
  }

  return {
    /**
     * Subscribe to one thread's view. The first subscriber starts the fallback
     * poll; data younger than STALE_MS is reused instead of refetched.
     */
    subscribe(threadId: string, listener: () => void): () => void {
      const state = stateOf(threadId);
      const subscription: Subscription = { listener };
      state.subscriptions.add(subscription);
      if (!state.inFlight) {
        const fresh =
          state.view.roster !== null &&
          state.fetchedAt !== null &&
          options.now() - state.fetchedAt <= STALE_MS;
        if (fresh) reschedule(state);
        else request(threadId);
      }
      return () => {
        if (!state.subscriptions.delete(subscription)) return;
        if (!state.inFlight) reschedule(state);
      };
    },

    /** The current view; the same object until the thread's data changes. */
    getView(threadId: string): RosterView {
      return threads.get(threadId)?.view ?? EMPTY_VIEW;
    },

    request,

    /**
     * An `agents-changed` signal. Only threads whose loaded session uuid equals
     * the payload's are refetched; a malformed payload refetches nothing.
     */
    handleChanged(payload: unknown): void {
      const sessionUuid = parseChangedPayload(payload);
      if (sessionUuid === null) return;
      for (const state of Array.from(threads.values())) {
        if (state.view.roster?.sessionUuid === sessionUuid) request(state.threadId);
      }
    },

    /** After a realtime reconnect: signals were lost, refetch every active thread. */
    reconcile(): void {
      for (const state of Array.from(threads.values())) {
        if (state.subscriptions.size > 0 || hasRunning(state.view.roster)) {
          request(state.threadId);
        }
      }
    },

    /** Session uuid of a loaded thread; null when unknown or not an OMP session. */
    sessionUuidOf(threadId: string): string | null {
      return threads.get(threadId)?.view.roster?.sessionUuid ?? null;
    },

    /** Every thread the store has loaded, with its view. */
    entries(): Array<[string, RosterView]> {
      return Array.from(threads.values(), (state) => [state.threadId, state.view]);
    },

    /** Observe every view change of every thread (row statuses). */
    subscribeAll(listener: (threadId: string, view: RosterView) => void): () => void {
      anyListeners.add(listener);
      return () => void anyListeners.delete(listener);
    },

    /** Observe running -> failed transitions. */
    onFailure(listener: (failure: RosterFailure) => void): () => void {
      failureListeners.add(listener);
      return () => void failureListeners.delete(listener);
    },
  };
}

// ---- Transport: the one raw-fetch helper -------------------------------------

const RPC_BASE = "/api/v1/plugins/omp-subagents/rpc";

const AGENT_STATUSES: Record<string, true> = {
  running: true,
  finished: true,
  interrupted: true,
  failed: true,
  partial: true,
};

function errorMessage(envelope: unknown, status: number): string {
  if (envelope !== null && typeof envelope === "object") {
    const error = (envelope as Record<string, unknown>).error;
    if (typeof error === "string" && error !== "") return error;
    if (error !== null && typeof error === "object") {
      const message = (error as Record<string, unknown>).message;
      if (typeof message === "string" && message !== "") return message;
    }
  }
  return `agents_list failed (HTTP ${status})`;
}

/**
 * Validate the untrusted `agents_list` result. Agents without a string id or a
 * known status are dropped rather than trusted.
 */
export function parseRosterResult(result: unknown): RosterData {
  if (result === null || typeof result !== "object") {
    throw new Error("agents_list returned an unexpected payload");
  }
  const record = result as Record<string, unknown>;
  const sessionUuid = typeof record.sessionUuid === "string" ? record.sessionUuid : null;
  if (!Array.isArray(record.agents)) {
    throw new Error("agents_list returned an unexpected payload");
  }
  const agents = record.agents.filter(
    (agent): agent is AgentSummary =>
      agent !== null &&
      typeof agent === "object" &&
      typeof (agent as Record<string, unknown>).id === "string" &&
      Object.hasOwn(AGENT_STATUSES, String((agent as Record<string, unknown>).status)),
  );
  return { sessionUuid, agents };
}

/** The store's transport: the plugin RPC route, envelope `{ ok, result }`. */
export async function fetchRoster(threadId: string): Promise<RosterData> {
  const response = await fetch(`${RPC_BASE}/agents_list`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ threadId }),
  });
  let envelope: unknown = null;
  try {
    envelope = await response.json();
  } catch {
    // fall through to the HTTP-status message
  }
  if (
    envelope === null ||
    typeof envelope !== "object" ||
    (envelope as Record<string, unknown>).ok !== true
  ) {
    throw new Error(errorMessage(envelope, response.status));
  }
  return parseRosterResult((envelope as Record<string, unknown>).result);
}

/** The bundle-wide store every consumer shares. */
export const rosterStore: RosterStore = createRosterStore({
  fetchRoster,
  setTimer: (run, ms) => setTimeout(run, ms),
  clearTimer: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
  now: () => Date.now(),
});
