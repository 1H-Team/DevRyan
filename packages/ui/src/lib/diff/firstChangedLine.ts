export const getFirstChangedModifiedLineFromPatch = (patch: string): number | null => {
  if (!patch) {
    return null;
  }

  let modifiedLine: number | null = null;
  for (const rawLine of patch.split('\n')) {
    const line = rawLine.replace(/\r$/, '');
    const hunk = line.match(/^@@\s+-\d+(?:,\d+)?\s+\+(\d+)(?:,\d+)?\s+@@/);
    if (hunk) {
      const parsed = Number.parseInt(hunk[1] ?? '', 10);
      modifiedLine = Number.isFinite(parsed) ? Math.max(1, parsed) : null;
      continue;
    }
    if (modifiedLine === null) {
      continue;
    }
    if (line.startsWith('+++') || line.startsWith('---') || line.startsWith('diff ')) {
      continue;
    }
    if (line.startsWith('+') || line.startsWith('-')) {
      return modifiedLine;
    }
    if (line.startsWith(' ')) {
      modifiedLine += 1;
    }
  }

  return null;
};
