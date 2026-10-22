// One place for how an agent status looks, so the roster and the timeline strip
// never disagree. Plain strings only (no React), so it is unit-testable.
import type { AgentStatus } from "./contract.ts";
import { GLYPHS } from "./glyphs.ts";

export type StatusGlyph = (typeof GLYPHS)["running" | "finished" | "failed" | "interrupted" | "stopped"];

export interface StatusStyle {
  /** bb icon name. */
  glyph: StatusGlyph;
  /** Tailwind class using the plugin's theme-aware tone variables. */
  toneClass: string;
  /** Short accessible label. */
  label: string;
  spin: boolean;
}

const TONE = {
  working: "text-[color:var(--bb-omp-tone-working)]",
  success: "text-[color:var(--bb-omp-tone-success)]",
  error: "text-[color:var(--bb-omp-tone-error)]",
  muted: "text-muted-foreground",
} as const;

/**
 * A killed agent (`interrupted`) did not ask for anything, so it must not wear
 * bb's "needs you" colour; it is a grey stop square. An orphaned agent
 * (`partial`) is an empty grey circle for the same reason.
 */
export function statusStyle(status: AgentStatus): StatusStyle {
  switch (status) {
    case "running":
      return { glyph: GLYPHS.running, toneClass: TONE.working, label: "Running", spin: true };
    case "finished":
      return { glyph: GLYPHS.finished, toneClass: TONE.success, label: "Finished", spin: false };
    case "failed":
      return { glyph: GLYPHS.failed, toneClass: TONE.error, label: "Failed", spin: false };
    case "interrupted":
      return { glyph: GLYPHS.interrupted, toneClass: TONE.muted, label: "Interrupted", spin: false };
    case "partial":
      return { glyph: GLYPHS.stopped, toneClass: TONE.muted, label: "Stopped without a result", spin: false };
  }
}
