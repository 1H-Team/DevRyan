import { afterEach, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { developerToolEnvironment } from './execution-developer-tools.js';
import { startSessionExecution } from './session-execution.js';

const roots = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => fs.rm(root, { recursive: true, force: true }))); });
const temporary = async (prefix) => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), prefix))); roots.push(root); return root;
};

// A selected developer directory laid out as Xcode installs it (without
// xcodebuild it stands for the Command Line Tools).
const developerLayout = async ({ xcode = true, toolchain = true, sdk = true } = {}) => {
  const developer = path.join(await temporary('devryan-developer-tools-'), 'Xcode.app', 'Contents', 'Developer');
  const layout = { developer, bin: path.join(developer, 'usr', 'bin'), toolchain: path.join(developer, 'Toolchains', 'XcodeDefault.xctoolchain', 'usr', 'bin'),
    sdk: path.join(developer, 'Platforms', 'MacOSX.platform', 'Developer', 'SDKs', 'MacOSX.sdk') };
  await fs.mkdir(layout.bin, { recursive: true });
  if (xcode) await fs.writeFile(path.join(layout.bin, 'xcodebuild'), '');
  if (toolchain) await fs.mkdir(layout.toolchain, { recursive: true });
  if (sdk) await fs.mkdir(layout.sdk, { recursive: true });
  return layout;
};
const selecting = (stdout) => {
  const calls = [];
  return { calls, run: async (file, args, options) => {
    calls.push({ file, args, env: options.env });
    if (stdout instanceof Error) throw stdout;
    return { stdout, stderr: '' };
  } };
};
const darwin = (run, options = {}) => ({ platform: 'darwin', run, cache: new Map(), ...options });

test('a full Xcode selection puts its toolchain, then its developer tools, ahead of /usr/bin and supplies the SDK', async () => {
  const xcode = await developerLayout(), { calls, run } = selecting(`${xcode.developer}\n`);
  expect(await developerToolEnvironment({ PATH: '/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin' }, darwin(run)))
    .toEqual({ PATH: `/opt/homebrew/bin:${xcode.toolchain}:${xcode.bin}:/usr/bin:/bin:/usr/sbin`, SDKROOT: xcode.sdk });
  // The selection is read on the host without the command's PATH or a DEVELOPER_DIR it does not set.
  expect(calls).toEqual([{ file: '/usr/bin/xcode-select', args: ['-p'], env: { PATH: '/usr/bin:/bin' } }]);
});

test('entries already ahead of /usr/bin, later /usr/bin entries and an existing SDKROOT are kept', async () => {
  const xcode = await developerLayout(), { run } = selecting(xcode.developer), options = darwin(run);
  expect(await developerToolEnvironment({ PATH: `${xcode.toolchain}:/usr//bin/:/bin:/usr/bin`, SDKROOT: '/custom/sdk' }, options))
    .toEqual({ PATH: `${xcode.toolchain}:${xcode.bin}:/usr//bin/:/bin:/usr/bin` });
  expect(await developerToolEnvironment({ PATH: `${xcode.toolchain}:${xcode.bin}:/usr/bin`, SDKROOT: '/custom/sdk' }, options)).toEqual({});
  // A layout without a toolchain or SDK contributes only what exists.
  const partial = await developerLayout({ toolchain: false, sdk: false });
  expect(await developerToolEnvironment({ PATH: '/usr/bin:/bin' }, darwin(selecting(partial.developer).run))).toEqual({ PATH: `${partial.bin}:/usr/bin:/bin` });
});

test('the Command Line Tools, another platform, a PATH without /usr/bin and an unreadable selection keep the environment', async () => {
  const tools = await developerLayout({ xcode: false });
  expect(await developerToolEnvironment({ PATH: '/usr/bin:/bin' }, darwin(selecting(tools.developer).run))).toEqual({});
  const xcode = await developerLayout(), unused = selecting(xcode.developer);
  for (const [env, options] of [[{ PATH: '/usr/bin:/bin' }, darwin(unused.run, { platform: 'linux' })],
    [{ PATH: '/opt/homebrew/bin:/bin' }, darwin(unused.run)], [{}, darwin(unused.run)], [undefined, darwin(unused.run)]]) {
    expect(await developerToolEnvironment(env, options)).toEqual({});
  }
  expect(unused.calls).toEqual([]);
  for (const stdout of [new Error('xcode-select: error: unable to get active developer directory'), '', 'relative/Developer',
    `${xcode.developer}:/elsewhere`, `${xcode.developer}/../Developer`, `${xcode.developer}\u0007`]) {
    expect(await developerToolEnvironment({ PATH: '/usr/bin' }, darwin(selecting(stdout).run))).toEqual({});
  }
});

test('the kill switch keeps the environment without reading the selection', async () => {
  const xcode = await developerLayout(), { calls, run } = selecting(xcode.developer);
  const saved = process.env.DEVRYAN_DEVELOPER_TOOL_PATH;
  try {
    process.env.DEVRYAN_DEVELOPER_TOOL_PATH = '0';
    expect(await developerToolEnvironment({ PATH: '/usr/bin:/bin' }, darwin(run))).toEqual({});
    expect(calls).toEqual([]);
  } finally {
    if (saved === undefined) delete process.env.DEVRYAN_DEVELOPER_TOOL_PATH; else process.env.DEVRYAN_DEVELOPER_TOOL_PATH = saved;
  }
});

