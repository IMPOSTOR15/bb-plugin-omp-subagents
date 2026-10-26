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
 * away. `openSeq` differs on every explicit open, so opening the same target
 * again (the same agent after going back to the roster) still re-points a
 * panel whose other params did not change.
 */
export interface HubParams {
  threadId: string | null;
  agentId: string | null;
  openSeq: number | null;
}

export function parseHubParams(params: unknown): HubParams {
  const field = (key: string): unknown =>
    params === null || typeof params !== "object" || !(key in params)
      ? undefined
      : (params as Record<string, unknown>)[key];
  const text = (key: string): string | null => {
    const value = field(key);
    return typeof value === "string" && value !== "" ? value : null;
  };
  const seq = field("openSeq");
  return {
    threadId: text("threadId"),
    agentId: text("agentId"),
    openSeq: typeof seq === "number" && Number.isFinite(seq) ? seq : null,
  };
}

let lastOpenSeq = 0;

/** Params for one explicit open of the hub panel, stamped with a fresh `openSeq`. */
export function hubPanelParams(target: {
  threadId: string;
  projectId: string | null;
  agentId?: string;
}): { threadId: string; projectId: string | null; agentId?: string; openSeq: number } {
  lastOpenSeq += 1;
  return { ...target, openSeq: lastOpenSeq };
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
