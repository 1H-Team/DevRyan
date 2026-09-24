// Reports whether the DevRyan companion patch still applies to an upstream
// OpenCode release, so a rebuild happens only when a release needs one. It
// never edits the manifest or builds: a new base requires reviewed digests
// (scripts/build-revert-runtime.mjs refuses unreviewed changes).
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const companion = path.join(root, 'packages/web/server/lib/opencode/companion');
const RELEASE_URL = 'https://api.github.com/repos/anomalyco/opencode/releases/latest';

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

const run = (command, args, cwd) => new Promise((resolve) => {
  const child = spawn(command, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '', stderr = '';
  child.stdout.on('data', (chunk) => { stdout += chunk; });
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  child.once('error', (error) => resolve({ code: -1, stdout, stderr: String(error) }));
  child.once('close', (code) => resolve({ code, stdout, stderr }));
});

export async function checkCompanionUpstream({ release } = {}) {
  const manifest = JSON.parse(await fs.readFile(path.join(companion, 'manifest.json'), 'utf8'));
  let tag = release;
  if (!tag) {
    const response = await fetch(RELEASE_URL, { headers: { Accept: 'application/vnd.github+json' }, signal: AbortSignal.timeout(15_000) });
    if (!response.ok) throw new Error(`Latest release lookup failed (${response.status})`);
    tag = (await response.json()).tag_name;
  }
  const version = String(tag).replace(/^v/, '');
  if ((compareVersions(version, manifest.upstreamVersion) ?? 1) <= 0) {
    return { pinned: manifest.upstreamVersion, release: version, ...summarize({ pinned: manifest.upstreamVersion, release: version }) };
  }
  const checkout = await fs.mkdtemp(path.join(os.tmpdir(), 'devryan-companion-upstream-'));
  try {
    for (const args of [['init', '--quiet'], ['remote', 'add', 'origin', manifest.upstream],
      ['fetch', '--quiet', '--depth=1', 'origin', `refs/tags/${tag}`], ['checkout', '--quiet', 'FETCH_HEAD']]) {
      const result = await run('git', args, checkout);
      if (result.code !== 0) throw new Error(`git ${args[0]} failed: ${result.stderr.trim()}`);
    }
    const check = await run('git', ['apply', '--check', path.join(companion, manifest.patch)], checkout);
    const applies = check.code === 0;
    const conflicts = applies ? [] : conflictedFiles(check.stderr);
    return { pinned: manifest.upstreamVersion, release: version, applies, conflicts,
      ...summarize({ pinned: manifest.upstreamVersion, release: version, applies, conflicts }) };
  } finally { await fs.rm(checkout, { recursive: true, force: true }); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const at = process.argv.indexOf('--release');
  const result = await checkCompanionUpstream({ release: at === -1 ? undefined : process.argv[at + 1] });
  console.log(JSON.stringify(result, null, 2));
  if (process.env.GITHUB_STEP_SUMMARY) await fs.appendFile(process.env.GITHUB_STEP_SUMMARY, `### DevRyan companion upstream check\n\n${result.message}\n`);
  if (result.status === 'rebase-conflicts' || result.status === 'unknown') process.exitCode = 1;
}
