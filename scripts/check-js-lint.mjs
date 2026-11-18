#!/usr/bin/env node
// JavaScript lint: every first-party .js, .mjs, .cjs and .jsx file is linted by
// oxlint with .oxlintrc.javascript.json, which extends the TypeScript rule set
// (.oxlintrc.json) and records each JavaScript-only change with its reason and
// the vendored and generated paths that are never linted.
//
// The findings that existed when JavaScript came under the linter are listed in
// scripts/js-lint-baseline.json as { file, rule, count }, without line numbers,
// so an unrelated edit does not churn it. The baseline only shrinks:
// - a finding it does not cover fails (a new rule in a file, or more findings of
//   a rule in a file than it records);
// - an entry that no longer matches fails (fewer findings, or none, or the file
//   is gone) until `--prune` lowers or removes it. Pruning never adds an entry;
//   adding one is a hand edit a reviewer sees.
// A file oxlint cannot parse always fails: its other rules never ran.
//
//   node scripts/check-js-lint.mjs                   check every JavaScript file
//   node scripts/check-js-lint.mjs --files <f>...    check these files (fast validate); a
//                                                    deleted or excluded file's entries are stale
//   --prune                                          also lower or remove stale entries
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const CONFIG = '.oxlintrc.javascript.json';
export const BASELINE = 'scripts/js-lint-baseline.json';
export const JAVASCRIPT = /\.(?:[cm]?js|jsx)$/;
// Pseudo-rule for a file oxlint cannot parse; never accepted from the baseline.
export const PARSE_ERROR = 'parse-error';
const PRUNE_COMMAND = 'node scripts/check-js-lint.mjs --prune';

// Code-unit order, the same on every platform and locale.
const byCodeUnit = (left, right) => (left < right ? -1 : left > right ? 1 : 0);
const compareEntries = (left, right) => byCodeUnit(left.file, right.file) || byCodeUnit(left.rule, right.rule);

/** JSON with // and /* comments (the oxlint configuration format). */
export function parseJsonc(text) {
  let output = '';
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (character === '"') {
      const start = index;
      for (index += 1; index < text.length && text[index] !== '"'; index += 1) if (text[index] === '\\') index += 1;
      output += text.slice(start, index + 1);
    } else if (character === '/' && text[index + 1] === '/') {
      while (index < text.length && text[index] !== '\n') index += 1;
      output += '\n';
    } else if (character === '/' && text[index + 1] === '*') {
      const end = text.indexOf('*/', index + 2);
      if (end === -1) throw new Error('Unterminated comment');
      index = end + 1;
    } else output += character;
  }
  return JSON.parse(output);
}

/**
 * The configuration's ignorePatterns as matchers. Only the two forms used are
 * accepted, `dir/**` (everything under dir) and an exact path, so this list and
 * oxlint cannot disagree about a glob.
 */
export function readExclusions(root = repositoryRoot) {
  let config;
  try { config = parseJsonc(readFileSync(path.join(root, CONFIG), 'utf8')); } catch (error) {
    throw new Error(`${CONFIG} cannot be read: ${error instanceof Error ? error.message : String(error)}`);
  }
  const patterns = config?.ignorePatterns ?? [];
  if (!Array.isArray(patterns)) throw new Error(`${CONFIG}: ignorePatterns must be an array`);
  return patterns.map(pattern => {
    if (typeof pattern !== 'string' || !pattern || /[*?[\]{}!]/.test(pattern.replace(/\/\*\*$/, ''))) {
      throw new Error(`${CONFIG}: unsupported ignore pattern ${JSON.stringify(pattern)}; use "dir/**" or an exact path`);
    }
    return pattern.endsWith('/**') ? { pattern, matches: file => file.startsWith(pattern.slice(0, -2)) } : { pattern, matches: file => file === pattern };
  });
}

function repositoryFiles(root) {
  return execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard'], { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
    .split('\n').filter(Boolean);
}

/** First-party JavaScript among `files`: no dependency and no excluded path. */
export function inScope(file, exclusions) {
  return JAVASCRIPT.test(file) && !file.split('/').includes('node_modules') && !exclusions.some(exclusion => exclusion.matches(file));
}

