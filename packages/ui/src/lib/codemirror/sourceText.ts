export type SourceChange = { from: number; to: number; insert: string };

export const normalizedEditorText = (source: string): string => source.replace(/\r\n?|\n/g, '\n');

/** Positions are CodeMirror's LF-normalized UTF-16 offsets. Existing line
 * endings remain byte-for-byte intact; inserted breaks use the dominant style. */
export function applySourceChanges(source: string, changes: readonly SourceChange[]): string {
  const breaks: Array<{ offset: number; extra: number }> = [];
  const counts = { '\n': 0, '\r\n': 0, '\r': 0 };
  let extra = 0;
  for (const match of source.matchAll(/\r\n|\r|\n/g)) {
    const ending = match[0] as keyof typeof counts;
    counts[ending]++;
    const offset = match.index - extra;
    extra += ending.length - 1;
    breaks.push({ offset, extra });
  }
  const ending = counts['\r\n'] > counts['\n'] && counts['\r\n'] > counts['\r'] ? '\r\n'
    : counts['\r'] > counts['\n'] && counts['\r'] > counts['\r\n'] ? '\r' : '\n';
  const rawOffset = (position: number) => {
    let low = 0, high = breaks.length;
    while (low < high) {
      const mid = (low + high) >>> 1;
      if (breaks[mid].offset < position) low = mid + 1; else high = mid;
    }
    return position + (low ? breaks[low - 1].extra : 0);
  };
  const pieces: string[] = []; let previous = 0;
  for (const change of changes) {
    const from = rawOffset(change.from), to = rawOffset(change.to);
    pieces.push(source.slice(previous, from), normalizedEditorText(change.insert).replaceAll('\n', ending));
    previous = to;
  }
  pieces.push(source.slice(previous));
  return pieces.join('');
}
