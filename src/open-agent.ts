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

/** Panel params: a thread to show and, optionally, an agent to open straight away. */
export interface HubParams {
  threadId: string | null;
  agentId: string | null;
}

export function parseHubParams(params: unknown): HubParams {
  const read = (key: string): string | null => {
    if (params === null || typeof params !== "object" || !(key in params)) return null;
    const value = (params as Record<string, unknown>)[key];
    return typeof value === "string" && value !== "" ? value : null;
  };
  return { threadId: read("threadId"), agentId: read("agentId") };
}
