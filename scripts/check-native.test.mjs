// The Rust-free contract of the product's Cargo workspace (packages/native):
// the pin, the check steps, the missing-toolchain failure, exact dependency
// pins, the lockfile, the licence policy and the documentation of every crate.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, test } from 'node:test';
import YAML from 'yaml';
import { CRATE_DIR, readToolchainFile } from './build-ledger-core.mjs';
import { CARGO_DENY_VERSION, NATIVE_DIR, advisorySteps, cargoDenyInstallCommand, locateNativeToolchain, nativeInstallCommand, nativeSteps, readNativeToolchain, repositoryRoot }
  from './check-native.mjs';
import { parseExpression, readAllowList, satisfied, violations } from './check-native-licenses.mjs';

const read = file => readFileSync(path.join(repositoryRoot, NATIVE_DIR, file), 'utf8');
const tracked = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '--', NATIVE_DIR], { cwd: repositoryRoot, encoding: 'utf8' }).split('\n').filter(Boolean);

/** `[workspace.dependencies]` as name -> version requirement. */
function workspaceDependencies(manifest) {
  const section = /^\[workspace\.dependencies\]\n([\s\S]*?)(?=^\[|(?![\s\S]))/m.exec(manifest)?.[1] ?? '';
  return Object.fromEntries([...section.matchAll(/^([A-Za-z0-9_-]+)\s*=\s*(?:\{[^}]*version\s*=\s*"([^"]+)"[^}]*\}|"([^"]+)")/gm)].map(match => [match[1], match[2] ?? match[3]]));
}

/**
 * The advisories `[advisories] ignore` lists, as { id, reason }; throws on an
 * entry that is not `{ id = "RUSTSEC-YYYY-NNNN", reason = "<why>" }`.
 */
function ignoredAdvisories(deny) {
  const section = /^\[advisories\]\n([\s\S]*?)(?=^\[|(?![\s\S]))/m.exec(deny)?.[1];
  if (section === undefined) throw new Error('deny.toml has no [advisories] section');
  const list = /^ignore\s*=\s*\[([\s\S]*?)\]\s*$/m.exec(section.replace(/^\s*#.*$/gm, ''))?.[1];
  if (list === undefined) throw new Error('[advisories] has no ignore list');
  const entries = [];
  let rest = list;
  for (const match of list.matchAll(/\{([^}]*)\}/g)) {
    const id = /\bid\s*=\s*"(RUSTSEC-\d{4}-\d{4})"/.exec(match[1])?.[1];
    const reason = /\breason\s*=\s*"([^"]*)"/.exec(match[1])?.[1]?.trim();
    if (!id) throw new Error(`ignored advisory without a RUSTSEC id: {${match[1]}}`);
    if (!reason) throw new Error(`ignored advisory ${id} has no reason`);
    entries.push({ id, reason });
    rest = rest.replace(match[0], '');
  }
  if (rest.replace(/[\s,]/g, '')) throw new Error(`ignored advisories must be { id, reason } tables, found: ${rest.trim()}`);
  return entries;
}

/** Lockfile packages as { name, version, source }. */
function lockPackages(lock) {
  return lock.split('[[package]]').slice(1).map(block => ({
    name: /^name = "([^"]+)"/m.exec(block)?.[1], version: /^version = "([^"]+)"/m.exec(block)?.[1], source: /^source = "([^"]+)"/m.exec(block)?.[1] ?? null,
  }));
}

