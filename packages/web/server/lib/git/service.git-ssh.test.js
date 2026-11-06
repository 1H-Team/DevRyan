import { execFile, execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const accounts = vi.hoisted(() => new Map());

vi.mock('../github/auth.js', () => ({
  getGitHubAuthById: (accountId) => accounts.get(accountId) || null,
}));

import { runWithRequestPrincipal } from '../multi-user/request-context.js';
import {
  buildGitEnv, fetch as fetchRemote, getBranches, pull, push, runGitCommand,
} from './service.js';

const execFileAsync = promisify(execFile);

// An SSH origin that no assignment remoteUrl replaces, as for a project whose
// origin is not a github.com URL.
const SSH_ORIGIN = 'git@github.test:org/repository.git';
const SSH_REFUSED = /transport 'ssh' not allowed/;

let dataDirectory;
let realGit;
let root;
let served;
let sshLog;
let hostAgent;
let hostKey;
let gpgAgent;

beforeAll(async () => {
  realGit = execFileSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).trim();
  // The askpass helper is created once per process, so one data root serves the file.
  dataDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'devryan-git-ssh-data-'));
});

afterAll(async () => {
  await fs.rm(dataDirectory, { recursive: true, force: true });
});

beforeEach(async () => {
  accounts.clear();
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'devryan-git-ssh-'));
  const home = path.join(root, 'home');
  const bin = path.join(root, 'bin');
  await fs.mkdir(home);
  await fs.mkdir(bin);
  // Git reads only this file's global configuration, never the user's own.
  vi.stubEnv('HOME', home);
  vi.stubEnv('XDG_CONFIG_HOME', path.join(home, '.config'));
  vi.stubEnv('GIT_CONFIG_NOSYSTEM', '1');
  for (const name of [
    'GIT_CONFIG_GLOBAL', 'GIT_CONFIG_SYSTEM', 'GIT_CONFIG_COUNT', 'GIT_CONFIG_PARAMETERS',
    'GIT_ASKPASS', 'SSH_ASKPASS', 'DEVRYAN_GIT_ASKPASS_TOKEN',
    'GIT_SSH', 'GIT_SSH_COMMAND', 'GIT_SSH_VARIANT', 'GIT_ALLOW_PROTOCOL',
  ]) vi.stubEnv(name, undefined);
  vi.stubEnv('GIT_TERMINAL_PROMPT', '0');
  vi.stubEnv('DEVRYAN_DATA_DIR', dataDirectory);
  // The host owner's SSH credentials: the agent the server inherited, the
  // gpg-agent socket buildGitEnv falls back to without one, and a key file.
  hostAgent = path.join(root, 'host-owner-agent.sock');
  gpgAgent = path.join(home, '.gnupg', 'S.gpg-agent.ssh');
  hostKey = path.join(root, 'host-owner-key');
  vi.stubEnv('SSH_AUTH_SOCK', hostAgent);
  served = path.join(root, 'served');
  await execFileAsync(realGit, ['init', '-q', '--bare', path.join(served, 'org', 'repository.git')]);
  sshLog = path.join(root, 'ssh.log');
  await fs.writeFile(path.join(bin, 'ssh'), fakeSsh(), { mode: 0o755 });
  vi.stubEnv('PATH', `${bin}${path.delimiter}${process.env.PATH}`);
});

let gpgAgentServer = null;

afterEach(async () => {
  if (gpgAgentServer) await new Promise((resolve) => gpgAgentServer.close(resolve));
  gpgAgentServer = null;
  vi.unstubAllEnvs();
  await fs.rm(root, { recursive: true, force: true });
});

