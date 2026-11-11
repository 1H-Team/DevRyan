#!/usr/bin/env node
// Replays a repository's own history through both paths of the ledger's text
// diff: for every commit in a range, every file it changed (against its first
// parent; a root commit against the empty tree) whose two versions are each at
// most 8 MiB (the ledger's granular limit), before against after, through
// `javascriptMutationDiff` and through `mutationDiff` with DEVRYAN_LEDGER_RUST=1.
// Any difference in the whole result, and any call the Rust core did not
// answer, is reported. Binary and invalid UTF-8 versions are replayed too (they
// take the early exits). A blob pair seen in an earlier commit is counted but
// not diffed again: the diff is deterministic. Nothing is written except --out.
//
//   <runtime> scripts/perf/mutation-diff-history-replay.mjs [--repo <git checkout>] [--range <rev-list args>]
//     [--runtime <harness-runtime/lib>] [--out <report.json>]
//   --range defaults to `--all` (every commit reachable from any ref); for example
//   `--range "-n 2000 HEAD"`. <runtime> is preferably Electron's Node
//   (ELECTRON_RUN_AS_NODE=1 node_modules/electron/dist/Electron.app/Contents/MacOS/Electron),
//   else node or bun. Exits 1 on any difference or fallback. Not part of CI.
import { execFileSync } from 'node:child_process';
import { isUtf8 } from 'node:buffer';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repositoryRoot = fileURLToPath(new URL('../../', import.meta.url));
export const HISTORY_FILE_LIMIT = 8 * 1024 * 1024;
const EMPTY = /^0+$/;

export function parseHistoryReplayArgs(argv) {
  const options = { repo: repositoryRoot, range: ['--all'], runtime: path.join(repositoryRoot, 'packages/harness-runtime/lib'), out: null };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    const value = () => {
      const next = argv[index + 1];
      if (next === undefined) throw new Error(`${flag} requires a value`);
      index += 1; return next;
    };
    if (flag === '--repo') options.repo = path.resolve(value());
    else if (flag === '--range') options.range = value().split(/\s+/).filter(Boolean);
    else if (flag === '--runtime') options.runtime = path.resolve(value());
    else if (flag === '--out') options.out = path.resolve(value());
    else throw new Error(`Unknown option ${flag}`);
  }
  return options;
}

const sameResult = (x, y) => x.length === y.length && x.every((change, index) => change.kind === y[index].kind && change.text === y[index].text
  && Object.keys(change).join() === 'kind,text' && Object.keys(y[index]).join() === 'kind,text');

