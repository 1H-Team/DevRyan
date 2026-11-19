// The native ledger's line codec and wire markers against the JavaScript
// (plan package L3d): the dual-run codec the stdio protocol uses and the
// product's session-mutation-wire.js, both directions.
//
//   a. values the JavaScript generates (seeded), encoded by it, decoded and
//      re-encoded by the Rust (the line codec, then the wire layer as the
//      worker applies it): the text must equal the JavaScript's own
//   b. values the Rust generates, decoded and re-encoded by the JavaScript:
//      the text must equal the Rust's
//   c. fuzzing: random bytes and mutated valid lines; both sides refuse the
//      same lines, decode the rest to the same text, and the Rust never panics
//   d. what the native codec refuses by design (Map, Set, Date, BigInt tags;
//      JSON nested deeper than 512)
//
// Runs on the reference runtime's codec modules in this process (they are
// pure); the Rust is the ledger probe the verify passes in
// LEDGER_NATIVE_LEDGER_PROBE, or one the test builds.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import process from 'node:process';
import { after, before, describe, test } from 'node:test';

import { LEDGER_PROBE_VARIABLE, buildLedgerBinaries } from '../build-ledger-native.mjs';
import { decodeLine, encodeLine } from '../ledger-dual-run/dual-run-codec.mjs';
import { decodeWireValue, encodeWireValue } from '../../packages/harness-runtime/lib/session-mutation-wire.js';
import { summarize } from './stub-interpreter.mjs';

let probe = process.env[LEDGER_PROBE_VARIABLE];
let dispose = () => {};
before(() => {
  if (!probe) { const built = buildLedgerBinaries(); probe = built.binaries.probe; dispose = built.dispose; }
  assert.ok(existsSync(probe), `${probe} does not exist`);
});
after(() => dispose());

/** Runs the probe over input lines; one output line per input line. */
function probeLines(mode, input, args = []) {
  // Bounded (generous for loaded machines): a probe that hangs fails.
  const run = spawnSync(probe, [mode, ...args], { input, maxBuffer: 256 * 1024 * 1024, timeout: 300_000, killSignal: 'SIGKILL' });
  assert.ok(!run.error, `probe ${mode} did not finish within 300 s: ${run.error?.message}`);
  assert.equal(run.status, 0, `probe ${mode} exited ${run.status ?? run.signal}: ${run.stderr}`);
  assert.doesNotMatch(String(run.stderr), /panicked/);
  return String(run.stdout).split('\n').filter(Boolean);
}

const stripStacks = (value) => {
  if (Array.isArray(value)) return value.map(stripStacks);
  if (value === null || typeof value !== 'object' || Buffer.isBuffer(value)) return value;
  const out = {};
  for (const [key, entry] of Object.entries(value)) {
    if (key === 'stack' && value.__devryanError === true) continue;
    out[key] = stripStacks(entry);
  }
  return out;
};

/** What the Rust probe prints for one line, computed by the JavaScript. */
function expected(line) {
  let decoded;
  try { decoded = decodeLine(line); } catch { return encodeLine({ corrupt: true }).trimEnd(); }
  let wire;
  try { wire = stripStacks(encodeWireValue(decodeWireValue(decoded, { toFunction: () => () => 0 }))); } catch (error) { wire = { error: summarize(error) }; }
  return encodeLine({ echo: decoded, wire }).trimEnd();
}

