import { execFile, execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import { createRequire } from 'node:module';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { formatWithOptions, promisify } from 'node:util';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const accounts = vi.hoisted(() => new Map());

vi.mock('../github/auth.js', () => ({
  getGitHubAuthById: (accountId) => accounts.get(accountId) || null,
}));

import { runWithRequestPrincipal } from '../multi-user/request-context.js';
import { buildGitEnv, commit, continueMerge, continueRebase, getStatus, push, rebase } from './service.js';

const execFileAsync = promisify(execFile);

// Variables the wrapper records by value. Credential values are never written:
// the wrapper records only a checksum of the askpass token, or `unset`.
const RECORDED = [
  'GIT_OPTIONAL_LOCKS', 'GIT_AUTHOR_NAME', 'GIT_AUTHOR_EMAIL', 'GIT_COMMITTER_NAME', 'GIT_COMMITTER_EMAIL',
  'GIT_ASKPASS', 'GIT_TERMINAL_PROMPT', 'GIT_EDITOR', 'SSH_AUTH_SOCK', 'HOME',
  'EDITOR', 'PAGER', 'GIT_SSH_COMMAND', 'GIT_CONFIG_GLOBAL',
];

let dataDirectory;
let realGit;
let root;
let log;

beforeAll(async () => {
  realGit = execFileSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).trim();
  // The askpass helper is created once per process, so one data root serves the file.
  dataDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'devryan-git-env-data-'));
});

afterAll(async () => {
  await fs.rm(dataDirectory, { recursive: true, force: true });
});

// A `git` wrapper first on PATH records the environment of every Git child the
// service starts, then runs the real Git.
beforeEach(async () => {
  accounts.clear();
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'devryan-git-env-'));
  log = path.join(root, 'git-env.log');
  const bin = path.join(root, 'bin');
  const home = path.join(root, 'home');
  await fs.mkdir(bin);
  await fs.mkdir(home);
  await fs.writeFile(path.join(bin, 'git'), [
    '#!/bin/sh',
    `vars=$(env | grep -E '^(${RECORDED.join('|')})=' | tr '\\n' '\\t')`,
    'token=unset',
    'if [ -n "${DEVRYAN_GIT_ASKPASS_TOKEN+x}" ]; then token=$(printf \'%s\' "$DEVRYAN_GIT_ASKPASS_TOKEN" | cksum | cut -d\' \' -f1); fi',
    `printf 'args=%s\\t%stoken=%s\\n' "$*" "$vars" "$token" >> '${log}'`,
    `exec '${realGit}' "$@"`,
    '',
  ].join('\n'), { mode: 0o755 });
  vi.stubEnv('PATH', `${bin}${path.delimiter}${process.env.PATH}`);
  // Editor and askpass settings come from each test, never from the runner's
  // environment (Claude Code sets GIT_EDITOR, VS Code terminals GIT_ASKPASS).
  for (const name of ['EDITOR', 'VISUAL', 'GIT_EDITOR', 'GIT_SEQUENCE_EDITOR', 'GIT_ASKPASS', 'SSH_ASKPASS']) {
    vi.stubEnv(name, undefined);
  }
  // Never read the user's global Git configuration, signing or hooks.
  vi.stubEnv('HOME', home);
  vi.stubEnv('GIT_CONFIG_NOSYSTEM', '1');
  vi.stubEnv('SSH_AUTH_SOCK', path.join(root, 'inherited-agent.sock'));
  vi.stubEnv('DEVRYAN_DATA_DIR', dataDirectory);
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await fs.rm(root, { recursive: true, force: true });
});

const gitCalls = async () => {
  const text = await fs.readFile(log, 'utf8').catch(() => '');
  return text.split('\n').filter(Boolean).map((line) => {
    const [args, ...entries] = line.split('\t').filter(Boolean);
    const env = Object.fromEntries(entries.map((entry) => {
      const separator = entry.indexOf('=');
      return [entry.slice(0, separator), entry.slice(separator + 1)];
    }));
    return { args: args.slice('args='.length), env };
  });
};

const callsMatching = async (pattern) => (await gitCalls()).filter((call) => pattern.test(call.args));

