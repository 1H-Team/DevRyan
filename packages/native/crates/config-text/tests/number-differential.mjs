#!/usr/bin/env node
// The number differential (BH7 fix round 1, B2): seeded doubles drawn by Node in batches, each written with
// String(x) (V8's Number::toString), and JSON numerals parsed with JSON.parse, run through the workspace's one
// number implementation (devryan_config_text::js: the ledger core's layout) by tests/number_differential.rs, which
// must report no difference. The classes: random bit patterns, random magnitudes, two-decimal values near 1e14
// (where two shortest spellings tie), exact dyadic ties, integers around 2^53, and their one-ulp neighbours; the
// numerals: each double's own spelling, its toExponential and toPrecision forms, and long random digit strings.
//
//   node number-differential.mjs [--batches=6] [--count=50000] [--seed=S]
//
// cargo on PATH (the pinned toolchain, as scripts/check-native.mjs sets it up). One batch's rows go to a file in
// the OS temp dir, removed when the batch ends; one child at a time, each with a deadline.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const NATIVE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const option = (name, fallback) => Number(process.argv.find((arg) => arg.startsWith(`--${name}=`))?.slice(name.length + 3) ?? fallback);
const BATCHES = option('batches', 6);
const COUNT = option('count', 50_000);
const SEED = option('seed', 20261126);
const DEADLINE_MS = 600_000;

const view = new DataView(new ArrayBuffer(8));
const bitsOf = (x) => { view.setFloat64(0, x); return view.getBigUint64(0); };
const fromBits = (bits) => { view.setBigUint64(0, bits); return view.getFloat64(0); };
const hex = (x) => bitsOf(x).toString(16).padStart(16, '0');
/** xorshift128+, seeded: [0, 1). */
function random(seed) {
  let a = BigInt(seed) | 1n; let b = 0x9e3779b97f4a7c15n;
  const mask = (1n << 64n) - 1n;
  return () => {
    let s1 = a; const s0 = b; a = s0; s1 ^= (s1 << 23n) & mask; s1 ^= s1 >> 17n; s1 ^= s0; s1 ^= s0 >> 26n; b = s1;
    return Number(((a + b) & mask) >> 11n) / 2 ** 53;
  };
}

function* doubles(next, count) {
  const int = (n) => Math.floor(next() * n);
  const bits64 = () => (BigInt(Math.floor(next() * 2 ** 32)) << 32n) | BigInt(Math.floor(next() * 2 ** 32));
  for (let produced = 0; produced < count;) {
    const roll = next();
    let x;
    if (roll < 0.25) x = fromBits(bits64());
    else if (roll < 0.45) x = next() * 10 ** (int(40) - 20);
    else if (roll < 0.7) x = Math.round(next() * 1e16) / 100; // two decimals near 1e14: ties of two shortest spellings
    else if (roll < 0.85) { const m = 1 + int(8); x = Math.floor(next() * 10 ** (16 - Math.ceil(m * 0.30103))) + (2 * int(2 ** (m - 1)) + 1) / 2 ** m; }
    else x = (next() < 0.5 ? -1 : 1) * (2 ** 53 + int(4001) - 2000) * (next() < 0.2 ? 2 ** int(30) : 1);
    if (!Number.isFinite(x)) continue;
    if (next() < 0.5) x = -x;
    yield x; produced += 1;
    if (next() < 0.05 && produced < count) {
      const neighbour = bitsOf(x) + 1n;
      if ((neighbour & 0x7ff0000000000000n) !== 0x7ff0000000000000n) { yield fromBits(neighbour); produced += 1; }
    }
  }
}

function numerals(next, x) {
  const out = [String(x)];
  const digits = 1 + Math.floor(next() * 20);
  out.push(x.toExponential(digits).replace('e+', next() < 0.5 ? 'e' : 'e+'), x.toPrecision(digits));
  // A long random numeral: up to 30 digits, a fraction, an exponent.
  const run = (n) => Array.from({ length: n }, () => Math.floor(next() * 10)).join('');
  out.push(`${next() < 0.5 ? '-' : ''}${1 + Math.floor(next() * 9)}${run(Math.floor(next() * 29))}${next() < 0.5 ? `.${run(1 + Math.floor(next() * 20))}` : ''}${next() < 0.6 ? `e${next() < 0.5 ? '-' : ''}${Math.floor(next() * 330)}` : ''}`);
  return out.filter((text) => /^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?$/.test(text));
}

function runCargo(file) {
  return new Promise((resolve) => {
    const child = spawn('cargo', ['test', '--quiet', '--locked', '--offline', '-p', 'devryan-config-text', '--test', 'number_differential', '--', '--ignored', '--nocapture'],
      { cwd: NATIVE, env: { ...process.env, DEVRYAN_NUMBER_ROWS: file, CARGO_BUILD_JOBS: process.env.CARGO_BUILD_JOBS ?? '2' }, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    const keep = (chunk) => { if (output.length < 64 * 1024) output += chunk; };
    child.stdout.on('data', keep); child.stderr.on('data', keep);
    const timer = setTimeout(() => { process.stderr.write(`number differential: cargo test (pid ${child.pid}) passed its deadline; killed\n`); child.kill('SIGKILL'); }, DEADLINE_MS);
    child.on('close', (code, signal) => { clearTimeout(timer); resolve({ code, signal, output }); });
  });
}

const next = random(SEED);
let failed = false;
const totals = [0, 0];
for (let batch = 0; batch < BATCHES && !failed; batch += 1) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'devryan-number-differential-'));
  try {
    const rows = [];
    for (const x of doubles(next, COUNT)) {
      rows.push(`layout\t${hex(x)}\t${String(x)}`);
      if (next() < 0.4) for (const numeral of numerals(next, x)) rows.push(`parse\t${numeral}\t${hex(JSON.parse(numeral))}`);
    }
    const file = path.join(dir, 'rows.tsv');
    fs.writeFileSync(file, `${rows.join('\n')}\n`);
    const result = await runCargo(file);
    const line = /number differential: (\d+) layouts, (\d+) parses, (\d+) differ/.exec(result.output);
    process.stdout.write(`batch ${batch + 1}: ${line ? line[0] : `no summary (exit ${result.code ?? result.signal})`}\n`);
    if (line) { totals[0] += Number(line[1]); totals[1] += Number(line[2]); }
    if (result.code !== 0 || !line || line[3] !== '0') { failed = true; process.stdout.write(result.output.slice(-4000)); }
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}
process.stdout.write(`number differential: ${failed ? 'DIFFERENCES' : 'no difference'} (${totals[0]} doubles, ${totals[1]} numerals; seed ${SEED})\n`);
process.exitCode = failed ? 1 : 0;