function mulberry32(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const UNITS = [0x61, 0x7a, 0x30, 0x22, 0x5c, 0x0a, 0x00, 0x1f, 0xe9, 0x2028, 0xd800, 0xdc00, 0xffff, 0x24, 0x7f];
const NUMBERS = [0, -0, 1.5, -7, 1e21, 1e-7, 123456789, NaN, Infinity, -Infinity, 5e-324, 2 ** 53, 0.1];
const KEYS = ['a', 'b', '0', '7', '10', '01', '4294967294', '4294967295', '$dr', '__proto__', 'code', 'message', 'z'];
const FIELDS = ['code', 'status', 'committed', 'rollbackFailed', 'retryable', 'reason', 'name', 'message', 'stack'];

function randomValue(random, depth = 0) {
  const pick = (list) => list[Math.floor(random() * list.length)];
  const kind = Math.floor(random() * (depth >= 4 ? 6 : 11));
  switch (kind) {
    case 0: return undefined;
    case 1: return null;
    case 2: return random() < 0.5;
    case 3: return random() < 0.5 ? pick(NUMBERS) : (random() - 0.5) * 1e6;
    case 4: return String.fromCharCode(...Array.from({ length: Math.floor(random() * 6) }, () => pick(UNITS)));
    case 5: return Buffer.from(Array.from({ length: Math.floor(random() * 5) }, () => Math.floor(random() * 256)));
    case 6: return Array.from({ length: Math.floor(random() * 4) }, () => randomValue(random, depth + 1));
    case 7: return { __devryanFunction: random() < 0.8 ? Math.floor(random() * 5) : 'not a number' };
    case 8: {
      const marker = { __devryanError: random() < 0.9 ? true : 1 };
      for (let index = Math.floor(random() * 4); index > 0; index--) marker[pick(FIELDS)] = randomValue(random, depth + 2);
      if (random() < 0.4) marker.errors = random() < 0.8 ? Array.from({ length: Math.floor(random() * 3) }, () => randomValue(random, depth + 1)) : 'x';
      if (random() < 0.4) marker.cause = randomValue(random, depth + 1);
      return marker;
    }
    case 9: { let out = randomValue(random, 4); for (let level = 60 + Math.floor(random() * 10); level > 0; level--) out = [out]; return out; }
    default: {
      const object = {};
      for (let index = Math.floor(random() * 4); index > 0; index--) {
        Object.defineProperty(object, pick(KEYS), { value: randomValue(random, depth + 1), enumerable: true, configurable: true, writable: true });
      }
      return object;
    }
  }
}

describe('line codec and wire markers: JavaScript against Rust', () => {
  test('values the JavaScript generates decode and re-encode to the JavaScript\'s text', () => {
    const random = mulberry32(0x1d3);
    const lines = Array.from({ length: 4000 }, () => encodeLine(randomValue(random)).trimEnd());
    const output = probeLines('codec', `${lines.join('\n')}\n`);
    assert.equal(output.length, lines.length);
    lines.forEach((line, index) => assert.equal(output[index], expected(line), `line ${index}: ${line}`));
  });

  test('values the Rust generates decode and re-encode to the Rust\'s text', () => {
    const lines = probeLines('generate', '', ['77', '4000']);
    assert.equal(lines.length, 4000);
    for (const line of lines) assert.equal(encodeLine(decodeLine(line)).trimEnd(), line);
    const output = probeLines('codec', `${lines.join('\n')}\n`);
    lines.forEach((line, index) => assert.equal(output[index], expected(line), line));
  });

  test('random bytes and mutated lines: the same lines are refused, the rest decode alike, nothing panics', () => {
    const random = mulberry32(0xf022);
    const valid = Array.from({ length: 300 }, () => Buffer.from(encodeLine(randomValue(random)).trimEnd()));
    const lines = [];
    for (let index = 0; index < 3000; index++) {
      if (index % 3 === 0) {
        lines.push(Buffer.from(Array.from({ length: 1 + Math.floor(random() * 40) }, () => { const byte = Math.floor(random() * 256); return byte === 0x0a ? 0x20 : byte; })));
      } else {
        const line = Buffer.from(valid[Math.floor(random() * valid.length)]);
        for (let flips = 1 + Math.floor(random() * 3); flips > 0 && line.length; flips--) {
          const at = Math.floor(random() * line.length);
          const byte = Math.floor(random() * 256);
          line[at] = byte === 0x0a ? 0x7b : byte;
        }
        lines.push(line);
      }
    }
    const judged = lines.filter((line) => line.length > 0);
    const output = probeLines('codec', Buffer.concat(judged.flatMap((line) => [line, Buffer.from('\n')])));
    assert.equal(output.length, judged.length);
    judged.forEach((line, index) => {
      if (output[index] === '{"unsupported":true}') return;
      assert.equal(output[index], expected(String(line)), `fuzz line ${index}: ${line.toString('hex')}`);
    });
  });

  test('malformed tags are refused by both', () => {
    const lines = ['not json', '{', '{"$dr":"nope"}', '{"$dr":null}', '{"$dr":5}', '{"$dr":"bytes"}', '{"$dr":"bytes","base64":5}',
      '{"$dr":"escape"}', '{"$dr":"escape","value":null}', '[1,]', '{"a":1,}', '﻿{}', 'nul', '"\\x"', '01', '1.', '+1'];
    const output = probeLines('codec', `${lines.join('\n')}\n`);
    lines.forEach((line, index) => assert.equal(output[index], expected(line), line));
    for (const line of output) assert.equal(line, '{"corrupt":true}');
  });

  test('the quirks of the JavaScript decoder are reproduced', () => {
    const lines = ['{"$dr":"number","value":"12"}', '{"$dr":"number","value":[3]}', '{"$dr":"number"}', '{"$dr":"undefined","extra":1}',
      '{"$dr":"bytes","base64":[1,257,-1,"x"]}', '{"$dr":"bytes","base64":"!!AQ==??"}', '{"$dr":"escape","value":"ab"}', '{"$dr":"escape","value":[1,{"$dr":"undefined"}]}',
      '{"$dr":"escape","value":5}', '{"__proto__":{"a":1},"b":2}', '{"b":1,"a":2,"b":3}', '{"2":1,"1":2}'];
    const output = probeLines('codec', `${lines.join('\n')}\n`);
    lines.forEach((line, index) => assert.equal(output[index], expected(line), line));
  });

  test('by design the native codec refuses Map, Set, Date and BigInt, and JSON deeper than 512', () => {
    const tagged = ['{"$dr":"map","entries":[]}', '{"$dr":"set","values":[]}', '{"$dr":"date","value":1}', '{"$dr":"bigint","value":"1"}', '[{"$dr":"set","values":[1]}]'];
    for (const line of tagged) assert.doesNotThrow(() => decodeLine(line), 'the JavaScript accepts it');
    assert.deepEqual(probeLines('codec', `${tagged.join('\n')}\n`), tagged.map(() => '{"unsupported":true}'));
    const deep = `${'['.repeat(513)}${']'.repeat(513)}`;
    assert.doesNotThrow(() => decodeLine(deep));
    assert.deepEqual(probeLines('codec', `${deep}\n${'['.repeat(512)}${']'.repeat(512)}\n`).map((line) => line.startsWith('{"corrupt"')), [true, false]);
  });
});
