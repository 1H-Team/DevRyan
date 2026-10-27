const PORCELAIN_ROW = /^([ =*+!\-])\t([^\t]*):([^\t]*)\t(.*)$/;

export const PUSH_HOOK_SUMMARY_MAX = 160;
export const PUSH_HOOK_DETAILS_LINES = 60;
const PUSH_HOOK_DETAILS_LINE_MAX = 500;

export function parsePushResult(output, directory) {
  const pushed = [];
  const rejected = [];
  for (const line of String(output || '').split('\n')) {
    const match = PORCELAIN_ROW.exec(line);
    if (!match) continue;
    const row = { local: match[2], remote: match[3], status: match[1], summary: match[4] };
    (match[1] === '!' ? rejected : pushed).push(row);
  }
  return { success: rejected.length === 0, pushed, rejected, repo: directory, ref: pushed.length === 1 ? pushed[0].remote : null };
}

/** A user-facing message for porcelain `!` rows, e.g. "main: rejected (fetch first)". */
export function pushRejectedMessage(rejected) {
  const refs = rejected.map((row) => `${row.remote.replace(/^refs\/heads\//, '')}: ${row.summary.replace(/^\[|\]/g, '')}`);
  const needsSync = rejected.some((row) => /fetch first|non-fast-forward/i.test(row.summary));
  return `Push rejected for ${refs.join(', ')}.${needsSync ? ' Use Sync to integrate remote changes, resolve any conflicts, then push again.' : ''}`;
}

// Hook and transport output can echo remote URLs or tokens; never forward them.
const CREDENTIAL_PATTERNS = [
  [/([a-z][a-z0-9+.-]*:\/\/)[^\s/@]+@/gi, '$1***@'],
  [/\b(gh[opsur]_|github_pat_|glpat-)[A-Za-z0-9_-]{8,}/g, '$1***'],
  [/\b(basic|bearer)\s+[A-Za-z0-9+/._~=-]{8,}/gi, '$1 ***'],
  [/\b(authorization|password|passwd|token|secret|api[_-]?key)(\s*[:=]\s*)(?!(?:basic|bearer) \*\*\*)\S+/gi, '$1$2***'],
];

const GIT_FAILED_REFS_LINE = /^(?:error:\s*)?failed to push some refs/i;
const HOOK_FAILURE_MARKER = /✖|\bFAIL\b|failing|AssertionError|Error:/;

/** One ANSI-stripped, credential-scrubbed line, or empty when nothing remains. */
export function scrubGitOutput(raw) {
  // eslint-disable-next-line no-control-regex
  let line = String(raw ?? '').replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, '').replace(/[\u0000-\u001f\u007f]/g, ' ').trim();
  for (const [pattern, replacement] of CREDENTIAL_PATTERNS) line = line.replace(pattern, replacement);
  return line.replace(/^remote:\s*/, '').trim();
}

const boundLine = (line, max) => (line.length > max ? `${line.slice(0, max - 1)}…` : line);

const scrubbedLines = (text) => String(text || '').split(/\r\n|\r|\n/).map(scrubGitOutput).filter(Boolean);

/** First hook failure marker, excluding Git's own `error: failed to push…`. */
export function pushHookFailureSummary(text) {
  for (const line of scrubbedLines(text)) {
    if (/^(?:✔|✓|ok\b)/i.test(line) || GIT_FAILED_REFS_LINE.test(line) || !HOOK_FAILURE_MARKER.test(line)) continue;
    return boundLine(line, PUSH_HOOK_SUMMARY_MAX);
  }
  return null;
}

/** Last ~60 scrubbed lines of hook output, for a Copy-output toast action. */
export function pushHookFailureDetails(text) {
  return scrubbedLines(text)
    .map((line) => boundLine(line, PUSH_HOOK_DETAILS_LINE_MAX))
    .slice(-PUSH_HOOK_DETAILS_LINES)
    .join('\n');
}

export function pushOptionArgs(options) {
  if (Array.isArray(options)) return [...options];
  if (!options || typeof options !== 'object') return [];
  return Object.entries(options).flatMap(([key, value]) => value == null ? [key] : [`${key}=${value}`]);
}