// Stands in for ssh and the server behind it. It records the agent socket and
// identity file Git hands it, accepts only the host owner's (as GitHub accepts
// the host owner's key), then serves the repository from `served`. Real ssh
// would also try the host owner's ~/.ssh keys and configuration, which it finds
// through the account's passwd entry, not HOME.
const fakeSsh = () => [
  '#!/bin/sh',
  'agent=${SSH_AUTH_SOCK:-none}',
  'identity=none',
  'while [ $# -gt 0 ]; do',
  '  case "$1" in',
  '    -i) identity=$2; shift 2 ;;',
  '    -o|-p|-l|-F|-J) shift 2 ;;',
  '    -*) shift ;;',
  '    *) break ;;',
  '  esac',
  'done',
  `printf 'agent=%s identity=%s host=%s\\n' "$agent" "$identity" "$1" >> '${sshLog}'`,
  'case "$agent:$identity" in',
  `  '${hostAgent}':*|'${gpgAgent}':*|*:'${hostKey}') ;;`,
  "  *) echo 'Permission denied (publickey).' >&2; exit 255 ;;",
  'esac',
  'shift',
  'eval "set -- $1"',
  `exec '${realGit}' "\${1#git-}" '${served}/'"$2"`,
  '',
].join('\n');

const sshCalls = async () => (await fs.readFile(sshLog, 'utf8').catch(() => ''))
  .split('\n').filter(Boolean);

const git = (directory, args) => execFileAsync(realGit, ['-C', directory, ...args], { encoding: 'utf8' });

const servedBranch = async () => (
  await git(path.join(served, 'org', 'repository.git'), ['rev-parse', 'refs/heads/developer'])
).stdout.trim();

// A `developer` checkout one commit ahead of its SSH origin. The branch is
// published straight to the served repository, without ssh.
const createRepository = async () => {
  const directory = path.join(root, 'repository');
  const bare = path.join(served, 'org', 'repository.git');
  await fs.mkdir(directory);
  await git(directory, ['init', '-q', '-b', 'main']);
  await git(directory, ['config', 'user.name', 'Repository Config']);
  await git(directory, ['config', 'user.email', 'repository@example.test']);
  await fs.writeFile(path.join(directory, 'README.md'), 'initial\n');
  await git(directory, ['add', 'README.md']);
  await git(directory, ['commit', '-q', '-m', 'initial']);
  await git(directory, ['checkout', '-q', '-b', 'developer']);
  await git(directory, ['remote', 'add', 'origin', SSH_ORIGIN]);
  await git(directory, ['push', '-q', bare, 'developer']);
  await git(directory, ['fetch', '-q', bare, '+refs/heads/developer:refs/remotes/origin/developer']);
  await git(directory, ['branch', '-q', '--set-upstream-to=origin/developer']);
  await fs.writeFile(path.join(directory, 'FEATURE.md'), 'feature\n');
  await git(directory, ['add', 'FEATURE.md']);
  await git(directory, ['commit', '-q', '-m', 'feature']);
  return directory;
};

const managedPrincipal = (directory, remoteUrl = null) => ({
  id: 'managed-principal',
  email: 'managed-user@example.test',
  displayName: 'managed-user',
  role: 'developer',
  scope: 'managed',
  githubAccountId: 'account-principal',
  assignments: [{
    projectId: 'project-1',
    repositoryPath: directory,
    publicDirectory: directory,
    worktreeContainerPath: path.join(root, 'worktrees'),
    branchName: 'developer',
    githubAccountId: 'account-principal',
    remoteUrl,
  }],
});

const connectPrincipalAccount = () => accounts.set('account-principal', {
  accessToken: 'principal-token',
  user: { login: 'principal-user', id: 909, name: 'principal-user Name', email: 'principal-user@example.test' },
});

const settle = (operation) => operation().then(
  (value) => ({ value }),
  (error) => ({ error: String(error?.message || error) }),
);

// Every remote operation a managed user can start, plus a durable provisioning
// retry, which selects the account explicitly without a request principal.
const managedRemoteOperations = async (directory, principal, retryUrl = SSH_ORIGIN) => {
  const asPrincipal = (operation) => settle(() => runWithRequestPrincipal(principal, operation));
  return {
    push: await asPrincipal(() => push(directory)),
    fetch: await asPrincipal(() => fetchRemote(directory)),
    pull: await asPrincipal(() => pull(directory)),
    live: await asPrincipal(() => getBranches(directory, { remote: 'live' })),
    retry: await settle(() => runGitCommand(directory, [
      'fetch', retryUrl, '+refs/heads/developer:refs/remotes/origin/developer',
    ], { includeCredentials: true, githubAccountId: 'account-principal' })),
  };
};

