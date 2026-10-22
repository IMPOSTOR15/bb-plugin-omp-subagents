// Pure helpers for reading an OMP `task` spawn result.

/**
 * OMP uniquifies requested names ("TScout" becomes "TScout-2" when taken), so
 * the real agent ids come from the spawn result: "- `<id>` (job `<id>`)".
 */
export function spawnedIdsFromOutput(output: unknown): string[] {
  if (typeof output !== "string") return [];
  const ids: string[] = [];
  for (const match of output.matchAll(/`([A-Za-z0-9][A-Za-z0-9._-]*)` \(job `/g)) {
    const id = match[1];
    if (id !== undefined) ids.push(id);
  }
  return ids;
}