describe('packages/native Cargo workspace', () => {
  test('pins one exact Rust release, the same one the ledger core pins', () => {
    const toolchain = readNativeToolchain();
    assert.match(toolchain.channel, /^\d+\.\d+\.\d+$/);
    assert.deepEqual(toolchain.components, ['rustfmt', 'clippy']);
    assert.equal(toolchain.channel, readToolchainFile().channel, `${NATIVE_DIR} and ${CRATE_DIR} pin the same Rust`);
    assert.equal(nativeInstallCommand(toolchain), `rustup toolchain install ${toolchain.channel} --profile minimal --component rustfmt,clippy`);
  });

  test('checks formatting, clippy with warnings denied and the tests, locked and offline after one fetch', () => {
    const steps = nativeSteps().map(step => step.join(' '));
    assert.deepEqual(steps, ['fetch --locked', 'licences', 'fmt --all --check', 'clippy --locked --offline --workspace --all-targets -- -D warnings', 'test --locked --offline --workspace']);
    assert.match(nativeSteps({ deny: true }).at(-1).join(' '), /^deny .*check licenses advisories sources$/);
  });

  test('a missing toolchain fails with the command that installs it', () => {
    const toolchain = { channel: '1.99.1', components: ['rustfmt', 'clippy'], targets: [] };
    assert.throws(() => locateNativeToolchain(toolchain, { run: () => ({ status: 1, stdout: '' }) }),
      /Rust 1\.99\.1 is not installed\. .*\n {2}rustup toolchain install 1\.99\.1 --profile minimal --component rustfmt,clippy$/s);
    assert.throws(() => locateNativeToolchain(toolchain, { run: () => ({ error: Object.assign(new Error('x'), { code: 'ENOENT' }) }) }), /rustup is not installed/);
  });

  test('every third-party crate is pinned exactly, locked, from crates.io and documented', () => {
    const manifest = read('Cargo.toml');
    const dependencies = workspaceDependencies(manifest);
    assert.ok(Object.keys(dependencies).length > 0);
    for (const [name, version] of Object.entries(dependencies)) assert.match(version, /^=\d+\.\d+\.\d+$/, `${name} must be pinned with =x.y.z`);
    // Member crates take dependencies from the workspace only.
    const members = tracked.filter(file => /^packages\/native\/crates\/[^/]+\/Cargo\.toml$/.test(file));
    assert.ok(members.length > 0);
    for (const member of members) {
      const section = /^\[(?:dev-)?dependencies\]\n([\s\S]*?)(?=^\[|(?![\s\S]))/gm;
      for (const match of readFileSync(path.join(repositoryRoot, member), 'utf8').matchAll(section)) {
        for (const line of match[1].split('\n').filter(row => /^[A-Za-z0-9_-]+\s*[.=]/.test(row))) assert.match(line, /^[A-Za-z0-9_-]+\.workspace = true$/, `${member}: ${line}`);
      }
    }
    assert.ok(tracked.includes(`${NATIVE_DIR}/Cargo.lock`), 'Cargo.lock is tracked');
    const packages = lockPackages(read('Cargo.lock'));
    for (const item of packages) assert.ok(item.source === null || item.source === 'registry+https://github.com/rust-lang/crates.io-index', `${item.name} comes from ${item.source}`);
    for (const [name, version] of Object.entries(dependencies)) assert.ok(packages.some(item => item.name === name && `=${item.version}` === version), `Cargo.lock holds ${name} ${version}`);
    const documentation = read('DOCUMENTATION.md');
    for (const [name, version] of Object.entries(dependencies)) assert.ok(documentation.includes(`\`${name}\` ${version.slice(1)}`), `DOCUMENTATION.md names ${name} ${version.slice(1)}`);
  });

  test('the licence policy allows only permissive licences and crates.io', () => {
    const deny = read('deny.toml');
    const allow = /^allow\s*=\s*\[([\s\S]*?)\]/m.exec(deny)?.[1] ?? '';
    const licences = [...allow.matchAll(/"([^"]+)"/g)].map(match => match[1]);
    assert.ok(licences.includes('MIT') && licences.includes('Apache-2.0'));
    for (const licence of licences) assert.doesNotMatch(licence, /GPL|AGPL|LGPL|SSPL|BUSL|CC-BY-NC/i, licence);
    assert.match(deny, /unknown-registry\s*=\s*"deny"/);
    assert.match(deny, /unknown-git\s*=\s*"deny"/);
  });

  test('the licence check reads its allow list from deny.toml and evaluates SPDX expressions', () => {
    const allowList = readAllowList(read('deny.toml'));
    const policy = [...(/^allow\s*=\s*\[([\s\S]*?)\]/m.exec(read('deny.toml'))?.[1] ?? '').matchAll(/"([^"]+)"/g)].map(match => match[1]);
    assert.deepEqual(allowList, policy, 'one list, the one cargo-deny reads');
    const allow = new Set(allowList);
    const ok = expression => satisfied(parseExpression(expression), allow);
    for (const expression of ['MIT', 'MIT OR Apache-2.0', 'Unlicense OR MIT', 'MIT/Apache-2.0', '(MIT OR Apache-2.0) AND Unicode-3.0', 'Apache-2.0 WITH LLVM-exception',
      'Apache-2.0 OR Apache-2.0 WITH LLVM-exception OR MIT']) assert.ok(ok(expression), expression);
    for (const expression of ['GPL-3.0', 'MIT AND GPL-2.0', 'Unlicense', 'LGPL-2.1 OR MPL-2.0', 'GPL-2.0 WITH Classpath-exception-2.0']) assert.equal(ok(expression), false, expression);
    assert.throws(() => parseExpression('MIT OR'), /ends early/);
    assert.throws(() => parseExpression('(MIT'), /missing \)/);
    // A planted violation of each kind is reported with the package that has it.
    const metadata = { packages: [
      { name: 'fine', version: '1.0.0', license: 'MIT OR Apache-2.0' },
      { name: 'copyleft', version: '2.0.0', license: 'MIT AND GPL-3.0' },
      { name: 'unlicensed', version: '0.1.0', license: null, license_file: 'LICENSE.txt' },
      { name: 'garbled', version: '0.2.0', license: 'MIT OR OR' },
    ] };
    const found = violations(metadata, allowList);
    assert.equal(found.length, 3, found.join('\n'));
    assert.match(found[0], /^copyleft 2\.0\.0: MIT AND GPL-3\.0 is not allowed/);
    assert.match(found[1], /^unlicensed 0\.1\.0: no licence expression \(only a licence file, LICENSE\.txt\)/);
    assert.match(found[2], /^garbled 0\.2\.0: licence expression/);
  });

  test('CI checks advisories with a pinned cargo-deny from a pinned cache, and every ignored advisory has a reason', () => {
    const text = readFileSync(path.join(repositoryRoot, '.github/workflows/ci.yml'), 'utf8');
    const steps = YAML.parse(text).jobs.static.steps;
    const index = predicate => steps.findIndex(predicate);
    const gate = index(step => step.id === 'native');
    assert.ok(gate >= 0, 'the static job decides once whether packages/native is checked');
    assert.match(steps[gate].run, /paths="packages\/native scripts\/check-native\.mjs scripts\/check-native-licenses\.mjs \.github\/workflows\/ci\.yml"/);
    assert.match(steps[gate].run, /echo "run=false" >> "\$GITHUB_OUTPUT"[\s\S]*echo "run=true" >> "\$GITHUB_OUTPUT"/);
    const gated = "steps.native.outputs.run == 'true'";
    const check = index(step => typeof step.run === 'string' && /^node scripts\/check-native\.mjs$/m.test(step.run));
    const cache = index(step => typeof step.uses === 'string' && step.uses.startsWith('actions/cache@'));
    const advisories = index(step => typeof step.run === 'string' && step.run.includes('scripts/check-native.mjs --advisories'));
    assert.ok(gate < check && check < cache && cache < advisories, `order: gate, check (installs Rust), cache, advisories (${[gate, check, cache, advisories]})`);
    for (const at of [check, cache, advisories]) assert.equal(steps[at].if, gated, steps[at].name);
    assert.ok(steps[check].run.includes(nativeInstallCommand(readNativeToolchain())));
    // The cache action is pinned to a full commit, with its release named beside it.
    const [, hash] = /^actions\/cache@([0-9a-f]{40})$/.exec(steps[cache].uses) ?? [];
    assert.ok(hash, `${steps[cache].uses} is not pinned to a full commit hash`);
    assert.match(text, new RegExp(`uses: actions/cache@${hash} # v\\d+\\.\\d+\\.\\d+\\n`));
    assert.match(text, new RegExp(`release v\\d+\\.\\d+\\.\\d+\\n\\s*# \\(${hash},`), 'the comment names the release and the hash');
    // Its key changes with the cargo-deny release and the Rust that builds it; it holds what the step installs.
    assert.equal(steps[cache].with.key, `cargo-deny-${CARGO_DENY_VERSION}-rust-${readNativeToolchain().channel}-\${{ runner.os }}-\${{ runner.arch }}`);
    assert.equal(steps[cache].with.path, '~/.cache/devryan-cargo-deny');
    assert.equal(steps[advisories].run, 'CARGO_DENY_ROOT="$HOME/.cache/devryan-cargo-deny" node scripts/check-native.mjs --advisories');
    assert.equal(steps[advisories]['continue-on-error'], undefined, 'a new advisory fails the job');
    assert.ok(steps[advisories].name.includes(`cargo deny ${CARGO_DENY_VERSION}`) && steps[cache].name.includes(CARGO_DENY_VERSION));
    // The check fetches the advisory database (no --offline) and checks the same policy as --deny.
    assert.deepEqual(advisorySteps().map(step => step.join(' ')), ['fetch --locked', 'deny --locked check licenses advisories sources']);
    assert.equal(nativeSteps({ deny: true }).at(-1).filter(arg => arg !== '--offline').join(' '), advisorySteps().at(-1).join(' '));
    assert.deepEqual(cargoDenyInstallCommand('/r'), ['install', 'cargo-deny', '--version', CARGO_DENY_VERSION, '--locked', '--root', '/r']);
    // Every advisory ignored on purpose is in deny.toml with its reason.
    const ignored = ignoredAdvisories(read('deny.toml'));
    assert.equal(new Set(ignored.map(entry => entry.id)).size, ignored.length, 'each advisory is ignored once');
    const policy = list => `[advisories]\nversion = 2\nignore = [\n${list}\n]\n\n[licenses]\n`;
    assert.deepEqual(ignoredAdvisories(policy('  { id = "RUSTSEC-2026-0001", reason = "not reachable: we never call x" },')),
      [{ id: 'RUSTSEC-2026-0001', reason: 'not reachable: we never call x' }]);
    assert.deepEqual(ignoredAdvisories(policy('')), []);
    assert.throws(() => ignoredAdvisories(policy('  "RUSTSEC-2026-0001",')), /must be \{ id, reason \} tables/);
    assert.throws(() => ignoredAdvisories(policy('  { id = "RUSTSEC-2026-0001" },')), /RUSTSEC-2026-0001 has no reason/);
    assert.throws(() => ignoredAdvisories(policy('  { id = "RUSTSEC-2026-0001", reason = " " },')), /has no reason/);
    assert.throws(() => ignoredAdvisories(policy('  { reason = "x" },')), /without a RUSTSEC id/);
  });

  test('builds stay out of git and nothing here is a workspace package', () => {
    assert.match(read('.gitignore'), /^\/target\/$/m);
    assert.ok(!tracked.some(file => file.includes('/target/')), 'no build output is tracked');
    assert.equal(existsSync(path.join(repositoryRoot, NATIVE_DIR, 'package.json')), false, 'packages/native is not a Bun workspace package');
  });
});
