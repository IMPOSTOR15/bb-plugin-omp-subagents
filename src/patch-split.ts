// An agent's `.patch` may cover several files; bb's diff viewer takes a unified
// patch for exactly ONE file, so the patch is split per file first.

export interface FilePatch {
  path: string;
  patch: string;
}

const HEADER = /^diff --git a\/(.+?) b\/(.+)$/;

/**
 * Split a git-style unified patch at its `diff --git` headers. A patch without
 * any header (a bare hunk list) is returned as one entry named `path`. Text
 * before the first header is dropped; a trailing newline is kept per entry.
 */
export function splitPatchByFile(patch: string, fallbackPath = "changes.patch"): FilePatch[] {
  const lines = patch.split("\n");
  const files: FilePatch[] = [];
  let current: { path: string; lines: string[] } | null = null;
  for (const line of lines) {
    const header = HEADER.exec(line);
    if (header !== null) {
      if (current !== null) files.push({ path: current.path, patch: current.lines.join("\n") });
      current = { path: header[2] ?? fallbackPath, lines: [line] };
    } else if (current !== null) {
      current.lines.push(line);
    }
  }
  if (current !== null) files.push({ path: current.path, patch: current.lines.join("\n") });
  if (files.length > 0) return files;
  return patch.trim() === "" ? [] : [{ path: fallbackPath, patch }];
}
