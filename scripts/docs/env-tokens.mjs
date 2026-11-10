// Docs drift check `env`: every `DEVRYAN_*`, `OPENCHAMBER_*` or `OPENCODE_*`
// token in a document, prose or code block, must occur in non-Markdown code, so
// a documented switch that nothing reads any more is caught.
// - A token ending in `_` (`DEVRYAN_TUNNEL_*`) names a prefix: some code token must start with it.
// - `OPENCHAMBER_<X>` passes when code has `DEVRYAN_<X>`: shared-runtime's
//   `legacy-environment.js` accepts the legacy name for every DevRyan variable.
// - The code corpus is every tracked or untracked, non-ignored, non-Markdown text
//   file except this validator's own folder (so the baseline and these
//   allowlists never count as readers) and except tests and fixtures (so a
//   variable that only a test sets does not count as read by the product).
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const TOKEN = /(?<![A-Za-z0-9_])(?:DEVRYAN|OPENCHAMBER|OPENCODE)_[A-Z0-9_]*/g;

// Prefixes documents may name although no code token starts with them, mapped
// to the reason. A prefix (or any variable under it) listed here always passes.
// Keep entries rare: a prefix that code really uses passes on its own. Empty
// today: every prefix the docs name occurs in code.
export const ALLOWED_PREFIXES = new Map([
]);

// Variables OpenCode itself reads or sets, which DevRyan documents for the host
// it runs although its own code need not name them, mapped to the reason. Empty
// today. An entry passes the token in every document, so do not list a
// variable whose doc claims DevRyan sets or removes it (that claim is drift,
// e.g. `OPENCODE_DISABLE_DEFAULT_PLUGINS` and `OPENCODE_DISABLE_EXTERNAL_SKILLS`
// in known-drift.json): fix that doc first, then list the variable here.
export const OPENCODE_OWNED = new Map([
]);

// Switches that only tests, QA or benchmarks read (so they live outside the
// code corpus) and that docs legitimately tell a developer to set, mapped to
// the reader and the reason.
export const TEST_ONLY = new Map([
  ['DEVRYAN_NATIVE_STREAM_COMPILED_SETTERS', 'scripts/opencode-v2-native/native-stream-continuation.graph.test.ts: opt-in to the compiled-setter graph cases'],
  ['DEVRYAN_TEST_OPENCODE_BIN', 'tests/provider-recovery/runtime-conformance.mjs: the OpenCode binary under test'],
  ['DEVRYAN_UI_PERF', 'tests/visual-chat-improvements/run.mjs: opt-in perf comparison'],
  ['DEVRYAN_VIEW_PREWARM_BENCHMARK', 'packages/harness-runtime/lib/session-mutations-view-reuse.test.js: opt-in prewarm benchmark'],
]);

/** Distinct tokens of a document, in first-seen order. */
export function documentEnvTokens(source) {
  return [...new Set(source.match(TOKEN) ?? [])];
}

// Markdown, this validator's folder (baseline, allowlists, its own tests), and
// tests and fixtures: a variable that only a test sets is not read by the product.
// (Pathspec `*` also matches `/`, so `*.test.*` and `*/fixtures/*` apply at any depth.)
const CODE_EXCLUDES = [':!*.md', ':!*.mdx', ':!scripts/docs/', ':!*.test.*', ':!tests/', ':!fixtures/', ':!*/fixtures/*'];

const CODE_PATTERN = '(DEVRYAN|OPENCHAMBER|OPENCODE)_[A-Z0-9_]*';

function grepCode(root, mode) {
  try {
    return execFileSync('git', ['grep', '--untracked', '-I', '-h', '-o', mode, CODE_PATTERN, '--', '.', ...CODE_EXCLUDES],
      { cwd: root, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (error) {
    if (error.status === 1) return ''; // no match
    throw error;
  }
}

/**
 * Every DEVRYAN_/OPENCHAMBER_/OPENCODE_ token in the non-Markdown code corpus,
 * matched anywhere (so `VITE_DEVRYAN_X` also yields `DEVRYAN_X`). Perl-compatible
 * grep is several times faster; Git builds without PCRE fall back to ERE.
 */
export function codeEnvTokens(root) {
  let output;
  try { output = grepCode(root, '-P'); }
  catch (error) { if (error.status !== 128) throw error; output = grepCode(root, '-E'); }
  return new Set(output.split('\n').filter(Boolean));
}

export function envTokenKnown(token, codeTokens, { allowedPrefixes = ALLOWED_PREFIXES, opencodeOwned = OPENCODE_OWNED, testOnly = TEST_ONLY } = {}) {
  if (codeTokens.has(token) || opencodeOwned.has(token) || testOnly.has(token)) return true;
  if (token.endsWith('_')) {
    if (allowedPrefixes.has(token)) return true;
    for (const code of codeTokens) if (code.startsWith(token)) return true;
    return false;
  }
  for (const prefix of allowedPrefixes.keys()) if (token.startsWith(prefix)) return true;
  if (token.startsWith('OPENCHAMBER_')) return codeTokens.has(`DEVRYAN_${token.slice('OPENCHAMBER_'.length)}`);
  return false;
}

/** Violations `{ check: 'env', doc, token }`. */
export function validateEnvTokens(root, files, { codeTokens = codeEnvTokens(root), ...options } = {}) {
  const violations = [];
  for (const doc of files) {
    for (const token of documentEnvTokens(readFileSync(path.join(root, doc), 'utf8'))) {
      if (!envTokenKnown(token, codeTokens, options)) violations.push({ check: 'env', doc, token });
    }
  }
  return violations;
}
