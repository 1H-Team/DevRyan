#!/usr/bin/env node
// Replays many overlapping, model-style rewrites of one large TSX test file
// through `applyMutationText`, the per-file work a ledger publication runs on
// the ledger worker. It reports, per edit, the apply time, the encode/decode
// time of the stored run rows, and run and ancestry (`replaces`) growth, with
// the source, runtime, machine and fixture identity, so a frozen baseline and
// a candidate are comparable. Nothing is written except the --out report.
//
//   node scripts/perf/mutation-ancestry-replay.mjs [--runtime <harness-runtime/lib>] [--edits 70] [--blocks 40]
//     [--seed 0] [--label <text>] [--out <report.json>] [--max-apply-ms <ms>] [--max-pages-mib <MiB>]
//   `--runtime` points at another checkout's `packages/harness-runtime/lib`;
//   `--label` names that source in the report (e.g. a `git archive` of a tag).
//   `--max-apply-ms` / `--max-pages-mib` make the run a gate: it exits 1 when
//   any edit's apply time or the final stored-row size exceeds the bound.
//   Run under `node --cpu-prof --cpu-prof-dir <dir>` to capture a CPU profile.
//
// Stored-row sizes use the runtime's `encodeMutationRunRows` when it exports
// one, else a replica of today's `saveRuns` rows (every 32 KiB text chunk
// repeats the run's metadata); the report names which (`encoding`).
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

const execute = promisify(execFile);
const repositoryRoot = fileURLToPath(new URL('../../', import.meta.url));
const CHUNK = 32_768;

export function parseMutationAncestryArgs(argv) {
  const options = { runtime: path.join(repositoryRoot, 'packages/harness-runtime/lib'), edits: 70, blocks: 40, seed: 0,
    label: null, out: null, maxApplyMs: null, maxPagesMiB: null };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    const value = () => {
      const next = argv[index + 1];
      if (next === undefined || next.startsWith('--')) throw new Error(`${flag} requires a value`);
      index += 1; return next;
    };
    if (flag === '--runtime') options.runtime = path.resolve(value());
    else if (flag === '--edits') options.edits = Number(value());
    else if (flag === '--blocks') options.blocks = Number(value());
    else if (flag === '--seed') options.seed = Number(value());
    else if (flag === '--label') options.label = value();
    else if (flag === '--out') options.out = path.resolve(value());
    else if (flag === '--max-apply-ms') options.maxApplyMs = Number(value());
    else if (flag === '--max-pages-mib') options.maxPagesMiB = Number(value());
    else throw new Error(`Unknown option ${flag}`);
  }
  if (!Number.isSafeInteger(options.edits) || options.edits < 1 || options.edits > 500) throw new Error('--edits must be an integer from 1 to 500');
  if (!Number.isSafeInteger(options.blocks) || options.blocks < 8 || options.blocks > 400) throw new Error('--blocks must be an integer from 8 to 400');
  if (!Number.isSafeInteger(options.seed) || options.seed < 0 || options.seed > 1_000_000) throw new Error('--seed must be an integer from 0 to 1000000');
  for (const [name, bound] of [['--max-apply-ms', options.maxApplyMs], ['--max-pages-mib', options.maxPagesMiB]]) {
    if (bound !== null && (!Number.isFinite(bound) || bound <= 0)) throw new Error(`${name} must be a positive number`);
  }
  return options;
}

const WORDS = ['patient', 'booking', 'professional', 'calendar', 'export', 'status', 'details', 'card', 'row', 'filter'];

// A repetitive Vitest file: each edit rewrites most lines of one block a
// little, the way a model iterates on one failing test. Seed 0 is the fixture
// of the 2026-10-28 preliminary replay.
export function createReplayFixture({ blocks = 40, seed = 0 } = {}) {
  const pick = (version, line) => WORDS[(version * 7 + line * 3 + seed) % WORDS.length];
  const block = (index, version) => `
  it('${pick(version, 1)} ${pick(version, 2)} view ${index}.${version} shows ${pick(version, 3)} above ${pick(version, 4)}', async () => {
${Array.from({ length: 12 + (version % 4) }, (_, line) => `    const ${pick(version + line, line)}${line} = screen.getByTestId('${pick(version, line)}-${line}-${(version * 13 + line) % 97}');
    expect(${pick(version + line, line)}${line}).toHaveTextContent(/${pick(version + 1, line)} ${(version + line) % 11}/i);`).join('\n')}
  });
`;
  const versions = Array.from({ length: blocks }, () => 0);
  return {
    render: () => `describe('AppointmentDetailView', () => {${versions.map((version, index) => block(index, version)).join('')}});\n`,
    // Two hot blocks, as in the observed file: block 5 twice, block 6 once.
    target: (edit) => (edit % 3 === 0 ? 6 : 5),
    edit(editNumber) { versions[this.target(editNumber)] += 1; },
  };
}

// Today's `saveRuns` row shape (session-mutations.js): one row per 32 KiB of
// text, each repeating the run's metadata.
export function encodeV1Rows(runs) {
  const rows = [];
  for (const run of runs) {
    const { text, ...metadata } = run;
    for (let offset = 0; offset < text.length; offset += CHUNK) {
      rows.push({ ...metadata, start: run.start + offset, bytes: Buffer.from(text.slice(offset, offset + CHUNK), 'latin1').toString('base64') });
    }
  }
  return rows;
}