export async function runHistoryReplay(options) {
  const text = await import(pathToFileURL(path.join(options.runtime, 'session-mutation-text.js')).href);
  if (typeof text.javascriptMutationDiff !== 'function' || typeof text.mutationDiffPaths !== 'function') throw new Error(`${options.runtime} has no Rust diff path`);
  const git = (args, input) => execFileSync('git', ['-C', options.repo, ...args], { maxBuffer: 1 << 30, input });
  const commits = git(['rev-list', '--parents', ...options.range]).toString().trim().split('\n').filter(Boolean).map((line) => line.split(' '));
  const stats = { commits: commits.length, fileChanges: 0, uniquePairs: 0, skippedLarge: 0, skippedSubmodule: 0, earlyExitBinary: 0, nonAscii: 0,
    maxBytes: 0, totalBytes: 0, rust: 0, early: 0, fallbacks: 0, mismatches: [], javascriptMs: 0, rustMs: 0 };
  const seen = new Set();
  const blobs = (ids) => {
    // One cat-file --batch per commit: "<id> blob <size>\n<bytes>\n" per object.
    const output = git(['cat-file', '--batch'], `${ids.join('\n')}\n`);
    const map = new Map();
    let offset = 0;
    for (const id of ids) {
      const end = output.indexOf(10, offset);
      const size = Number(output.subarray(offset, end).toString().split(' ')[2]);
      map.set(id, output.subarray(end + 1, end + 1 + size));
      offset = end + 1 + size + 1;
    }
    return map;
  };
  const previous = process.env.DEVRYAN_LEDGER_RUST;
  const started = performance.now();
  try {
    for (const [commit, parent] of commits) {
      const raw = git(['diff-tree', '-r', '-z', '--no-renames', '--no-commit-id', ...(parent ? [parent, commit] : ['--root', commit])])
        .toString('latin1').split('\0').filter(Boolean);
      const changes = [];
      for (let index = 0; index + 1 < raw.length; index += 2) {
        const [oldMode, newMode, oldId, newId] = raw[index].slice(1).split(' ');
        if (oldMode === '160000' || newMode === '160000') { stats.skippedSubmodule += 1; continue; }
        stats.fileChanges += 1;
        const pair = `${oldId}:${newId}`;
        if (seen.has(pair)) continue;
        seen.add(pair);
        changes.push({ file: raw[index + 1], oldId, newId });
      }
      const ids = [...new Set(changes.flatMap((change) => [change.oldId, change.newId]).filter((id) => !EMPTY.test(id)))];
      if (!ids.length) continue;
      const content = blobs(ids);
      for (const change of changes) {
        const before = EMPTY.test(change.oldId) ? Buffer.alloc(0) : content.get(change.oldId);
        const after = EMPTY.test(change.newId) ? Buffer.alloc(0) : content.get(change.newId);
        if (before.length > HISTORY_FILE_LIMIT || after.length > HISTORY_FILE_LIMIT) { stats.skippedLarge += 1; continue; }
        stats.uniquePairs += 1;
        if (before.includes(0) || after.includes(0) || !isUtf8(before) || !isUtf8(after)) stats.earlyExitBinary += 1;
        const b = before.toString('latin1'), a = after.toString('latin1');
        if (/[\x80-\xff]/.test(b) || /[\x80-\xff]/.test(a)) stats.nonAscii += 1;
        stats.maxBytes = Math.max(stats.maxBytes, before.length, after.length);
        stats.totalBytes += before.length + after.length;
        delete process.env.DEVRYAN_LEDGER_RUST;
        let clock = performance.now();
        const expected = text.javascriptMutationDiff(b, a);
        stats.javascriptMs += performance.now() - clock;
        process.env.DEVRYAN_LEDGER_RUST = '1';
        const paths = text.mutationDiffPaths();
        clock = performance.now();
        const actual = text.mutationDiff(b, a);
        stats.rustMs += performance.now() - clock;
        const used = text.mutationDiffPaths();
        if (used.rust > paths.rust) stats.rust += 1;
        if (used.early > paths.early) stats.early += 1;
        if (used.javascript > paths.javascript) stats.fallbacks += 1;
        if (!sameResult(expected, actual) && stats.mismatches.length < 50) {
          stats.mismatches.push({ commit, file: change.file, oldId: change.oldId, newId: change.newId,
            expected: expected.map((part) => `${part.kind}:${part.text.length}`).join(' '), actual: actual.map((part) => `${part.kind}:${part.text.length}`).join(' ') });
        }
      }
    }
  } finally {
    if (previous === undefined) delete process.env.DEVRYAN_LEDGER_RUST; else process.env.DEVRYAN_LEDGER_RUST = previous;
  }
  const runtime = process.versions.bun ? `bun ${process.versions.bun}` : process.versions.electron ? `electron-node ${process.version}` : `node ${process.version}`;
  return { runtime, repo: options.repo, range: options.range, load: os.loadavg().map((value) => Math.round(value * 100) / 100),
    elapsedMs: Math.round(performance.now() - started), ...stats, javascriptMs: Math.round(stats.javascriptMs), rustMs: Math.round(stats.rustMs),
    mismatchCount: stats.mismatches.length };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const options = parseHistoryReplayArgs(process.argv.slice(2));
  const report = await runHistoryReplay(options);
  const json = JSON.stringify(report, null, 2);
  if (options.out) await fs.writeFile(options.out, `${json}\n`);
  console.log(json);
  if (report.mismatchCount || report.fallbacks) process.exitCode = 1;
}