const checksum = (value) => execFileSync('sh', ['-c', 'printf \'%s\' "$1" | cksum | cut -d\' \' -f1', 'sh', value], {
  encoding: 'utf8',
}).trim();

const git = (directory, args) => execFileAsync(realGit, ['-C', directory, ...args], { encoding: 'utf8' });

const createRepository = async (name = 'repository') => {
  const directory = path.join(root, name);
  await fs.mkdir(directory);
  await git(directory, ['init', '-q', '-b', 'main']);
  await git(directory, ['config', 'user.name', 'Repository Config']);
  await git(directory, ['config', 'user.email', 'repository@example.test']);
  await fs.writeFile(path.join(directory, 'README.md'), 'initial\n');
  await git(directory, ['add', 'README.md']);
  await git(directory, ['commit', '-q', '-m', 'initial']);
  await git(directory, ['checkout', '-q', '-b', 'developer']);
  return directory;
};

// `developer` and `main` both change README.md after the initial commit.
const createDivergedRepository = async () => {
  const directory = await createRepository();
  await git(directory, ['checkout', '-q', 'main']);
  await fs.writeFile(path.join(directory, 'README.md'), 'main\n');
  await git(directory, ['commit', '-q', '-am', 'main']);
  await git(directory, ['checkout', '-q', 'developer']);
  await fs.writeFile(path.join(directory, 'README.md'), 'developer\n');
  await git(directory, ['commit', '-q', '-am', 'developer']);
  return directory;
};

const addBareOrigin = async (directory, name = 'remote.git') => {
  const remote = path.join(root, name);
  await execFileAsync(realGit, ['init', '-q', '--bare', remote]);
  await git(directory, ['remote', 'add', 'origin', remote]);
  return remote;
};

const account = (login, id, token) => ({
  accessToken: token,
  user: { login, id, name: `${login} Name`, email: `${login}@example.test` },
});

const managedPrincipal = (directory, githubAccountId, remoteUrl = null) => ({
  id: `managed-${githubAccountId}`,
  email: 'managed-user@example.test',
  displayName: 'managed-user',
  role: 'developer',
  scope: 'managed',
  githubAccountId,
  assignments: [{
    projectId: 'project-1',
    repositoryPath: directory,
    publicDirectory: directory,
    worktreeContainerPath: path.join(root, 'worktrees'),
    branchName: 'developer',
    githubAccountId,
    remoteUrl,
  }],
});

// simple-git logs through its own copy of `debug`; enabling it at runtime
// captures exactly what DEBUG=simple-git* would print.
const captureSimpleGitDebug = async (operation) => {
  const requireFromSimpleGit = createRequire(createRequire(import.meta.url).resolve('simple-git'));
  const debug = requireFromSimpleGit('debug');
  const lines = [];
  const { log: previousLog } = debug;
  const previousNamespaces = debug.disable();
  debug.log = (...args) => { lines.push(formatWithOptions({ colors: false }, ...args)); };
  debug.enable('simple-git*');
  try {
    await operation();
  } finally {
    debug.disable();
    if (previousNamespaces) debug.enable(previousNamespaces);
    debug.log = previousLog;
  }
  return lines.join('\n');
};