const expectSshNeverStarted = async (results, servedBefore) => {
  // ssh never starts, so it is handed neither the host owner's agent nor a key.
  expect(await sshCalls()).toEqual([]);
  expect(await servedBranch()).toBe(servedBefore);
  expect(results.push.error).toMatch(SSH_REFUSED);
  expect(results.fetch.error).toMatch(SSH_REFUSED);
  expect(results.pull.error).toMatch(SSH_REFUSED);
  expect(results.retry.value).toMatchObject({ success: false, stderr: expect.stringMatching(SSH_REFUSED) });
  // A live listing keeps the local remote-tracking refs it could not verify.
  expect(results.live.value?.all).toEqual(expect.arrayContaining(['developer', 'remotes/origin/developer']));
};

describe.skipIf(process.platform === 'win32')('Git SSH credentials', () => {
  it.each([
    ['the agent the server inherited', async () => {}],
    ['the gpg-agent socket buildGitEnv resolves', async () => {
      await fs.mkdir(path.dirname(gpgAgent), { mode: 0o700 });
      gpgAgentServer = net.createServer();
      await new Promise((resolve) => gpgAgentServer.listen(gpgAgent, resolve));
      vi.stubEnv('SSH_AUTH_SOCK', '');
    }],
    ["a local identity profile's key", async (directory) => {
      await git(directory, ['config', 'core.sshCommand', `ssh -i '${hostKey}' -o IdentitiesOnly=yes`]);
      vi.stubEnv('SSH_AUTH_SOCK', path.join(root, 'unknown-agent.sock'));
    }],
    ['an SSH-allowing GIT_ALLOW_PROTOCOL', async () => vi.stubEnv('GIT_ALLOW_PROTOCOL', 'ssh:https:file')],
  ])('never hands managed Git %s', async (_source, configure) => {
    const directory = await createRepository();
    await configure(directory);
    connectPrincipalAccount();
    const servedBefore = await servedBranch();

    const results = await managedRemoteOperations(directory, managedPrincipal(directory));

    await expectSshNeverStarted(results, servedBefore);
  });

  it("keeps the host's URL rewrites from turning a managed HTTPS remote into SSH", async () => {
    const directory = await createRepository();
    await git(directory, ['config', '--global', 'url.git@github.test:.insteadOf', 'https://github.test/']);
    connectPrincipalAccount();
    const servedBefore = await servedBranch();
    const remoteUrl = 'https://github.test/org/repository.git';

    const results = await managedRemoteOperations(directory, managedPrincipal(directory, remoteUrl), remoteUrl);

    await expectSshNeverStarted(results, servedBefore);
  });

  it('keeps the other protocols an inherited GIT_ALLOW_PROTOCOL allows managed Git', async () => {
    const directory = await createRepository();
    vi.stubEnv('GIT_ALLOW_PROTOCOL', 'ssh:https:file');

    const env = await runWithRequestPrincipal(managedPrincipal(directory), () => buildGitEnv(directory));

    expect(env.GIT_ALLOW_PROTOCOL).toBe('https:file');
    expect(env.SSH_AUTH_SOCK).toBe(hostAgent);
  });

  it("leaves unmanaged Git with the host owner's SSH agent", async () => {
    const directory = await createRepository();
    vi.stubEnv('GIT_ALLOW_PROTOCOL', 'ssh:https:file');
    const env = await buildGitEnv(directory, { includeCredentials: true });
    expect(env.GIT_CONFIG_PARAMETERS).toBeUndefined();
    expect(env.GIT_ALLOW_PROTOCOL).toBe('ssh:https:file');
    expect(env.SSH_AUTH_SOCK).toBe(hostAgent);

    await expect(push(directory)).resolves.toMatchObject({ success: true });
    await expect(fetchRemote(directory)).resolves.toEqual({ success: true });
    await expect(pull(directory)).resolves.toMatchObject({ success: true });
    await expect(getBranches(directory, { remote: 'live' }))
      .resolves.toMatchObject({ all: expect.arrayContaining(['developer', 'remotes/origin/developer']) });

    expect(await servedBranch()).toBe((await git(directory, ['rev-parse', 'HEAD'])).stdout.trim());
    const calls = await sshCalls();
    expect(calls.length).toBeGreaterThanOrEqual(4);
    expect(new Set(calls)).toEqual(new Set([`agent=${hostAgent} identity=none host=git@github.test`]));
  });
});
