// bb-plugin-omp-subagents — plain-text renderings of the host's read results.
// The CLI prints them as is; the agent tools clip them to a bounded size.
import type { AgentSummary, TranscriptEntry } from "./contract.ts";

export function rosterText(agents: readonly AgentSummary[]): string {
  if (agents.length === 0) return "No subagents.";
  return agents
    .map(
      (agent) =>
        `${agent.status.padEnd(10)} ${agent.id.padEnd(24)} ${agent.toolCount} tools  ${agent.task.slice(0, 80)}`,
    )
    .join("\n");
}

export function transcriptText(entries: readonly TranscriptEntry[]): string {
  return entries.map((entry) => `${entry.role}: ${entry.summary}`).join("\n");
}

/** Room kept for the cut notice, so the result never exceeds `max`. */
const NOTICE_RESERVE = 100;

/**
 * Fit `text` into `max` characters, notice included, and say when it was cut.
 * `keep` picks the end that survives: a transcript's newest rows matter most,
 * an output's opening does. Never splits a surrogate pair.
 */
export function clipReport(text: string, max: number, keep: "head" | "tail"): string {
  if (text.length <= max) return text;
  const budget = max - NOTICE_RESERVE;
  if (keep === "head") {
    let end = budget;
    if (isLowSurrogate(text.charCodeAt(end))) end -= 1;
    return `${text.slice(0, end)}\n[cut: first ${end} of ${text.length} characters shown]`;
  }
  let start = text.length - budget;
  if (isLowSurrogate(text.charCodeAt(start))) start += 1;
  return `[cut: last ${text.length - start} of ${text.length} characters shown]\n${text.slice(start)}`;
}

function isLowSurrogate(code: number): boolean {
  return code >= 0xdc00 && code <= 0xdfff;
}
