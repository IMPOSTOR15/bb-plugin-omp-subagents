// One-line activity label shared by the roster row and the timeline strip.
import type { AgentSummary } from "./contract.ts";

type ActivityFields = Pick<AgentSummary, "status" | "currentTool" | "currentToolIntent" | "task">;

/**
 * What an agent is doing right now. A running agent shows its current tool and
 * intent; `wait`/`yield` mean it is idle on purpose; a settled agent shows its
 * task, so the line never ends in a dangling "tool:".
 */
export function activityLine(agent: ActivityFields): string {
  if (agent.status !== "running") return agent.task;
  const tool = agent.currentTool;
  if (tool === null || tool === "wait" || tool === "yield") return "waiting";
  const intent = agent.currentToolIntent?.trim() ?? "";
  return intent === "" ? tool : `${tool}: ${intent}`;
}
