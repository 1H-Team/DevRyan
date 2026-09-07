import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

for (const scenario of [
  { name: 'unsigned local bundle', args: [], signing: '', expected: ['--no-sign', '--config', '{"bundle":{"createUpdaterArtifacts":false}}'] },
  { name: 'signed release path', args: [], signing: 'nonsecret-test-marker', expected: [] },
  { name: 'compilation without bundle', args: ['--no-bundle'], signing: '', expected: ['--no-bundle'] },
]) {
  test(`release smoke forwards actual build arguments for ${scenario.name}`, (t) => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'devryan-release-args-'));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    mkdirSync(path.join(root, 'scripts'));
    mkdirSync(path.join(root, 'bin'));
    // Run the production script with disposable tool doubles. No build, install,
    // signing, network, or installed-user configuration is involved.
    copyFileSync(new URL('./test-release-build.sh', import.meta.url), path.join(root, 'scripts/test-release-build.sh'));
    mkdirSync(path.join(root, 'packages/desktop/src-tauri/target/aarch64-apple-darwin/release/bundle/macos/Fixture.app/Contents/Resources/default-config'), { recursive: true });
    const calls = path.join(root, 'calls.jsonl');
    const stub = `#!${process.execPath}
const fs = require('node:fs');
const path = require('node:path');
const tool = path.basename(process.argv[1]);
fs.appendFileSync(process.env.FIXTURE_CALLS, JSON.stringify({tool,args:process.argv.slice(2)})+'\\n');
if (tool === 'node' && process.argv[2] === '-p') console.log('0.0.0');
if (tool === 'git') console.log('0123456789012345678901234567890123456789');
if (tool === 'rustup') console.log('aarch64-apple-darwin');
`;
    for (const tool of ['bun', 'node', 'git', 'rustc', 'cargo', 'rustup']) {
      writeFileSync(path.join(root, 'bin', tool), stub, { mode: 0o755 });
    }
    const result = spawnSync('/bin/bash', [path.join(root, 'scripts/test-release-build.sh'), 'aarch64', ...scenario.args], {
      cwd: root, encoding: 'utf8', timeout: 10_000,
      env: { PATH: `${path.join(root, 'bin')}:/usr/bin:/bin`, FIXTURE_CALLS: calls, TAURI_SIGNING_PRIVATE_KEY: scenario.signing },
    });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const commands = readFileSync(calls, 'utf8').trim().split('\n').map(line => JSON.parse(line));
    const builds = commands.filter(c => c.tool === 'bun' && c.args.includes('tauri'));
    assert.equal(builds.length, 1);
    assert.deepEqual(builds[0].args, ['run', '--cwd', 'packages/desktop', 'tauri', 'build', '--target', 'aarch64-apple-darwin', ...scenario.expected]);
    assert.ok(commands.some(c => c.tool === 'bun' && c.args[0] === 'install' && c.args[1] === '--frozen-lockfile'));
  });
}
