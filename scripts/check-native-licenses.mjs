#!/usr/bin/env node
// The licence check of the product's Cargo workspace (packages/native), with no
// tool beyond cargo: reads `cargo metadata --locked --format-version 1` and
// fails on any package whose licence expression is not satisfied by the allow
// list in packages/native/deny.toml. That list is the one policy: cargo-deny
// reads it too, so the two checks cannot disagree about what is allowed.
//
//   node scripts/check-native-licenses.mjs [--cargo PATH]
//
// An expression is SPDX (`MIT OR Apache-2.0`, `(MIT OR Apache-2.0) AND
// Unicode-3.0`, `Apache-2.0 WITH LLVM-exception`; the old `MIT/Apache-2.0`
// form reads as OR). It is satisfied when some choice of its OR branches uses
// only allowed licences. A package with no `license` field fails.
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

export const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const NATIVE_DIR = 'packages/native';

/** The `[licenses] allow = [...]` list of deny.toml. */
export function readAllowList(text) {
  const section = /^\[licenses\]\n([\s\S]*?)(?=^\[|(?![\s\S]))/m.exec(text)?.[1] ?? '';
  const allow = /^allow\s*=\s*\[([\s\S]*?)\]/m.exec(section)?.[1];
  if (allow === undefined) throw new Error('deny.toml has no [licenses] allow list');
  return [...allow.replace(/#.*$/gm, '').matchAll(/"([^"]+)"/g)].map(match => match[1]);
}

function tokenize(expression) {
  return expression.replace(/\//g, ' OR ').replace(/([()])/g, ' $1 ').trim().split(/\s+/).filter(Boolean);
}

/** Parses an SPDX expression into { or }, { and }, or { id } (`id` keeps a `WITH` exception). */
export function parseExpression(expression) {
  const tokens = tokenize(expression);
  let at = 0;
  const peek = () => tokens[at];
  const fail = (why) => { throw new Error(`licence expression ${JSON.stringify(expression)}: ${why}`); };
  const primary = () => {
    const token = tokens[at++];
    if (token === undefined) fail('ends early');
    if (token === '(') {
      const inner = or();
      if (tokens[at++] !== ')') fail('missing )');
      return inner;
    }
    if (/^(AND|OR|WITH|\))$/.test(token)) fail(`unexpected ${token}`);
    if (!/^[A-Za-z0-9.+-]+$/.test(token)) fail(`bad identifier ${token}`);
    if (peek() === 'WITH') {
      at += 1;
      const exception = tokens[at++];
      if (!exception || !/^[A-Za-z0-9.+-]+$/.test(exception)) fail('WITH needs an exception');
      return { id: `${token} WITH ${exception}` };
    }
    return { id: token };
  };
  const and = () => {
    const terms = [primary()];
    while (peek() === 'AND') { at += 1; terms.push(primary()); }
    return terms.length === 1 ? terms[0] : { and: terms };
  };
  const or = () => {
    const terms = [and()];
    while (peek() === 'OR') { at += 1; terms.push(and()); }
    return terms.length === 1 ? terms[0] : { or: terms };
  };
  if (!tokens.length) fail('is empty');
  const tree = or();
  if (at !== tokens.length) fail(`unexpected ${tokens[at]}`);
  return tree;
}

/** True when the expression can be met with allowed licences only. */
export function satisfied(tree, allow) {
  if (tree.id) return allow.has(tree.id);
  if (tree.or) return tree.or.some(term => satisfied(term, allow));
  return tree.and.every(term => satisfied(term, allow));
}

/** Every package of the metadata whose licence the allow list does not satisfy, with why. */
export function violations(metadata, allowList) {
  const allow = new Set(allowList);
  const out = [];
  for (const item of metadata.packages ?? []) {
    const label = `${item.name} ${item.version}`;
    if (!item.license) { out.push(`${label}: no licence expression${item.license_file ? ` (only a licence file, ${item.license_file})` : ''}`); continue; }
    try {
      if (!satisfied(parseExpression(item.license), allow)) out.push(`${label}: ${item.license} is not allowed by deny.toml`);
    } catch (error) {
      out.push(`${label}: ${error.message}`);
    }
  }
  return out;
}

export function main(argv = process.argv.slice(2), root = repositoryRoot) {
  const index = argv.indexOf('--cargo');
  const cargo = index >= 0 ? argv[index + 1] : 'cargo';
  const unknown = argv.filter((arg, i) => !(arg === '--cargo' || (index >= 0 && i === index + 1)));
  if (unknown.length) throw new Error(`Unknown argument: ${unknown.join(' ')} (use --cargo PATH)`);
  const workspace = path.join(root, NATIVE_DIR);
  const allowList = readAllowList(readFileSync(path.join(workspace, 'deny.toml'), 'utf8'));
  // Every package the locked graph resolves, for every target and feature, not only the ones built here.
  const result = spawnSync(cargo, ['metadata', '--locked', '--offline', '--format-version', '1', '--all-features'], { cwd: workspace, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (result.error || result.status !== 0) throw new Error(`cargo metadata failed${result.error ? `: ${result.error.message}` : `:\n${result.stderr}`}`);
  const metadata = JSON.parse(result.stdout);
  const found = violations(metadata, allowList);
  if (found.length) throw new Error(`packages/native licences outside the allow list in deny.toml:\n  ${found.join('\n  ')}`);
  console.log(`packages/native: ${metadata.packages.length} packages, every licence allowed by deny.toml (${allowList.join(', ')}).`);
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { process.exitCode = main(); } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
