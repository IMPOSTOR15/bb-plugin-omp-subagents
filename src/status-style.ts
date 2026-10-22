// One place for how an agent status looks, so the roster and the timeline strip
// never disagree. Plain strings only (no React), so it is unit-testable.
import type { AgentStatus } from "./contract.ts";

export type StatusGlyph = "Loading" | "CircleCheck" | "CircleX" | "CircleSlash" | "CircleDashed";

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
 * bb's "needs you" colour; it is grey with a slashed circle. An orphaned agent
 * (`partial`) is dashed and grey for the same reason.
 */
export function statusStyle(status: AgentStatus): StatusStyle {
  switch (status) {
    case "running":
      return { glyph: "Loading", toneClass: TONE.working, label: "Running", spin: true };
    case "finished":
      return { glyph: "CircleCheck", toneClass: TONE.success, label: "Finished", spin: false };
    case "failed":
      return { glyph: "CircleX", toneClass: TONE.error, label: "Failed", spin: false };
    case "interrupted":
      return { glyph: "CircleSlash", toneClass: TONE.muted, label: "Interrupted", spin: false };
    case "partial":
      return { glyph: "CircleDashed", toneClass: TONE.muted, label: "Stopped without a result", spin: false };
  }
}
