#!/usr/bin/env node
// Differential run: draws fresh cases from the config-text generators (or
// reads rows from files), runs each through the installed packages and
// through the crate's test-only probe, and reports every difference.
//
//   node config-text-differential.mjs [--seed S] [--count N] [--only jsonc,edits,yaml,stringify,front]
//                                     [--rows <file>...] [--mutate N]
//
// --mutate N also runs N seeded mutations of the text argument of every
// tracked row (the parse, strip, edit and front-matter operations).
//
// It builds the probe with the pinned toolchain (cargo on PATH, as
// scripts/check-native.mjs sets it up) into packages/native/target, and keeps
// nothing else: inputs go to the probe on stdin. Exit code 1 on a difference.
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { REPOSITORY_ROOT, TESTS_DIR, decodeField, encodeField, runOperation } from './config-text-format.mjs';
import { drawer, mutate } from './config-text-tools.mjs';
import { cases as jsoncCases } from './generate-config-jsonc.mjs';
import { cases as editCases } from './generate-config-jsonc-edits.mjs';
import { cases as yamlCases } from './generate-config-yaml-parse.mjs';
import { cases as stringifyCases } from './generate-config-yaml-stringify.mjs';
import { cases as frontCases } from './generate-config-front-matter.mjs';

const GENERATORS = { jsonc: jsoncCases, edits: editCases, yaml: yamlCases, stringify: stringifyCases, front: frontCases };
const argv = process.argv.slice(2);
const option = (name, fallback) => { const at = argv.indexOf(name); return at < 0 ? fallback : argv[at + 1]; };
const seed = Number(option('--seed', String(Date.now() % 1000000007)));
const count = Number(option('--count', '2000'));
const only = option('--only', Object.keys(GENERATORS).join(',')).split(',');
const native = path.join(REPOSITORY_ROOT, 'packages', 'native');

const build = spawnSync('cargo', ['build', '--quiet', '--locked', '--offline', '-p', 'devryan-config-text', '--bin', 'config-text-probe'], { cwd: native, stdio: 'inherit' });
if (build.status !== 0) throw new Error('cargo build of the probe failed');
const probe = path.join(native, 'target', 'debug', 'config-text-probe');

const all = [];
const rowFiles = [];
for (let index = argv.indexOf('--rows'); index >= 0 && index + 1 < argv.length && !argv[index + 1].startsWith('--'); index += 1) rowFiles.push(argv[index + 1]);
if (rowFiles.length) {
  for (const file of rowFiles) {
    for (const line of readFileSync(file, 'utf8').split('\n')) {
      if (!line || line.startsWith('#') || line.startsWith('end\t')) continue;
      const fields = line.split('\t');
      all.push([fields[0], fields[1], fields.slice(2, -1).map(decodeField)]);
    }
  }
} else {
  for (const name of only) all.push(...GENERATORS[name]({ count, seed }).map(([caseName, op, args]) => [`${name}/${caseName}`, op, args]));
}

const mutations = Number(option('--mutate', '0'));
if (mutations > 0) {
  const d = drawer(seed);
  const alphabet = '{}[],:"\'/*\n\r\t \\#-?&!|>%@`~.0123456789eabnrtu\ufeff'.split('');
  for (const file of ['config-jsonc.tsv', 'config-jsonc-edits.tsv', 'config-yaml-parse.tsv', 'config-front-matter.tsv']) {
    for (const line of readFileSync(path.join(TESTS_DIR, file), 'utf8').split('\n')) {
      if (!line || line.startsWith('#') || line.startsWith('end\t')) continue;
      const fields = line.split('\t');
      const [name, op] = fields;
      if (op === 'utf8-decode' || op === 'utf8-encode') continue;
      const args = fields.slice(2, -1).map(decodeField);
      for (let index = 0; index < mutations; index += 1) all.push([`mutated/${name}/${index}`, op, [mutate(d, args[0], alphabet), ...args.slice(1)]]);
    }
  }
}

const input = all.map(([, op, args]) => [op, ...args.map(encodeField)].join('\t')).join('\n') + '\n';
const run = spawnSync(probe, [], { input, maxBuffer: 1024 * 1024 * 1024, encoding: 'utf8' });
if (run.status !== 0) throw new Error(`the probe failed (${run.status ?? run.signal}): ${run.stderr}`);
const answers = run.stdout.split('\n');
let failures = 0;
all.forEach(([name, op, args], index) => {
  const expected = runOperation(op, args);
  const answer = answers[index] ?? '';
  const actual = answer.startsWith('error\t') ? `<probe error: ${answer.slice(6)}>` : decodeField(answer);
  if (actual !== expected) {
    failures += 1;
    if (failures <= 20) {
      console.log(`DIFF ${name} (${op})\n  input: ${JSON.stringify(args).slice(0, 600)}\n  js:    ${JSON.stringify(expected).slice(0, 800)}\n  rust:  ${JSON.stringify(actual).slice(0, 800)}`);
    }
  }
});
console.log(`${all.length} cases (seed ${seed}), ${failures} differences.`);
process.exitCode = failures ? 1 : 0;
