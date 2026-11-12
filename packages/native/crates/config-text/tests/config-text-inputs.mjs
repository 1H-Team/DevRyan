// Input material shared by the config-text generators: the repository
// snapshot, seeded JSONC and YAML documents, JavaScript values, and the
// awkward strings and numbers every generator draws from.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { TESTS_DIR } from './config-text-format.mjs';

/** The repository snapshot as [path, text]. */
export function repoFixtures() {
  return readFileSync(path.join(TESTS_DIR, 'config-text-repo-fixtures.tsv'), 'utf8').split('\n')
    .filter((line) => line && !line.startsWith('#'))
    .map((line) => { const [file, data] = line.split('\t'); return [file, Buffer.from(data, 'base64').toString('utf8')]; });
}

export const LONE_HIGH = '\ud83d';
export const LONE_LOW = '\ude00';

/** Characters for strings: ASCII, controls, quotes, escapes, non-ASCII, pairs and lone surrogates. */
export const STRING_CHARS = [
  'a', 'b', 'Z', '0', '9', ' ', ' ', '\t', '\n', '\r', '"', "'", '\\', '/', ':', '#', '-', '?', ',', '[', ']', '{', '}', '&', '*', '!', '|', '>', '%', '@', '`',
  '\u0000', '\u0001', '\u0007', '\u0008', '\u000b', '\u000c', '\u001b', '\u001f', '\u007f', '\u0085', ' ', 'é', ' ', ' ', '﻿', '中',
  '😀', LONE_HIGH, LONE_LOW, '￿',
];

/** Number texts at the edges of JavaScript's layout and of each grammar. */
export const NUMBER_TEXTS = [
  '0', '-0', '0.0', '-0.0', '1', '-1', '12', '007', '1.5', '-2.25', '1e3', '1E+3', '1e-7', '1.5e-7', '1e21', '1e+21', '9.999999999999999e20', '123456789012345678901234567890',
  '9007199254740991', '9007199254740993', '18014398509481985', '5e-324', '2.4703282292062328e-324', '1.7976931348623157e308', '1.7976931348623159e308', '1e309', '-1e400', '0.1',
  '0.30000000000000004', '4294967295', '4294967296', '1.', '1.e5', '.5', '-.5', '+1', '1e', '1e+', '01', '-', '--1', '0x1F', '0o17', '0b11', 'Infinity', 'NaN',
];

export const KEY_POOL = [
  'a', 'b', 'name', 'model', 'plugin', 'provider', 'agent', '$schema', '__proto__', 'toString', 'constructor', 'hasOwnProperty', '', ' ', '1', '01', '0', '10', '2',
  '4294967294', '4294967295', '-1', '1.5', 'a.b', 'key with spaces', 'question_*', '*', 'é', '😀', 'x\ny', 'q"q', "s'q", 'yes', 'null', '~', '-', '?', '#c',
];

/** Strings that exercise YAML's quoting choices. */
export const YAML_STRINGS = [
  '', ' ', 'plain', 'two words', ' lead', 'trail ', 'a: b', 'a:b', 'a :b', 'a #b', 'a# b', '#x', '- x', '-', '-x', '?', '? x', '?x', ':', ': x', 'x:', '[x]', '{x}', 'x,y', '&a', '*a', '!t',
  '|x', '>x', "'q'", '"q"', 'it\'s', 'say "hi"', 'both \' and "', '%x', '@x', '`x', 'yes', 'no', 'on', 'true', 'True', 'TRUE', 'tRue', 'false', 'null', 'Null', 'NULL', 'nULL', '~', '1', '-1',
  '+1', '007', '1.5', '1.', '.5', '1e5', '1E-5', '0x10', '0x1G', '0o7', '0o8', '.inf', '-.Inf', '.NaN', '.nan.', '12:30', '2001-12-14', '--- x', '---', '...', '... x', '%YAML 1.2',
  'a\nb', 'a\n\nb', 'a\n', 'a\n\n', '\na', '\n', '\n\n', ' \n', 'a \nb', 'a\n b', 'a\n\tb', 'tab\there', '\ttab', 'tab\t', 'line\r\nbreak', 'cr\ronly', 'a\\b', 'back\\slash\\n',
  'x\n---\ny', 'x\n...', '\u0085next', 'nb sp', 'ls ps ', 'bom﻿', 'ctl\u0001x', 'del\u007f', 'esc\u001b', 'nul\u0000', 'bell\u0007', 'vt\u000b', 'c1\u0090',
  'é', '中文', '😀 smile', `lone${LONE_HIGH}high`, `lone${LONE_LOW}low`, 'a  b', 'a\t b', 'end:', 'end :', ' # x', 'x\n# y', 'x\n #y',
];

/** A seeded string from the pool characters. */
export function randomString(d, max = 12) {
  let out = '';
  const length = d.int(max + 1);
  for (let index = 0; index < length; index += 1) out += d.chance(0.6) ? d.pick('abcdefgh xyz'.split('')) : d.pick(STRING_CHARS);
  return out;
}

/** A long string with spaces (folding) or without (overflow). */
export function longString(d) {
  const words = d.repeat(10 + d.int(40), () => d.pick(['alpha', 'beta', 'gamma', 'x', 'delta-epsilon', 'a"b', "o'k", 'é', 'long-word-without-breaks-'.repeat(1 + d.int(4))]));
  const sep = d.pick([' ', ' ', '  ', '\n', ' \n', '\n\n', '\t']);
  return words.join(d.chance(0.8) ? ' ' : sep);
}

/** A JavaScript value for stringify: primitives, arrays, objects, shared and cyclic references. */
export function randomValue(d, depth = 0, shared = []) {
  const roll = d.int(depth > 3 ? 6 : 10);
  if (roll === 0) return d.pick([null, true, false, undefined]);
  if (roll === 1) return d.pick([0, -0, 1, -1, 42, 1.5, -2.25, 0.1, 1e21, 1e-7, 123456789.125, 5e-324, 1.7976931348623157e308, 9007199254740993, NaN, Infinity, -Infinity, 1e300, 0.000001]);
  if (roll === 2) return d.chance(0.2) ? longString(d) : randomString(d);
  if (roll <= 5) return d.pick(YAML_STRINGS);
  if (roll === 6 && shared.length && d.chance(0.5)) return d.pick(shared);
  if (roll <= 7) {
    const array = [];
    shared.push(array);
    for (let index = d.int(4); index > 0; index -= 1) array.push(randomValue(d, depth + 1, shared));
    if (d.chance(0.05)) array.push(array);
    return array;
  }
  const object = {};
  shared.push(object);
  for (let index = d.int(5); index > 0; index -= 1) {
    const key = d.chance(0.7) ? d.pick(KEY_POOL) : d.chance(0.5) ? d.pick(YAML_STRINGS) : randomString(d);
    Object.defineProperty(object, key, { value: randomValue(d, depth + 1, shared), writable: true, enumerable: true, configurable: true });
  }
  if (d.chance(0.05)) object.self = object;
  return object;
}
