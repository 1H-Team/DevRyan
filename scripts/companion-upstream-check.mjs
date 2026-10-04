// Historical patch-report parsing only; the retired command never accesses upstream.
import { pathToFileURL } from 'node:url';

const semver = (value) => /^v?(\d+)\.(\d+)\.(\d+)$/.exec(value ?? '')?.slice(1).map(Number) ?? null;
export const compareVersions = (a, b) => {
  const left = semver(a), right = semver(b);
  if (!left || !right) return null;
  for (let index = 0; index < 3; index++) if (left[index] !== right[index]) return left[index] - right[index];
  return 0;
};

// `git apply --check` reports "error: patch failed: <file>:<line>" and
// "error: <file>: does not exist in index" for rejected hunks.
export const conflictedFiles = (stderr) => [...new Set(String(stderr).split('\n').flatMap((line) => {
  const failed = /^error: patch failed: (.+):\d+$/.exec(line);
  if (failed) return [failed[1]];
  const missing = /^error: (.+): (?:does not exist in index|No such file or directory)$/.exec(line);
  return missing ? [missing[1]] : [];
}))].sort();

export const summarize = ({ pinned, release, applies, conflicts }) => {
  const comparison = compareVersions(release, pinned);
  if (comparison === null) return { status: 'unknown', message: `Could not compare release ${release} with pinned ${pinned}.` };
  if (comparison <= 0) return { status: 'current', message: `Companion base ${pinned} is current (latest release ${release}).` };
  if (applies) return { status: 'rebase-clean', message: `OpenCode ${release} is available and the companion patch applies cleanly. Update the manifest base and digests, then run bun run build:revert-runtime.` };
  return { status: 'rebase-conflicts', message: `OpenCode ${release} is available; the companion patch conflicts in ${conflicts.length} file(s): ${conflicts.join(', ')}.` };
};

export async function checkCompanionUpstream() {
  throw new Error('Legacy companion patch qualification is retired; native v2 artifacts use sealed local build inputs');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await checkCompanionUpstream();
}