/** Where a file belongs in the summary: its workspace package, else its top-level directory. */
export function packageOf(file) {
  const segments = file.split('/');
  if (segments[0] === 'packages' && segments.length > 2) return `packages/${segments[1]}`;
  return segments.length > 1 ? segments[0] : '(root)';
}

function oxlintBinary() {
  const binary = path.join(repositoryRoot, 'node_modules', 'oxlint', 'bin', 'oxlint');
  if (!existsSync(binary)) throw new Error(`oxlint is not installed (${binary}); run bun install`);
  return binary;
}

// eslint(no-empty) -> no-empty; typescript-eslint(x) -> typescript/x; eslint-plugin-react(x) -> react/x.
export function ruleName(code) {
  if (typeof code !== 'string' || !code) return PARSE_ERROR;
  const match = /^([^()]+)\((.+)\)$/.exec(code);
  if (!match) return code;
  const plugin = match[1].replace(/^eslint-plugin-/, '').replace(/-eslint$/, '');
  return plugin === 'eslint' ? match[2] : `${plugin}/${match[2]}`;
}

/** Findings per file: oxlint over `files` (paths relative to `root`). */
export function lintFiles(files, { root = repositoryRoot, oxlint = oxlintBinary() } = {}) {
  const findings = [];
  // Bounded argument lists keep every platform under its command-line limit.
  for (let start = 0; start < files.length; start += 1000) {
    const batch = files.slice(start, start + 1000);
    // The configuration is named relative to `root`, the working directory: oxlint matches
    // override paths against it, and an absolute path through a symlink (macOS /var) would not match.
    // --no-ignore: oxlint would otherwise skip files an .eslintignore lists, and report them clean;
    // the exclusions are the configuration's ignorePatterns, already applied by inScope.
    const result = spawnSync(process.execPath, [oxlint, '--config', CONFIG, '--disable-nested-config', '--no-ignore', '--format=json', ...batch],
      { cwd: root, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
    const failed = detail => new Error(`oxlint failed (exit ${result.status}${result.error ? `, ${result.error.message}` : ''}): ${detail}`);
    // 0: no error finding; 1: error findings. Anything else (a crash, a signal) is a failure.
    if (result.status !== 0 && result.status !== 1) throw failed((result.stderr || result.stdout || '').trim().slice(0, 2000));
    let report;
    try { report = JSON.parse(result.stdout.slice(result.stdout.indexOf('{'))); } catch {
      throw failed((result.stderr || result.stdout || 'no output').trim().slice(0, 2000));
    }
    if (!Array.isArray(report?.diagnostics) || report.number_of_files !== batch.length) {
      throw failed(`it linted ${report?.number_of_files} of the ${batch.length} files it was given; a skipped file would pass unlinted`);
    }
    for (const diagnostic of report.diagnostics) {
      const file = path.isAbsolute(diagnostic.filename) ? path.relative(root, diagnostic.filename).split(path.sep).join('/') : diagnostic.filename;
      const span = diagnostic.labels?.[0]?.span;
      findings.push({ file, rule: ruleName(diagnostic.code), line: span?.line ?? 0, column: span?.column ?? 0, message: diagnostic.message ?? '' });
    }
  }
  return findings.sort((left, right) => compareEntries(left, right) || left.line - right.line || left.column - right.column);
}

/** Counts per file and rule, sorted. */
export function countFindings(findings) {
  const counts = new Map();
  for (const { file, rule } of findings) {
    const key = JSON.stringify([file, rule]);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return [...counts].map(([key, count]) => { const [file, rule] = JSON.parse(key); return { file, rule, count }; }).sort(compareEntries);
}

/** One entry per line, sorted by code unit, so a review diff shows exactly the entries changed. */
export function formatBaseline(document) {
  const entries = [...document.findings].sort(compareEntries).map(entry => `    ${JSON.stringify({ file: entry.file, rule: entry.rule, count: entry.count })}`);
  return `{\n  "schemaVersion": 1,\n  "description": ${JSON.stringify(document.description)},\n  "findings": [${entries.length ? `\n${entries.join(',\n')}\n  ` : ''}]\n}\n`;
}

export function readBaseline(root = repositoryRoot) {
  let text, document;
  try { text = readFileSync(path.join(root, BASELINE), 'utf8'); document = JSON.parse(text); } catch (error) {
    throw new Error(`${BASELINE} cannot be read: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (document?.schemaVersion !== 1 || typeof document.description !== 'string' || !Array.isArray(document.findings)) {
    throw new Error(`${BASELINE} is invalid: it needs schemaVersion 1, description and findings`);
  }
  const seen = new Set();
  for (const entry of document.findings) {
    if (Object.keys(entry ?? {}).sort().join(',') !== 'count,file,rule' || typeof entry.file !== 'string' || typeof entry.rule !== 'string'
      || !Number.isInteger(entry.count) || entry.count < 1) throw new Error(`Invalid entry in ${BASELINE} (needs file, rule and a positive count): ${JSON.stringify(entry)}`);
    if (entry.rule === PARSE_ERROR) throw new Error(`${BASELINE} cannot list ${PARSE_ERROR}: a file oxlint cannot parse is fixed, never baselined (${entry.file})`);
    const key = JSON.stringify([entry.file, entry.rule]);
    if (seen.has(key)) throw new Error(`Duplicate entry in ${BASELINE}: ${entry.file} ${entry.rule}`);
    seen.add(key);
  }
  return { document, canonical: text === formatBaseline(document) };
}

/**
 * `added`: counts above the baseline (with the baseline's count, 0 when absent);
 * `stale`: baseline entries above the current count; `parse`: unparsable files.
 */
export function compareWithBaseline(counts, entries) {
  const current = new Map(counts.map(entry => [JSON.stringify([entry.file, entry.rule]), entry.count]));
  const recorded = new Map(entries.map(entry => [JSON.stringify([entry.file, entry.rule]), entry.count]));
  const added = counts.filter(entry => entry.rule !== PARSE_ERROR && entry.count > (recorded.get(JSON.stringify([entry.file, entry.rule])) ?? 0))
    .map(entry => ({ ...entry, recorded: recorded.get(JSON.stringify([entry.file, entry.rule])) ?? 0 }));
  const stale = entries.filter(entry => entry.count > (current.get(JSON.stringify([entry.file, entry.rule])) ?? 0))
    .map(entry => ({ ...entry, current: current.get(JSON.stringify([entry.file, entry.rule])) ?? 0 })).sort(compareEntries);
  const parse = counts.filter(entry => entry.rule === PARSE_ERROR).map(entry => entry.file);
  return { added, stale, parse };
}

function parseArguments(argv) {
  let prune = false, files = null;
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === '--prune') prune = true;
    else if (argv[index] === '--files') { files = argv.slice(index + 1); break; }
    else throw new Error('Usage: node scripts/check-js-lint.mjs [--prune] [--files <file>...]');
  }
  if (files && (files.length === 0 || files.some(file => file.startsWith('-')))) throw new Error('--files needs at least one file and comes last');
  return { prune, files };
}

/** `files` and `oxlint` (the linter's entry script) are overridable for tests. */
export function main(argv = process.argv.slice(2), { root = repositoryRoot, files: providedFiles, oxlint } = {}) {
  const started = performance.now();
  const { prune, files: requested } = parseArguments(argv);
  const exclusions = readExclusions(root);
  const { document, canonical } = readBaseline(root);
  // Fast mode: the requested files, wherever they are; the baseline entries of those files only.
  const candidates = requested ? [...new Set(requested.map(file => file.split(path.sep).join('/')))] : (providedFiles ?? repositoryFiles(root));
  const scope = new Set(candidates.filter(file => inScope(file, exclusions) && existsSync(path.join(root, file))));
  const linted = [...scope].sort(byCodeUnit);
  const covers = requested ? file => candidates.includes(file) : () => true;
  const findings = linted.length ? lintFiles(linted, { root, ...(oxlint ? { oxlint } : {}) }) : [];
  const counts = countFindings(findings);
  const relevant = document.findings.filter(entry => covers(entry.file));
  const { added, stale, parse } = compareWithBaseline(counts, relevant);

  let remainingStale = stale;
  if (prune && (stale.length || !canonical)) {
    const lowered = new Map(stale.map(entry => [JSON.stringify([entry.file, entry.rule]), entry.current]));
    const kept = document.findings.flatMap(entry => {
      const key = JSON.stringify([entry.file, entry.rule]);
      if (!lowered.has(key)) return [entry];
      return lowered.get(key) > 0 ? [{ ...entry, count: lowered.get(key) }] : [];
    });
    writeFileSync(path.join(root, BASELINE), formatBaseline({ ...document, findings: kept }));
    if (stale.length) console.log(`Pruned ${stale.length} stale entr${stale.length === 1 ? 'y' : 'ies'} from ${BASELINE}.`);
    remainingStale = [];
  }

  for (const file of parse) {
    for (const finding of findings.filter(item => item.file === file && item.rule === PARSE_ERROR)) {
      console.error(`cannot parse: ${file}:${finding.line}:${finding.column} ${finding.message}; oxlint ran no rule on this file. Fix the syntax; it cannot be baselined.`);
    }
  }
  for (const entry of added) {
    console.error(`new finding: ${entry.file} ${entry.rule}: ${entry.count} found, ${entry.recorded} in ${BASELINE}`);
    for (const finding of findings.filter(item => item.file === entry.file && item.rule === entry.rule)) console.error(`  ${entry.file}:${finding.line}:${finding.column} ${finding.message}`);
  }
  if (added.length) {
    console.error(`Fix the new findings. Only when one must stay, raise its entry in ${BASELINE} by hand, in the reviewed change, to:`);
    for (const entry of added) console.error(`  ${JSON.stringify({ file: entry.file, rule: entry.rule, count: entry.count })}`);
  }
  for (const entry of remainingStale) {
    const state = entry.current === 0 ? (existsSync(path.join(root, entry.file)) && scope.has(entry.file) ? 'no longer occurs' : 'is deleted or no longer linted') : `now occurs ${entry.current} time${entry.current === 1 ? '' : 's'}`;
    console.error(`stale entry: ${entry.file} ${entry.rule} (count ${entry.count}) ${state}; run ${PRUNE_COMMAND}`);
  }
  const unformatted = !canonical && !prune;
  if (unformatted) console.error(`${BASELINE} is not in canonical form (one entry per line, sorted by file and rule); run ${PRUNE_COMMAND}`);

  const recordedAfter = prune ? readBaseline(root).document.findings : document.findings;
  const packages = new Map();
  const tally = (file, key, amount) => {
    const name = packageOf(file);
    if (!packages.has(name)) packages.set(name, { files: 0, findings: 0, entries: 0 });
    packages.get(name)[key] += amount;
  };
  for (const file of linted) tally(file, 'files', 1);
  for (const entry of counts) tally(entry.file, 'findings', entry.count);
  for (const entry of recordedAfter.filter(item => covers(item.file))) tally(entry.file, 'entries', 1);
  for (const name of [...packages.keys()].sort(byCodeUnit)) {
    const row = packages.get(name);
    console.log(`  ${name}: ${row.files} files, ${row.findings} findings, ${row.entries} baseline entries`);
  }
  const elapsed = `${Math.round(performance.now() - started)} ms`;
  const summary = `${linted.length} files, ${findings.length} findings, ${recordedAfter.filter(item => covers(item.file)).length} baseline entries${requested ? ` (${candidates.length} requested)` : ''}`;
  if (parse.length || added.length || remainingStale.length || unformatted) {
    console.error(`JavaScript lint failed: ${parse.length} unparsable, ${added.length} new, ${remainingStale.length} stale (${summary}; ${elapsed}).`);
    return 1;
  }
  console.log(`JavaScript lint passed (${summary}; ${elapsed}).`);
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try { process.exitCode = main(); } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
