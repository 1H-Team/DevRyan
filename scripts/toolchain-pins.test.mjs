import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { CRATE_DIR, installCommand, readToolchainFile } from './build-ledger-core.mjs';

// Toolchain versions and their sources: Bun is the root `packageManager`,
// Electron the root manifest's `electron` dependency, the Node minimum the
// root `engines.node`, and Rust the ledger core's rust-toolchain.toml channel
// (packages/harness-runtime/native/ledger-core). Every other place that states
// one is found by scanning tracked files and must agree, or be allowlisted
// below with its reason.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = file => readFileSync(path.join(root, file), 'utf8');
const tracked = (...patterns) => execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', ...patterns], { cwd: root, encoding: 'utf8' })
  .split('\n').filter(file => file && !file.includes('node_modules/') && !file.startsWith('packages/web/runtime/reviewed-inputs/'));

/**
 * The one known Node disagreement: CI's jobs read `.nvmrc`, which floats to
 * the newest LTS, while the release workflows pin a major. When `.nvmrc` stops
 * holding `nvmrc`, this entry fails until it is removed.
 */
export const NODE_SOURCE_GAP = {
  nvmrc: 'lts/*',
  reason: 'owner decision pending: pinning .nvmrc to the release major would stop the Node >=25 sandboxed qa1 suite in CI',
};

/** Doc statements that legitimately name another version: a file and the exact matched text. Unmatched entries fail. */
export const ALLOWED_DOC_STATEMENTS = [
  { file: 'packages/electron/DOCUMENTATION.md', text: 'Node 24.22', reason: 'the Node that Electron embeds, not the toolchain Node' },
  { file: 'packages/electron/DOCUMENTATION.md', text: 'Node 24', reason: "agent-browser's Node shim requirement, not the toolchain Node" },
  { file: 'packages/harness-runtime/DOCUMENTATION.md', text: 'Node 24.22', reason: "the Node that Electron embeds, where the ledger core's vectors were also checked, not the toolchain Node" },
  { file: 'packages/harness-runtime/DOCUMENTATION.md', text: 'Node 24', reason: "the Node that Electron embeds, named for its measured nesting limit, not the toolchain Node" },
  { file: 'packages/harness-runtime/DOCUMENTATION.md', text: 'Node 26', reason: "the Node the ledger core's vectors were generated with, named beside its ICU version, not the toolchain Node" },
  { file: 'docs/QA_REPAIR_VERIFICATION.md', text: 'Electron 41.2.1', reason: 'historical 2026-10-20 measurement record of the build that was sampled' },
  { file: 'packages/web/server/lib/opencode/runtime-host/DOCUMENTATION.md', text: 'Bun 1.4.3', reason: 'the previous Bun pin, named for patch and lockfile behaviour it is compared against' },
];
/** Docs skipped whole. */
export const SKIPPED_DOCS = new Map([
  ['CHANGELOG.md', 'release notes record the versions each past release shipped with'],
]);

export function toolchainSources(manifest) {
  const problems = [];
  const engines = /^>=(\d+)\.(\d+)\.(\d+)$/.exec(manifest.engines?.node ?? '');
  if (!engines) problems.push(`package.json engines.node must be >=<major>.<minor>.<patch>, not ${JSON.stringify(manifest.engines?.node)}`);
  const bun = /^bun@(\d+\.\d+\.\d+)$/.exec(manifest.packageManager ?? '')?.[1];
  if (!bun) problems.push(`package.json packageManager must be bun@<exact version>, not ${JSON.stringify(manifest.packageManager)}`);
  const electron = manifest.devDependencies?.electron ?? manifest.dependencies?.electron;
  if (!/^\d+\.\d+\.\d+$/.test(electron ?? '')) problems.push(`package.json electron must be an exact version, not ${JSON.stringify(electron)}`);
  return { problems, pins: { nodeMinimum: engines ? engines.slice(1).join('.') : '', bun, electron } };
}