test('the selection follows the command DEVELOPER_DIR, is shared while pending and is read again after a minute', async () => {
  const xcode = await developerLayout(), { calls, run } = selecting(xcode.developer);
  let time = 1_000;
  const options = darwin(run, { now: () => time }), env = { PATH: '/usr/bin' };
  const expected = { PATH: `${xcode.toolchain}:${xcode.bin}:/usr/bin`, SDKROOT: xcode.sdk };
  expect(await Promise.all([developerToolEnvironment(env, options), developerToolEnvironment(env, options)])).toEqual([expected, expected]);
  time += 59_999;
  expect(await developerToolEnvironment(env, options)).toEqual(expected);
  expect(calls).toHaveLength(1);
  await developerToolEnvironment({ ...env, DEVELOPER_DIR: '/Applications/Xcode-beta.app' }, options);
  expect(calls.map(call => call.env)).toEqual([{ PATH: '/usr/bin:/bin' }, { PATH: '/usr/bin:/bin', DEVELOPER_DIR: '/Applications/Xcode-beta.app' }]);
  time += 1;
  await developerToolEnvironment(env, options);
  expect(calls).toHaveLength(3);
  // A failed read is not repeated for every command either.
  const failing = selecting(new Error('unavailable')), failingOptions = darwin(failing.run, { now: () => time });
  for (let attempt = 0; attempt < 3; attempt += 1) expect(await developerToolEnvironment(env, failingOptions)).toEqual({});
  expect(failing.calls).toHaveLength(1);
});

// Apple's shims exit 71 under both profiles only while a full Xcode is selected.
const selected = process.platform === 'darwin' ? spawnSync('/usr/bin/xcode-select', ['-p'], { encoding: 'utf8' }).stdout?.trim() ?? '' : '';
const fullXcode = path.isAbsolute(selected) && existsSync(path.join(selected, 'usr', 'bin', 'xcodebuild'));
test.skipIf(!fullXcode)('a confined shell runs Git, cc and make through PATH under both profiles while a full Xcode is selected', async () => {
  const root = await temporary('devryan-developer-shell-'), launcher = path.join(root, 'launcher');
  // Runs the command under the prepared profile, as the native launcher does,
  // without the spawn adapter: none is built here, and it never loads into the shims.
  await fs.writeFile(launcher, `#!/bin/sh
profile=$3 receipt=$4
shift 5
/usr/bin/env -u DYLD_INSERT_LIBRARIES -u BASH_ENV -u ZDOTDIR /usr/bin/sandbox-exec -f "$profile" "$@"
code=$?
umask 077
printf '{"terminated":true,"confined":true,"cancelled":false,"exitCode":%d}' "$code" > "$receipt"
exit "$code"
`, { mode: 0o755 });
  const toolchain = path.join(selected, 'Toolchains', 'XcodeDefault.xctoolchain', 'usr', 'bin');
  const sdk = path.join(selected, 'Platforms', 'MacOSX.platform', 'Developer', 'SDKs', 'MacOSX.sdk');
  const run = async (viewDirectory, readOnly, script) => {
    let output = '';
    const handle = await startSessionExecution({ launcher, lease: { viewDirectory, ...(readOnly ? { readOnly: true } : {}) }, socketDirectory: null,
      command: '/bin/sh', args: ['-c', script], env: { PATH: '/usr/bin:/bin', LANG: 'C' }, onOutput: ({ data }) => { output += data; } });
    return { status: (await handle.result).exitCode, output: output.trim() };
  };
  for (const readOnly of [true, false]) {
    const viewDirectory = path.join(root, readOnly ? 'plan' : 'implementation', 'worktree');
    await fs.mkdir(viewDirectory, { recursive: true });
    await fs.writeFile(path.join(viewDirectory, 'hello.c'), '#include <stdio.h>\nint main(void) { puts("hello"); return 0; }\n');
    expect(spawnSync('git', ['init', '--quiet', viewDirectory], { env: { PATH: process.env.PATH, HOME: root, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' } }).status).toBe(0);
    const saved = process.env.DEVRYAN_DEVELOPER_TOOL_PATH;
    try {
      process.env.DEVRYAN_DEVELOPER_TOOL_PATH = '0';
      // Without the developer tool path the shim fails, so this run proves the cause.
      expect(await run(viewDirectory, readOnly, 'git --version')).toMatchObject({ status: 71 });
    } finally {
      if (saved === undefined) delete process.env.DEVRYAN_DEVELOPER_TOOL_PATH; else process.env.DEVRYAN_DEVELOPER_TOOL_PATH = saved;
    }
    expect(await run(viewDirectory, readOnly, 'printf "%s\\n%s\\n" "$PATH" "$SDKROOT"; command -v git; command -v cc; command -v make'))
      .toEqual({ status: 0, output: [`${toolchain}:${path.join(selected, 'usr', 'bin')}:/usr/bin:/bin`, sdk,
        path.join(selected, 'usr', 'bin', 'git'), path.join(toolchain, 'cc'), path.join(selected, 'usr', 'bin', 'make')].join('\n') });
    expect(await run(viewDirectory, readOnly, 'git status --short')).toEqual({ status: 0, output: '?? hello.c' });
    expect(await run(viewDirectory, readOnly, 'cc --version')).toMatchObject({ status: 0, output: expect.stringContaining('clang') });
    expect(await run(viewDirectory, readOnly, 'make --version')).toMatchObject({ status: 0, output: expect.stringContaining('GNU Make') });
    // The SDK the shim would supply: without it the headers are not found. The
    // compiler runs in-process because this launcher has no spawn adapter.
    expect(await run(viewDirectory, readOnly, 'cc -fintegrated-cc1 -fsyntax-only hello.c')).toEqual({ status: 0, output: '' });
  }
}, 120_000);
