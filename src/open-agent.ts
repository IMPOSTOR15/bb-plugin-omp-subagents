// A click on an agent in the timeline strip must open that agent's history in
// the side panel. The strip lives in its own React root, outside bb's
// navigation context, so it only announces the request on `window`; the
// thread-header component, which does have navigation, performs it.

/** The DOM event the strip dispatches and the thread header listens for. */
export const OPEN_AGENT_EVENT = "omp-subagents:open-agent";

export interface OpenAgentRequest {
  threadId: string;
  agentId: string;
}

/** Validate an event's untrusted `detail`; null when it is not a request. */
export function parseOpenAgentRequest(detail: unknown): OpenAgentRequest | null {
  if (detail === null || typeof detail !== "object") return null;
  const threadId = "threadId" in detail ? detail.threadId : undefined;
  const agentId = "agentId" in detail ? detail.agentId : undefined;
  if (typeof threadId !== "string" || threadId === "") return null;
  if (typeof agentId !== "string" || agentId === "") return null;
  return { threadId, agentId };
}

/**
 * Panel params: a thread to show and, optionally, an agent to open straight
 * away. They name the target and nothing else: bb focuses an open tab whose
 * params are identical instead of adding another one.
 */
export interface HubParams {
  threadId: string | null;
  agentId: string | null;
}

export function parseHubParams(params: unknown): HubParams {
  const text = (key: string): string | null => {
    const value =
      params === null || typeof params !== "object" || !(key in params)
        ? undefined
        : (params as Record<string, unknown>)[key];
    return typeof value === "string" && value !== "" ? value : null;
  };
  return { threadId: text("threadId"), agentId: text("agentId") };
}

export interface HubTarget {
  threadId: string;
  projectId: string | null;
  agentId?: string;
}

export interface HubOpenOptions {
  actionId: "hub";
  title: string;
  params: { threadId: string; projectId: string | null; agentId?: string };
}

type HubOpened = { threadId: string; agentId: string | null };

const hubOpenListeners = new Set<(opened: HubOpened) => void>();

/**
 * Open the hub panel at `target` through `open`, any of bb's openPanel entry
 * points. A focused tab keeps its own state, so after an accepted open the
 * panel showing this target is told to show it again: the same agent after
 * the user went back to the roster in that tab.
 */
export function openHubPanel(open: (options: HubOpenOptions) => boolean, target: HubTarget): boolean {
  const params =
    target.agentId === undefined
      ? { threadId: target.threadId, projectId: target.projectId }
      : { threadId: target.threadId, projectId: target.projectId, agentId: target.agentId };
  const accepted = open({ actionId: "hub", title: target.agentId ?? "OMP Subagents", params });
  if (accepted) {
    const opened = { threadId: target.threadId, agentId: target.agentId ?? null };
    for (const listener of hubOpenListeners) listener(opened);
  }
  return accepted;
}

/** Subscribe a mounted hub panel to accepted opens; returns the unsubscribe. */
export function onHubOpen(listener: (opened: HubOpened) => void): () => void {
  hubOpenListeners.add(listener);
  return () => {
    hubOpenListeners.delete(listener);
  };
}

/** A parked request is dropped after this long: it was not meant for later. */
export const PENDING_OPEN_TTL_MS = 15_000;

let pending: { request: OpenAgentRequest; at: number } | null = null;

/** Ask the thread header for `request.threadId` to open that agent. */
export function requestOpenAgent(request: OpenAgentRequest, now = Date.now()): void {
  pending = { request, at: now };
  window.dispatchEvent(new CustomEvent(OPEN_AGENT_EVENT, { detail: request }));
}

/**
 * Take the parked request for `threadId` if it is still fresh; a request for
 * another thread, or an expired one, is left alone / dropped respectively.
 */
export function takePendingOpen(threadId: string, now = Date.now()): OpenAgentRequest | null {
  if (pending === null) return null;
  if (now - pending.at > PENDING_OPEN_TTL_MS) {
    pending = null;
    return null;
  }
  if (pending.request.threadId !== threadId) return null;
  const { request } = pending;
  pending = null;
  return request;
}