const lineOf = (text, index) => text.slice(0, index).split('\n').length;
const unquote = value => value.trim().replace(/\s+#.*$/, '').replace(/^(['"])(.*)\1$/, '$2');
const SETUP_ACTIONS = { 'actions/setup-node': ['node-version', 'node-version-file'], 'oven-sh/setup-bun': ['bun-version', 'bun-version-file'] };
const VERSION_KEYS = new Set(Object.values(SETUP_ACTIONS).flat());

/**
 * Steps (YAML sequence items) of a workflow with their keys and `with:` inputs,
 * whether written as block or flow mappings and with quoted or bare values.
 */
export function workflowSteps(text) {
  const lines = text.split('\n'), steps = [];
  lines.forEach((line, index) => {
    const dash = /^(\s*)-\s+\S/.exec(line);
    if (!dash) return;
    let last = index + 1;
    while (last < lines.length && (lines[last].trim() === '' || lines[last].search(/\S/) > dash[1].length)) last += 1;
    const body = [line.replace(/^(\s*)-/, '$1 '), ...lines.slice(index + 1, last)];
    const keys = new Map(), inputs = new Map();
    const keyIndent = body[0].search(/\S/);
    let inWith = false;
    for (const entry of body) {
      const pair = /^(\s*)([\w-]+):\s*(.*)$/.exec(entry);
      if (!pair) continue;
      const [, indent, key, value] = pair;
      if (indent.length === keyIndent) {
        inWith = key === 'with';
        keys.set(key, unquote(value));
        const flow = key === 'with' && /^\{(.*)\}\s*(?:#.*)?$/.exec(value.trim());
        if (flow) for (const item of flow[1].split(',')) {
          const flowPair = /^\s*([\w-]+)\s*:\s*(.*?)\s*$/.exec(item);
          if (flowPair) inputs.set(flowPair[1], unquote(flowPair[2]));
        }
      } else if (inWith && indent.length > keyIndent) inputs.set(key, unquote(value));
    }
    steps.push({ line: index + 1, uses: keys.get('uses') ?? '', inputs });
  });
  return steps;
}

/** Setup-node and setup-bun steps of one workflow, with what each installs. */
export function workflowSetups(file, text) {
  const problems = [], node = [], bun = [];
  const steps = workflowSteps(text);
  for (const step of steps) {
    const action = Object.keys(SETUP_ACTIONS).find(name => step.uses.startsWith(`${name}@`));
    if (!action) continue;
    const [literal, fromFile] = SETUP_ACTIONS[action];
    const where = `${file}:${step.line}`;
    if (step.inputs.has(literal) === step.inputs.has(fromFile)) {
      problems.push(`${where}: ${action} step must set exactly one of ${literal} or ${fromFile} (unrecognised setup step)`);
      continue;
    }
    const source = step.inputs.has(literal) ? { literal: step.inputs.get(literal) } : { file: step.inputs.get(fromFile) };
    (action === 'actions/setup-node' ? node : bun).push({ where, ...source });
  }
  // A version key the step parser did not attribute to a setup step would escape every check.
  const attributed = steps.filter(step => Object.keys(SETUP_ACTIONS).some(name => step.uses.startsWith(`${name}@`)))
    .reduce((count, step) => count + [...step.inputs.keys()].filter(key => VERSION_KEYS.has(key)).length, 0);
  const stated = [...text.matchAll(/(?:^|[\s{,])((?:node|bun)-version(?:-file)?)\s*:/gm)].length;
  if (stated !== attributed) problems.push(`${file}: ${stated} Node/Bun version inputs but ${attributed} inside recognised setup steps; the step parser missed one`);
  return { problems, node, bun };
}

export function workflowProblems(workflows, pins, nvmrc, gap = NODE_SOURCE_GAP) {
  const problems = [], node = [], bun = [];
  for (const { file, text } of workflows) {
    const setups = workflowSetups(file, text);
    problems.push(...setups.problems);
    node.push(...setups.node);
    bun.push(...setups.bun);
  }
  for (const step of bun) {
    if (step.literal !== undefined && step.literal !== pins.bun) problems.push(`${step.where}: bun-version ${JSON.stringify(step.literal)} disagrees with packageManager bun@${pins.bun}`);
    if (step.file !== undefined && step.file !== 'package.json') problems.push(`${step.where}: bun-version-file ${JSON.stringify(step.file)} is not package.json (packageManager)`);
  }
  const minimumMajor = pins.nodeMinimum.split('.')[0];
  const literals = [...new Set(node.filter(step => step.literal !== undefined).map(step => step.literal))];
  if (literals.length > 1) problems.push(`release Node literals disagree: ${literals.join(', ')} (${node.filter(step => step.literal !== undefined).map(step => step.where).join(', ')})`);
  for (const step of node.filter(entry => entry.literal !== undefined)) {
    if (!/^\d+$/.test(step.literal) || Number(step.literal) < Number(minimumMajor)) problems.push(`${step.where}: node-version ${JSON.stringify(step.literal)} must be an exact major satisfying engines.node >=${pins.nodeMinimum}`);
  }
  const fileReaders = node.filter(step => step.file !== undefined);
  const pinned = nvmrc.trim();
  // With no literal left, every job reads .nvmrc and a pinned major there is the release's Node.
  const releaseMajor = literals.length === 1 ? literals[0] : literals.length === 0 && /^\d+$/.test(pinned) ? pinned : undefined;
  for (const step of fileReaders) if (step.file !== '.nvmrc') problems.push(`${step.where}: node-version-file ${JSON.stringify(step.file)} is not .nvmrc`);
  if (gap && pinned !== gap.nvmrc) problems.push(`.nvmrc is ${JSON.stringify(pinned)}, no longer ${JSON.stringify(gap.nvmrc)}: remove NODE_SOURCE_GAP (${gap.reason})`);
  if (fileReaders.length && releaseMajor && pinned !== releaseMajor && !(gap && pinned === gap.nvmrc)) {
    problems.push(`.nvmrc ${JSON.stringify(pinned)} (read by ${fileReaders.map(step => step.where).join(', ')}) disagrees with the release Node ${releaseMajor}`);
  }
  if (/^\d+$/.test(pinned) && Number(pinned) < Number(minimumMajor)) problems.push(`.nvmrc ${pinned} does not satisfy engines.node >=${pins.nodeMinimum}`);
  return { problems, releaseMajor };
}

/** First-party sources that pin the current Bun or a Node minimum in code. */
export function sourceProblems(file, text, pins) {
  const problems = [];
  for (const match of text.matchAll(/Bun\.version\s*[!=]==?\s*(['"`])(\d+\.\d+\.\d+)\1|\bNATIVE_BUNDLE_BUN_VERSION\s*=\s*(['"`])(\d+\.\d+\.\d+)\3/g)) {
    const version = match[2] ?? match[4];
    if (version !== pins.bun) problems.push(`${file}:${lineOf(text, match.index)}: pins Bun ${version}, packageManager is bun@${pins.bun}`);
  }
  for (const match of text.matchAll(/\b[A-Z_]*MIN_NODE_VERSION\s*=\s*(['"`])(\d+\.\d+\.\d+)\1/g)) {
    if (match[2] !== pins.nodeMinimum) problems.push(`${file}:${lineOf(text, match.index)}: Node minimum ${match[2]} disagrees with engines.node >=${pins.nodeMinimum}`);
  }
  return problems;
}

export function manifestProblems(file, manifest, pins) {
  const problems = [];
  for (const field of ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies']) {
    const electron = manifest[field]?.electron, types = manifest[field]?.['@types/bun'];
    if (electron !== undefined && electron !== pins.electron) problems.push(`${file}: ${field}.electron ${electron} disagrees with the root electron ${pins.electron}`);
    if (types !== undefined && types !== pins.bun) problems.push(`${file}: ${field}.@types/bun ${types} disagrees with packageManager bun@${pins.bun}`);
  }
  return problems;
}

/**
 * Rust toolchain installs in a workflow. Each must install the pinned channel
 * with exactly the components and target the build uses (`installCommand`).
 */
export function rustWorkflowProblems(workflows, toolchain) {
  const problems = [], installs = [];
  const expected = installCommand(toolchain);
  for (const { file, text } of workflows) {
    for (const match of text.matchAll(/rustup\s+toolchain\s+install\b[^\n]*/g)) {
      const where = `${file}:${lineOf(text, match.index)}`;
      installs.push(where);
      if (match[0].trim() !== expected) problems.push(`${where}: "${match[0].trim()}" is not "${expected}" (${CRATE_DIR}/rust-toolchain.toml)`);
    }
    for (const match of text.matchAll(/\b(?:toolchain|rust-version)\s*:\s*['"]?(\d+\.\d+(?:\.\d+)?|stable|beta|nightly)\b/g)) {
      problems.push(`${file}:${lineOf(text, match.index)}: a Rust toolchain input (${match[0].trim()}); install the pin with "${expected}" instead`);
    }
  }
  return { problems, installs };
}

/** Version statements in prose: `Node.js 22.13`, `Node >=22.13`, `Bun 1.4.4`, `bun@1.4.4`, `Electron 44.9.3`, `Electron 44`, `Rust 1.99.1`. */
export function docStatements(text) {
  const statements = [];
  for (const match of text.matchAll(/\bRust\s+v?(\d+\.\d+(?:\.\d+)?)\b/g)) statements.push({ tool: 'rust', text: match[0], index: match.index, version: match[1] });
  for (const match of text.matchAll(/\bNode(?:\.js)?\s+`?(?:>=\s*)?v?(\d+)(?:\.(\d+))?(?:\.(\d+))?/g)) {
    statements.push({ tool: 'node', text: match[0].replace(/`/g, ''), index: match.index, parts: match.slice(1).filter(Boolean) });
  }
  for (const match of text.matchAll(/(?<![\w@/.-])(?:Bun\s+v?|bun@)(\d+\.\d+\.\d+)\b/g)) statements.push({ tool: 'bun', text: match[0], index: match.index, version: match[1] });
  for (const match of text.matchAll(/\bElectron\s+v?(\d+)(?:\.(\d+)\.(\d+))?\b/g)) {
    statements.push({ tool: 'electron', text: match[0], index: match.index, parts: match.slice(1).filter(Boolean) });
  }
  return statements;
}

export function docProblems(file, text, pins, allowed = ALLOWED_DOC_STATEMENTS, used = new Set()) {
  const problems = [];
  for (const statement of docStatements(text)) {
    const allowance = allowed.find(entry => entry.file === file && entry.text === statement.text.replace(/\s+/g, ' '));
    if (allowance) { used.add(allowance); continue; }
    const where = `${file}:${lineOf(text, statement.index)}: "${statement.text}"`;
    if (statement.tool === 'node') {
      const minimum = pins.nodeMinimum.split('.');
      // An unknown release major already fails the workflow test.
      if (pins.releaseNodeMajor && statement.parts[0] !== pins.releaseNodeMajor) problems.push(`${where} is not the release's Node ${pins.releaseNodeMajor}`);
      else if (statement.parts.some((part, index) => part !== minimum[index])) problems.push(`${where} disagrees with engines.node >=${pins.nodeMinimum}`);
    } else if (statement.tool === 'bun') {
      if (statement.version !== pins.bun) problems.push(`${where} is not packageManager bun@${pins.bun}`);
    } else if (statement.tool === 'rust') {
      if (statement.version !== pins.rust) problems.push(`${where} is not the ledger core's Rust ${pins.rust}`);
    } else {
      const current = pins.electron.split('.');
      if (statement.parts.length === 1 ? statement.parts[0] !== current[0] : statement.parts.join('.') !== pins.electron) problems.push(`${where} is not the root electron ${pins.electron}`);
    }
  }
  return problems;
}

const manifest = JSON.parse(read('package.json'));
const sources = toolchainSources(manifest);
const pins = sources.pins;
const workflowFiles = tracked('.github/workflows/*.yml', '.github/workflows/*.yaml');
const workflows = workflowProblems(workflowFiles.map(file => ({ file, text: read(file) })), pins, read('.nvmrc'));
pins.releaseNodeMajor = workflows.releaseMajor;
const rustToolchain = readToolchainFile(root);
pins.rust = rustToolchain.channel;

test('each toolchain has one well-formed source', () => {
  assert.deepEqual(sources.problems, []);
});

test('workflow Node and Bun versions agree with their sources', () => {
  assert.ok(workflowFiles.includes('.github/workflows/release.yml') && workflowFiles.includes('.github/workflows/ci.yml'));
  assert.deepEqual(workflows.problems, [], `Workflow toolchain versions disagree:\n${workflows.problems.join('\n')}`);
  assert.ok(workflows.releaseMajor, 'the release workflows pin one Node major');
});

test('the Rust pin is one exact release that CI installs with what the build uses', () => {
  assert.match(rustToolchain.channel, /^\d+\.\d+\.\d+$/, `${CRATE_DIR}/rust-toolchain.toml`);
  const rust = rustWorkflowProblems(workflowFiles.map(file => ({ file, text: read(file) })), rustToolchain);
  assert.deepEqual(rust.problems, [], rust.problems.join('\n'));
  assert.ok(rust.installs.some(where => where.startsWith('.github/workflows/ci.yml:')), 'ci.yml installs the pinned Rust for the ledger core step');
  assert.ok(!rust.installs.some(where => where.startsWith('.github/workflows/release.yml:')), 'the release workflow builds no Rust');
  // The tracked crate is the only Rust toolchain file outside the frozen Tauri package.
  assert.deepEqual(tracked('*rust-toolchain', '*rust-toolchain.toml').filter(file => !file.startsWith('packages/desktop/')), [`${CRATE_DIR}/rust-toolchain.toml`]);
});

test('first-party sources pin the packageManager Bun and the engines Node minimum', () => {
  const builder = read('scripts/build-native-runtime.mjs');
  assert.match(builder, /packageManager/, 'scripts/build-native-runtime.mjs must read the Bun pin from package.json');
  // This file's own fixtures state disagreeing versions on purpose.
  const files = tracked('scripts', 'packages').filter(file => /\.(?:[cm]?js|[cm]?ts|tsx|jsx)$/.test(file) && !/\.d\.[cm]?ts$/.test(file) && file !== 'scripts/toolchain-pins.test.mjs');
  const texts = new Map(files.map(file => [file, read(file)]));
  for (const anchor of ['packages/web/server/lib/opencode/runtime-host/native-artifacts.js', 'packages/cursor-sdk-runtime/node-version.js']) {
    assert.ok(texts.has(anchor), `${anchor} is scanned`);
  }
  assert.match(texts.get('packages/cursor-sdk-runtime/node-version.js'), /CURSOR_SDK_MIN_NODE_VERSION\s*=/);
  const problems = [...texts].flatMap(([file, text]) => sourceProblems(file, text, pins));
  assert.deepEqual(problems, [], problems.join('\n'));
});

test('workspace manifests pin the root Electron and the packageManager Bun types', () => {
  const problems = tracked('*package.json').filter(file => file !== 'package.json' && path.posix.basename(file) === 'package.json')
    .flatMap(file => manifestProblems(file, JSON.parse(read(file)), pins));
  assert.deepEqual(problems, [], problems.join('\n'));
});

test('docs state the pinned Node, Bun, Electron and Rust versions', () => {
  const used = new Set();
  const files = tracked('*.md', '*.mdx').filter(file => !SKIPPED_DOCS.has(file));
  assert.ok(files.includes('README.md') && files.includes('docs/RELEASE_PIPELINE.md'));
  const problems = files.flatMap(file => docProblems(file, read(file), pins, ALLOWED_DOC_STATEMENTS, used));
  for (const entry of ALLOWED_DOC_STATEMENTS) if (!used.has(entry)) problems.push(`stale allowlist entry: ${entry.file} "${entry.text}"`);
  assert.deepEqual(problems, [], `Docs must state the pinned versions (or allowlist a historical statement):\n${problems.join('\n')}`);
});

test('the checks flag every kind of disagreement', () => {
  const fixture = { nodeMinimum: '22.13.0', bun: '1.4.4', electron: '44.9.3', releaseNodeMajor: '22' };
  const release = "jobs:\n  a:\n    steps:\n      - uses: actions/setup-node@v4\n        with:\n          node-version: '22'\n      - uses: oven-sh/setup-bun@v2\n        if: ${{ env.X == '' }}\n        with:\n          bun-version: '1.4.4'\n      - name: next\n        run: true\n";
  const ci = "jobs:\n  b:\n    steps:\n      - name: Node\n        uses: 'actions/setup-node@v4'\n        with:\n          node-version-file: '.nvmrc'\n      - uses: oven-sh/setup-bun@v2\n        with: { bun-version-file: package.json }\n";
  const check = (files, nvmrc = 'lts/*', gap = NODE_SOURCE_GAP) => workflowProblems(files.map(([file, text]) => ({ file, text })), fixture, nvmrc, gap).problems.join('\n');
  assert.equal(check([['release.yml', release], ['ci.yml', ci]]), '');
  assert.equal(check([['release.yml', release], ['ci.yml', ci]], '22', null), '');
  assert.match(check([['release.yml', release], ['ci.yml', ci]], '22'), /remove NODE_SOURCE_GAP/);
  const fromFile = release.replace("node-version: '22'", 'node-version-file: .nvmrc');
  assert.equal(workflowProblems([{ file: 'r.yml', text: fromFile }], fixture, '22', null).releaseMajor, '22');
  assert.match(check([['r.yml', fromFile]], '22'), /remove NODE_SOURCE_GAP/);
  assert.match(check([['release.yml', release], ['ci.yml', ci]], '24', null), /disagrees with the release Node 22/);
  assert.match(check([['release.yml', release], ['ci.yml', ci]], 'lts/*', null), /disagrees with the release Node 22/);
  assert.match(check([['release.yml', release], ['c.yml', release.replace("node-version: '22'", "node-version: '24'")]]), /release Node literals disagree: 22, 24/);
  assert.match(check([['r.yml', release.replace(/'22'/g, "'20'")]]), /must be an exact major satisfying engines/);
  assert.match(check([['r.yml', release.replace("bun-version: '1.4.4'", "bun-version: '1.4.3'")]]), /bun-version "1\.4\.3" disagrees/);
  assert.match(check([['c.yml', ci.replace('{ bun-version-file: package.json }', "{ bun-version: '1.4.5' }")]]), /bun-version "1\.4\.5" disagrees/);
  assert.match(check([['r.yml', release.replace("        with:\n          node-version: '22'\n", '')]]), /unrecognised setup step/);
  assert.match(check([['r.yml', release + "      - uses: some/other@v1\n        with:\n          node-version: '22'\n"]]), /step parser missed one/);
  assert.match(sourceProblems('b.mjs', "if(Bun.version!=='1.4.3')throw 1;", fixture).join(), /pins Bun 1\.4\.3/);
  assert.match(sourceProblems('n.js', "export const NATIVE_BUNDLE_BUN_VERSION = '1.4.5';", fixture).join(), /pins Bun 1\.4\.5/);
  assert.match(sourceProblems('m.js', "export const CURSOR_SDK_MIN_NODE_VERSION = '22.12.0';", fixture).join(), /Node minimum 22\.12\.0/);
  assert.deepEqual(sourceProblems('b.mjs', "if(Bun.version!==pinnedBun)throw 1; const r=/NATIVE_BUNDLE_BUN_VERSION = '[^']+'/;", fixture), []);
  assert.match(manifestProblems('p/package.json', { devDependencies: { electron: '44.9.2', '@types/bun': '1.4.3' } }, fixture).join(), /electron 44\.9\.2.*@types\/bun 1\.4\.3/);
  assert.match(docProblems('d.md', 'Use Node.js 24 or newer.', fixture, []).join(), /release's Node 22/);
  assert.match(docProblems('d.md', 'Use Node.js 22.12 or newer.', fixture, []).join(), /engines\.node/);
  assert.match(docProblems('d.md', 'Built with Bun 1.4.5.', fixture, []).join(), /bun@1\.4\.4/);
  assert.match(docProblems('d.md', '`"packageManager": "bun@1.4.5"`', fixture, []).join(), /bun@1\.4\.4/);
  assert.match(docProblems('d.md', 'The shell runs Electron 45.', fixture, []).join(), /electron 44\.9\.3/);
  assert.deepEqual(docProblems('d.md', 'Node.js 22.13 or newer, Node `>=22.13`, Bun 1.4.4, `@ff-labs/fff-bun@0.10.5`, Electron 44.9.3 and Electron 44.', fixture, []), []);
  assert.deepEqual(docProblems('d.md', 'Electron 41.2.1 was sampled.', fixture, [{ file: 'd.md', text: 'Electron 41.2.1' }]), []);
  const rustPins = { ...fixture, rust: '1.99.1' };
  assert.match(docProblems('d.md', 'Build it with Rust 1.98.0.', rustPins, []).join(), /Rust 1\.99\.1/);
  assert.match(docProblems('d.md', 'Rust 1.99 is enough.', rustPins, []).join(), /Rust 1\.99\.1/);
  assert.deepEqual(docProblems('d.md', 'Rust 1.99.1 builds the module.', rustPins, []), []);
  const pinned = { channel: '1.99.1', components: ['rustfmt', 'clippy'], targets: ['wasm32-unknown-unknown'] };
  const install = 'rustup toolchain install 1.99.1 --profile minimal --component rustfmt,clippy --target wasm32-unknown-unknown';
  const rust = text => rustWorkflowProblems([{ file: 'ci.yml', text }], pinned).problems.join('\n');
  assert.equal(rust(`      - run: |\n          ${install}\n          node scripts/build-ledger-core.mjs --verify\n`), '');
  assert.match(rust(`      - run: ${install.replace('1.99.1', '1.99.0')}\n`), /ci\.yml:1: .*is not/);
  assert.match(rust(`      - run: ${install.replace(',clippy', '')}\n`), /is not/);
  assert.match(rust('      - uses: dtolnay/rust-toolchain@master\n        with:\n          toolchain: stable\n'), /a Rust toolchain input/);
});
