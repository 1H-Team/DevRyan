#!/usr/bin/env node
// Writes json-corpus.tsv: real records and what Node does with them, for
// tests/json.rs (`record_corpus_round_trips_match_node`). Each record is a
// file's bytes; Node reads it as JSON.parse(buffer.toString('utf8')) and the
// expected output is JSON.stringify of that, or `!` where parse throws.
//
//   node json-corpus.mjs --out <file> --aged-profile    the aged-profile fixture's records
//   node json-corpus.mjs --out <file> --dir <directory> every regular file under <directory>
//   ... --min <n>                                       fail unless at least n records were found
//
// Both may be combined and `--dir` repeated. The ledger dual-run harness's
// stage records and seam messages are to be fed this way once that harness
// lands (it is not in this tree yet). A Git object store
// inside a directory (a `git` or `.git` folder, or a bare repository) is read
// as its blobs, not as files. run-extended.mjs calls this; run it under the
// test isolation preload, because the aged profile runs the real ledger.
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { nestingDepth } from './generate-json.mjs';
import { b64, isMain, vectorDocument } from './vector-tools.mjs';

/** Node's answer for one record's bytes. */
export function recordRow(name, bytes) {
  let output;
  try { output = JSON.stringify(JSON.parse(bytes.toString('utf8'))); } catch { output = null; }
  return `${name}\t${b64(bytes)}\t${output === null ? '!' : b64(Buffer.from(output, 'utf8'))}`;
}

const isGitDir = (directory) => {
  try { return readdirSync(directory).includes('objects') && readdirSync(directory).includes('HEAD'); } catch { return false; }
};

/** Every blob of a Git object store, loose and packed, by object ID. */
export function gitBlobs(gitDir) {
  const listing = execFileSync('git', ['--git-dir', gitDir, 'cat-file', '--batch-all-objects', '--batch-check=%(objectname) %(objecttype)'], { encoding: 'utf8', maxBuffer: 1 << 30 });
  const blobs = listing.split('\n').filter((line) => line.endsWith(' blob')).map((line) => line.split(' ')[0]);
  if (!blobs.length) return [];
  const raw = execFileSync('git', ['--git-dir', gitDir, 'cat-file', '--batch'], { input: `${blobs.join('\n')}\n`, maxBuffer: 1 << 30 });
  const out = [];
  let at = 0;
  for (const id of blobs) {
    const header = raw.indexOf(10, at);
    const [, , size] = raw.subarray(at, header).toString('latin1').split(' ');
    out.push({ id, bytes: raw.subarray(header + 1, header + 1 + Number(size)) });
    at = header + 1 + Number(size) + 1;
  }
  return out;
}

/** Records under `root`: Git blobs of object stores, and every other regular file. */
export function directoryRecords(root, label = path.basename(root)) {
  const records = [];
  const walk = (directory) => {
    if (isGitDir(directory)) {
      for (const { id, bytes } of gitBlobs(directory)) records.push({ name: `${label}:${path.relative(root, directory) || '.'}:blob:${id}`, bytes });
      return;
    }
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) walk(file);
      else if (entry.isFile()) records.push({ name: `${label}:${path.relative(root, file)}`, bytes: readFileSync(file) });
    }
  };
  walk(root);
  return records;
}

/** Writes the aged profile (every scenario) into a scratch directory and returns its records. */
export async function agedProfileRecords(scratch) {
  const { writeAgedProfile } = await import('../../../../../scripts/opencode-v2-native/aged-profile-fixture.mjs');
  const { initGitRepository } = await import('../../../../../scripts/test-git-template.mjs');
  const directory = path.join(scratch, 'project'), web = path.join(scratch, 'web-data');
  await initGitRepository(directory);
  await writeAgedProfile({ webDataDirectory: web, directory });
  // The web data holds the ledger (session-mutations: its Git store and
  // views), the task ledger and receipts. Project file contents in the
  // ledger's content store (`objects/<sha256>`) are not records.
  return directoryRecords(web, 'aged').filter((record) => !/\/objects\/[0-9a-f]{64}$/.test(record.name.split(':')[1] ?? ''));
}

async function main(argv) {
  const value = (name) => argv.flatMap((arg, index) => (arg === name ? [argv[index + 1]] : []));
  const [out] = value('--out');
  if (!out) throw new Error('--out <file> is required');
  const records = [];
  if (argv.includes('--aged-profile')) {
    const scratch = mkdtempSync(path.join(path.dirname(path.resolve(out)), 'aged-'));
    try { records.push(...await agedProfileRecords(scratch)); } finally { rmSync(scratch, { recursive: true, force: true }); }
  }
  for (const directory of value('--dir')) records.push(...directoryRecords(path.resolve(directory)));
  mkdirSync(path.dirname(path.resolve(out)), { recursive: true });
  writeFileSync(out, vectorDocument(['# Generated by json-corpus.mjs. name, record bytes (base64), Node JSON.stringify(JSON.parse(text)) (base64 of UTF-8) or !.'],
    records.map((record) => recordRow(record.name.replace(/\t|\n/g, ' '), record.bytes))));
  const depths = records.flatMap((record) => { try { return [nestingDepth(JSON.parse(record.bytes.toString('utf8')))]; } catch { return []; } });
  console.log(`Wrote ${records.length} records (${depths.length} JSON, ${records.length - depths.length} not JSON; deepest JSON record nests ${Math.max(0, ...depths)} containers) to ${out}.`);
  const [min] = value('--min');
  if (min !== undefined && records.length < Number(min)) throw new Error(`only ${records.length} records, fewer than --min ${min}`);
  return records;
}

if (isMain(import.meta.url)) {
  main(process.argv.slice(2)).catch((error) => { console.error(error); process.exitCode = 1; });
}
export { main as writeCorpus };
