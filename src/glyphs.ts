// Every icon name this plugin draws, in one place. bb's icon set is a subset of
// the usual icon libraries: a name it lacks does not error, it renders the Zap
// (lightning bolt) fallback. Each name below was probed in the running app.
export const GLYPHS = {
  roster: "Bot",
  agentsChip: "UserRoundPlus",
  back: "ArrowLeft",
  spinner: "Loading",
  running: "Loading",
  finished: "CircleCheck",
  failed: "CircleX",
  interrupted: "Square",
  stopped: "Circle",
  /** The transcript view's follow-latest toggle. */
  following: "Check",
  paused: "Pause",
  /** A tool call in a transcript. */
  tool: "Minus",
  send: "Check",
} as const;

export type GlyphName = (typeof GLYPHS)[keyof typeof GLYPHS];

/** Names confirmed to exist in bb's icon set. */
export const VERIFIED_BB_GLYPHS = [
  "Bot",
  "UserRoundPlus",
  "ArrowLeft",
  "Loading",
  "CircleCheck",
  "CircleX",
  "Square",
  "Circle",
  "Check",
  "Pause",
  "Minus",
] as const;