export const decodeV1Rows = (rows) => rows.map(({ bytes, ...metadata }) => ({ ...metadata, text: Buffer.from(bytes, 'base64').toString('latin1') }));

export function ancestryCounts(runs) {
  let total = 0, max = 0;
  for (const run of runs) { total += run.replaces.length; max = Math.max(max, run.replaces.length); }
  return { runs: runs.length, replacesTotal: total, replacesMax: max };
}

export function summarizeReplay(edits, { maxApplyMs = null, maxPagesMiB = null } = {}) {
  const applyMs = edits.map((row) => row.applyMs);
  const last = edits.at(-1) ?? null;
  const maxApply = applyMs.length ? Math.max(...applyMs) : 0;
  const pagesMiB = last ? last.pageBytes / 1_048_576 : 0;
  const failures = [];
  if (maxApplyMs !== null && maxApply > maxApplyMs) failures.push(`apply ${Math.round(maxApply)} ms > ${maxApplyMs} ms`);
  if (maxPagesMiB !== null && pagesMiB > maxPagesMiB) failures.push(`pages ${pagesMiB.toFixed(2)} MiB > ${maxPagesMiB} MiB`);
  return { edits: edits.length, maxApplyMs: Math.round(maxApply * 10) / 10, finalPageBytes: last?.pageBytes ?? 0,
    finalPagesMiB: Math.round(pagesMiB * 100) / 100, finalReplacesTotal: last?.replacesTotal ?? 0, passed: failures.length === 0, failures };
}

const optional = async (command, args, cwd) => {
  try { return (await execute(command, args, { cwd, timeout: 10_000 })).stdout.trim(); } catch { return null; }
};

// Source, runtime, machine and fixture identity of a benchmark run.
export async function benchmarkIdentity(options, moduleFile, fixtureText) {
  const cpus = os.cpus();
  const status = await optional('git', ['status', '--porcelain'], options.runtime);
  return {
    source: { label: options.label, revision: await optional('git', ['rev-parse', 'HEAD'], options.runtime), dirty: status === null ? null : status.length > 0 },
    runtime: { node: process.version, bun: process.versions.bun ?? await optional('bun', ['--version'], repositoryRoot),
      lib: options.runtime, moduleSha256: createHash('sha256').update(await fs.readFile(moduleFile)).digest('hex') },
    machine: { platform: process.platform, release: os.release(), arch: process.arch, cpuModel: cpus[0]?.model ?? null, cpus: cpus.length,
      memoryGiB: Math.round(os.totalmem() / 1_073_741_824), osVersion: process.platform === 'darwin' ? await optional('sw_vers', ['-productVersion']) : null },
    fixture: { blocks: options.blocks, seed: options.seed, bytes: Buffer.byteLength(fixtureText, 'latin1'),
      sha256: createHash('sha256').update(fixtureText, 'latin1').digest('hex') },
  };
}

export async function runReplay(options) {
  const moduleFile = path.join(options.runtime, 'session-mutation-text.js');
  const text = await import(pathToFileURL(moduleFile).href);
  const encode = typeof text.encodeMutationRunRows === 'function' ? text.encodeMutationRunRows : encodeV1Rows;
  const decode = typeof text.decodeMutationRunRows === 'function' ? text.decodeMutationRunRows : decodeV1Rows;
  const fixture = createReplayFixture(options);
  const initial = fixture.render();
  let runs = text.initialMutationRuns(initial, 'doc:baseline');
  const edits = [];
  for (let edit = 1; edit <= options.edits; edit += 1) {
    fixture.edit(edit);
    const after = fixture.render();
    const base = text.visibleMutationRuns(runs, new Set());
    let started = performance.now();
    const next = text.applyMutationText(runs, base, after, `op${edit}`);
    const applyMs = performance.now() - started;
    if (text.mutationText(next) !== after) throw new Error(`edit ${edit}: projected text differs from the requested text`);
    started = performance.now();
    const serialized = JSON.stringify(encode(next));
    const encodeMs = performance.now() - started;
    started = performance.now();
    decode(JSON.parse(serialized));
    const decodeMs = performance.now() - started;
    runs = next;
    edits.push({ edit, target: fixture.target(edit), ...ancestryCounts(runs), applyMs: Math.round(applyMs * 10) / 10,
      encodeMs: Math.round(encodeMs * 10) / 10, decodeMs: Math.round(decodeMs * 10) / 10, pageBytes: Buffer.byteLength(serialized) });
  }
  return { identity: await benchmarkIdentity(options, moduleFile, initial), encoding: encode === encodeV1Rows ? 'v1-replica' : 'runtime',
    summary: summarizeReplay(edits, options), edits };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const options = parseMutationAncestryArgs(process.argv.slice(2));
  const report = await runReplay(options);
  const json = `${JSON.stringify(report, null, 2)}\n`;
  if (options.out) await fs.writeFile(options.out, json); else process.stdout.write(json);
  const { summary } = report;
  console.error(`mutation-ancestry-replay: ${summary.edits} edits, max apply ${summary.maxApplyMs} ms, final pages ${summary.finalPagesMiB} MiB, `
    + `replaces ${summary.finalReplacesTotal}${summary.passed ? '' : ` — FAILED: ${summary.failures.join('; ')}`}`);
  if (!summary.passed) process.exitCode = 1;
}