describe.skipIf(process.platform === 'win32')('Git child environment', () => {
  it('runs status reads with optional locks disabled', async () => {
    const directory = await createRepository();

    await getStatus(directory);

    const [status] = await callsMatching(/(^| )status( |$)/);
    expect(status.env.GIT_OPTIONAL_LOCKS).toBe('0');
  });

  it("authors and commits a managed user's work as their GitHub identity, without credentials", async () => {
    const directory = await createRepository();
    accounts.set('account-author', account('author-user', 505, 'author-token'));
    await fs.writeFile(path.join(directory, 'CHANGE.md'), 'managed change\n');

    await expect(runWithRequestPrincipal(managedPrincipal(directory, 'account-author'), () => (
      commit(directory, 'managed commit', { addAll: true })
    ))).resolves.toMatchObject({ success: true });

    const [commitCall] = await callsMatching(/(^| )commit( |$)/);
    expect(commitCall.env).toMatchObject({
      GIT_AUTHOR_NAME: 'author-user Name',
      GIT_AUTHOR_EMAIL: 'author-user@example.test',
      GIT_COMMITTER_NAME: 'author-user Name',
      GIT_COMMITTER_EMAIL: 'author-user@example.test',
    });
    expect(commitCall.env.GIT_OPTIONAL_LOCKS).toBeUndefined();
    expect(commitCall.env.token).toBe('unset');
    const { stdout } = await git(directory, ['log', '-1', '--format=%an <%ae>%n%cn <%ce>']);
    expect(stdout.trim().split('\n')).toEqual([
      'author-user Name <author-user@example.test>',
      'author-user Name <author-user@example.test>',
    ]);
  });

  it("hands a managed push its own account's token through the askpass helper", async () => {
    const directory = await createRepository();
    const remote = await addBareOrigin(directory);
    accounts.set('account-push', account('push-user', 606, 'push-token'));
    const { GIT_ASKPASS: helper } = await runWithRequestPrincipal(managedPrincipal(directory, 'account-push', remote), () => (
      buildGitEnv(directory, { includeCredentials: true })
    ));

    await expect(runWithRequestPrincipal(managedPrincipal(directory, 'account-push', remote), () => push(directory)))
      .resolves.toMatchObject({ success: true, ref: 'developer' });

    const [pushCall] = await callsMatching(/(^| )push( |$)/);
    expect(pushCall.env).toMatchObject({ GIT_ASKPASS: helper, GIT_TERMINAL_PROMPT: '0', token: checksum('push-token') });
  });

  it('gives concurrent managed pushes only their own principal’s token', async () => {
    const first = await createRepository('first');
    const second = await createRepository('second');
    const firstRemote = await addBareOrigin(first, 'first.git');
    const secondRemote = await addBareOrigin(second, 'second.git');
    accounts.set('account-first', account('first-user', 101, 'token-first'));
    accounts.set('account-second', account('second-user', 202, 'token-second'));

    await Promise.all([
      runWithRequestPrincipal(managedPrincipal(first, 'account-first', firstRemote), () => push(first)),
      runWithRequestPrincipal(managedPrincipal(second, 'account-second', secondRemote), () => push(second)),
    ]);

    const pushes = await callsMatching(/(^| )push( |$)/);
    expect(pushes.find((call) => call.args.includes(firstRemote))?.env.token).toBe(checksum('token-first'));
    expect(pushes.find((call) => call.args.includes(secondRemote))?.env.token).toBe(checksum('token-second'));
  });

  it('never hands a DevRyan token to unmanaged Git, even with a connected GitHub account', async () => {
    const directory = await createRepository();
    await addBareOrigin(directory);
    accounts.set('account-local', account('local-user', 707, 'local-token'));

    await expect(push(directory)).resolves.toMatchObject({ success: true });

    const calls = await gitCalls();
    expect(calls.length).toBeGreaterThan(0);
    for (const call of calls) {
      expect(call.env.token).toBe('unset');
      expect(call.env.GIT_ASKPASS).toBeUndefined();
    }
  });

  it('never passes an askpass token inherited from the server environment to Git', async () => {
    const directory = await createRepository();
    vi.stubEnv('DEVRYAN_GIT_ASKPASS_TOKEN', 'inherited-token');

    await getStatus(directory);
    await fs.writeFile(path.join(directory, 'CHANGE.md'), 'local change\n');
    await commit(directory, 'local commit', { addAll: true });

    const calls = await gitCalls();
    expect(calls.length).toBeGreaterThan(0);
    for (const call of calls) expect(call.env.token).toBe('unset');
  });

  it('gives Git the gpg-agent SSH socket when the server has no SSH agent', async () => {
    const directory = await createRepository();
    const socketPath = path.join(process.env.HOME, '.gnupg', 'S.gpg-agent.ssh');
    await fs.mkdir(path.dirname(socketPath), { mode: 0o700 });
    const agent = net.createServer();
    await new Promise((resolve) => agent.listen(socketPath, resolve));
    vi.stubEnv('SSH_AUTH_SOCK', '');

    try {
      await getStatus(directory);
    } finally {
      await new Promise((resolve) => agent.close(resolve));
    }

    const [status] = await callsMatching(/(^| )status( |$)/);
    expect(status.env.SSH_AUTH_SOCK).toBe(socketPath);
  });

  it('keeps passing inherited variables that simple-git screens', async () => {
    const directory = await createRepository();
    const globalConfig = path.join(root, 'global.gitconfig');
    await fs.writeFile(globalConfig, '');
    const { stdout: execPath } = await execFileAsync(realGit, ['--exec-path'], { encoding: 'utf8' });
    const screened = {
      EDITOR: 'true', GIT_EDITOR: 'true', GIT_SEQUENCE_EDITOR: 'true',
      GIT_ASKPASS: 'false', SSH_ASKPASS: 'false',
      GIT_CONFIG: path.join(directory, '.git', 'config'), GIT_CONFIG_GLOBAL: globalConfig, GIT_CONFIG_SYSTEM: os.devNull,
      GIT_EXEC_PATH: execPath.trim(), PREFIX: path.join(root, 'prefix'),
      GIT_CONFIG_COUNT: '0', GIT_EXTERNAL_DIFF: 'false', GIT_PAGER: 'cat', PAGER: 'cat',
      GIT_PROXY_COMMAND: 'false', GIT_TEMPLATE_DIR: path.join(root, 'templates'),
      GIT_SSH: 'ssh', GIT_SSH_COMMAND: 'ssh -o BatchMode=yes',
    };
    for (const [name, value] of Object.entries(screened)) vi.stubEnv(name, value);

    await getStatus(directory);
    await fs.writeFile(path.join(directory, 'CHANGE.md'), 'local change\n');
    await expect(commit(directory, 'local commit', { addAll: true })).resolves.toMatchObject({ success: true });

    const [status] = await callsMatching(/(^| )status( |$)/);
    expect(status.env).toMatchObject({
      EDITOR: 'true', PAGER: 'cat', GIT_SSH_COMMAND: 'ssh -o BatchMode=yes', GIT_CONFIG_GLOBAL: globalConfig,
    });
  });

  it('continues a rebase with the server environment and a non-interactive editor', async () => {
    const directory = await createDivergedRepository();
    await expect(rebase(directory, { onto: 'main' })).resolves.toMatchObject({ conflict: true });
    await fs.writeFile(path.join(directory, 'README.md'), 'main and developer\n');
    await git(directory, ['add', 'README.md']);

    await expect(continueRebase(directory)).resolves.toEqual({ success: true, conflict: false });

    const [continued] = await callsMatching(/(^| )rebase --continue( |$)/);
    expect(continued?.env).toMatchObject({ GIT_EDITOR: 'true', HOME: process.env.HOME, SSH_AUTH_SOCK: process.env.SSH_AUTH_SOCK });
  });

  it('continues a merge with its default message once conflicts are resolved', async () => {
    const directory = await createDivergedRepository();
    await expect(git(directory, ['merge', 'main'])).rejects.toBeDefined();
    await fs.writeFile(path.join(directory, 'README.md'), 'main and developer\n');
    await git(directory, ['add', 'README.md']);

    await expect(continueMerge(directory)).resolves.toEqual({ success: true, conflict: false });

    const { stdout } = await git(directory, ['log', '-1', '--format=%P%n%s']);
    const [parents, subject] = stdout.trim().split('\n');
    expect(parents.split(' ')).toHaveLength(2);
    expect(subject).toBe("Merge branch 'main' into developer");
    const [committed] = await callsMatching(/(^| )commit( |$)/);
    expect(committed?.env).toMatchObject({ GIT_EDITOR: 'true', HOME: process.env.HOME });
  });

  it('keeps the askpass token out of simple-git debug output', async () => {
    const directory = await createRepository();
    const remote = await addBareOrigin(directory);
    accounts.set('account-debug', account('debug-user', 808, 'debug-token'));

    const output = await captureSimpleGitDebug(() => (
      runWithRequestPrincipal(managedPrincipal(directory, 'account-debug', remote), () => push(directory))
    ));

    expect(output).toContain('[Git environment: ');
    expect(output).toContain('DEVRYAN_GIT_ASKPASS_TOKEN');
    expect(output).not.toContain('debug-token');
    const [pushCall] = await callsMatching(/(^| )push( |$)/);
    expect(pushCall.env.token).toBe(checksum('debug-token'));
  });
});
