import { execFile, execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const accounts = vi.hoisted(() => new Map());

vi.mock('../github/auth.js', () => ({
  getGitHubAuthById: (accountId) => accounts.get(accountId) || null,
}));

import { runWithRequestPrincipal } from '../multi-user/request-context.js';
import { integrateCommits } from './integrate.js';
import {
  buildGitEnv, fetch as fetchRemote, getBranches, pull, push, runGitCommand, validateWorktreeCreate,
} from './service.js';
import { startHttpsHosts } from './test-https-hosts.js';

const execFileAsync = promisify(execFile);

// The host owner's credential, as a configured helper or askpass would supply it.
const HOST_OWNER = { username: 'host-owner', password: 'host-owner-token' };
const PRINCIPAL_TOKEN = 'principal-token';

let dataDirectory;
let realGit;
let root;
let sources;
let remote;

beforeAll(async () => {
  realGit = execFileSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).trim();
  // The askpass helper is created once per process, so one data root serves the file.
  dataDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'devryan-git-credentials-data-'));
});

afterAll(async () => {
  await fs.rm(dataDirectory, { recursive: true, force: true });
});

beforeEach(async () => {
  accounts.clear();
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'devryan-git-credentials-'));
  sources = path.join(root, 'credential-sources.log');
  const home = path.join(root, 'home');
  await fs.mkdir(home);
  // Git reads only this file's global configuration, never the user's own.
  vi.stubEnv('HOME', home);
  vi.stubEnv('XDG_CONFIG_HOME', path.join(home, '.config'));
  vi.stubEnv('XDG_DATA_HOME', path.join(home, '.local', 'share'));
  vi.stubEnv('GIT_CONFIG_NOSYSTEM', '1');
  for (const name of [
    'GIT_CONFIG_GLOBAL', 'GIT_CONFIG_SYSTEM', 'GIT_CONFIG_COUNT', 'GIT_CONFIG_PARAMETERS',
    'GIT_ASKPASS', 'SSH_ASKPASS', 'DEVRYAN_GIT_ASKPASS_TOKEN',
    // The remotes' hosts are routed to a local proxy by Git configuration alone.
    'HTTP_PROXY', 'http_proxy', 'HTTPS_PROXY', 'https_proxy', 'ALL_PROXY', 'all_proxy', 'NO_PROXY', 'no_proxy',
  ]) vi.stubEnv(name, undefined);
  // A Git child that runs out of credential sources must fail, never wait on
  // the terminal running the tests.
  vi.stubEnv('GIT_TERMINAL_PROMPT', '0');
  vi.stubEnv('SSH_AUTH_SOCK', path.join(root, 'inherited-agent.sock'));
  vi.stubEnv('DEVRYAN_DATA_DIR', dataDirectory);
  remote = await startRemote();
});

afterEach(async () => {
  await remote?.close();
  vi.unstubAllEnvs();
  await fs.rm(root, { recursive: true, force: true });
});

// A GitHub repository at https://github.com, served by `git http-backend`, and
// the same repository at https://git.example.test, a host that is not GitHub.
// Each host accepts the host owner's credential and the principal's token,
// counts its requests and records which credential authenticated each one.
const startRemote = async () => {
  const projectRoot = path.join(root, 'served');
  const bare = path.join(projectRoot, 'owner', 'repository.git');
  await fs.mkdir(path.dirname(bare), { recursive: true });
  await execFileAsync(realGit, ['init', '-q', '--bare', bare]);
  const credentials = new Map([
    [`${HOST_OWNER.username}:${HOST_OWNER.password}`, 'host-owner'],
    [`x-access-token:${PRINCIPAL_TOKEN}`, 'principal'],
  ]);
  const host = (record) => (request, response) => {
    record.requests += 1;
    const basic = /^Basic (.+)$/.exec(request.headers.authorization || '');
    const identity = basic ? credentials.get(Buffer.from(basic[1], 'base64').toString('utf8')) || 'rejected' : null;
    if (identity) record.authenticated.push(identity);
    if (!identity || identity === 'rejected') {
      response.writeHead(401, { 'WWW-Authenticate': 'Basic realm="devryan-test"' }).end();
      return;
    }
    serveGit(request, response, projectRoot, identity);
  };
  const github = { url: 'https://github.com/owner/repository.git', requests: 0, authenticated: [] };
  const elsewhere = { url: 'https://git.example.test/owner/repository.git', requests: 0, authenticated: [] };
  const hosts = await startHttpsHosts({ 'github.com': host(github), 'git.example.test': host(elsewhere) });
  await fs.mkdir(path.join(process.env.XDG_CONFIG_HOME, 'git'), { recursive: true });
  await fs.writeFile(path.join(process.env.XDG_CONFIG_HOME, 'git', 'config'), `${hosts.gitConfig.join('\n')}\n`);
  return Object.assign(github, { bare, elsewhere, close: hosts.close });
};

const serveGit = (request, response, projectRoot, identity) => {
  const url = new URL(request.url, 'http://127.0.0.1');
  const backend = spawn(realGit, ['http-backend'], {
    env: {
      PATH: process.env.PATH,
      HOME: path.join(root, 'server-home'),
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_PROJECT_ROOT: projectRoot,
      GIT_HTTP_EXPORT_ALL: '1',
      PATH_INFO: url.pathname,
      QUERY_STRING: url.search.slice(1),
      REQUEST_METHOD: request.method,
      CONTENT_TYPE: request.headers['content-type'] || '',
      REMOTE_USER: identity,
      REMOTE_ADDR: '127.0.0.1',
      ...(request.headers['content-encoding'] ? { HTTP_CONTENT_ENCODING: request.headers['content-encoding'] } : {}),
      ...(request.headers['git-protocol'] ? { GIT_PROTOCOL: request.headers['git-protocol'] } : {}),
    },
  });
  request.pipe(backend.stdin);
  backend.stderr.resume();
  let head = Buffer.alloc(0);
  let started = false;
  backend.stdout.on('data', (chunk) => {
    if (started) {
      response.write(chunk);
      return;
    }
    head = Buffer.concat([head, chunk]);
    const end = head.indexOf('\r\n\r\n');
    if (end < 0) return;
    started = true;
    let status = 200;
    const headers = {};
    for (const line of head.subarray(0, end).toString('latin1').split('\r\n')) {
      const separator = line.indexOf(':');
      const name = line.slice(0, separator).trim();
      const value = line.slice(separator + 1).trim();
      if (name.toLowerCase() === 'status') status = Number.parseInt(value, 10);
      else headers[name] = value;
    }
    response.writeHead(status, headers);
    response.write(head.subarray(end + 4));
  });
  backend.stdout.on('end', () => response.end());
};

// Every credential source records itself (and, for a password Git hands it, a
// checksum) in one log; no credential value is written.
const checksum = (value) => execFileSync('sh', ['-c', 'printf \'%s\' "$1" | cksum | cut -d\' \' -f1', 'sh', value], {
  encoding: 'utf8',
}).trim();

const consulted = async () => (await fs.readFile(sources, 'utf8').catch(() => ''))
  .split('\n').filter(Boolean);

const writeScript = async (name, body) => {
  const file = path.join(root, name);
  await fs.writeFile(file, ['#!/bin/sh', ...body, ''].join('\n'), { mode: 0o755 });
  return file;
};

// A credential helper such as osxkeychain or `gh auth git-credential`, run as
// `<helper> <label> get|store|erase`. `answers` decides whether it holds the
// host owner's credential.
const hostCredentialHelper = (answers) => writeScript('host-credential-helper', [
  'input=$(cat)',
  'password=$(printf \'%s\\n\' "$input" | sed -n \'s/^password=//p\')',
  'digest=none',
  '[ -n "$password" ] && digest=$(printf \'%s\' "$password" | cksum | cut -d\' \' -f1)',
  `printf 'helper %s %s %s\\n' "$1" "$2" "$digest" >> '${sources}'`,
  ...(answers ? [`[ "$2" = get ] && printf 'username=${HOST_OWNER.username}\\npassword=${HOST_OWNER.password}\\n'`] : []),
  'exit 0',
]);

// An askpass program such as VS Code's, answering with the host owner's credential.
const hostAskPass = (label) => writeScript(`host-${label}`, [
  `printf '${label}\\n' >> '${sources}'`,
  `case "$1" in *[Uu]sername*) echo '${HOST_OWNER.username}' ;; *) echo '${HOST_OWNER.password}' ;; esac`,
]);

const writeGlobalConfig = (lines) => fs.writeFile(path.join(process.env.HOME, '.gitconfig'), `${lines.join('\n')}\n`);

const git = (directory, args) => execFileAsync(realGit, ['-C', directory, ...args], { encoding: 'utf8' });

// A `developer` checkout whose origin is the remote on github.com, or `originUrl`.
const createRepository = async (originUrl = remote.url) => {
  const directory = path.join(root, 'repository');
  await fs.mkdir(directory);
  await git(directory, ['init', '-q', '-b', 'main']);
  await git(directory, ['config', 'user.name', 'Repository Config']);
  await git(directory, ['config', 'user.email', 'repository@example.test']);
  await fs.writeFile(path.join(directory, 'README.md'), 'initial\n');
  await git(directory, ['add', 'README.md']);
  await git(directory, ['commit', '-q', '-m', 'initial']);
  await git(directory, ['checkout', '-q', '-b', 'developer']);
  await git(directory, ['remote', 'add', 'origin', originUrl]);
  return directory;
};

// Publishes `developer` straight to the bare repository, without HTTP.
const seedRemoteBranch = async (directory) => {
  await git(directory, ['push', '-q', remote.bare, 'developer']);
  await git(directory, ['fetch', '-q', remote.bare, '+refs/heads/developer:refs/remotes/origin/developer']);
};

const managedPrincipal = (directory, githubAccountId, remoteUrl = remote.url) => ({
  id: `managed-${githubAccountId || 'unconnected'}`,
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

const connectPrincipalAccount = () => accounts.set('account-principal', {
  accessToken: PRINCIPAL_TOKEN,
  user: { login: 'principal-user', id: 909, name: 'principal-user Name', email: 'principal-user@example.test' },
});

describe.skipIf(process.platform === 'win32')('Git credential sources', () => {
  it("authenticates every credentialed managed operation with only the principal's token", async () => {
    await writeGlobalConfig([
      '[credential]', `\thelper = ${await hostCredentialHelper(true)} global`,
      `[credential "${new URL(remote.url).origin}"]`, `\thelper = ${await hostCredentialHelper(true)} url-scoped`,
    ]);
    const directory = await createRepository();
    connectPrincipalAccount();
    const asPrincipal = (operation) => runWithRequestPrincipal(managedPrincipal(directory, 'account-principal'), operation);

    await expect(asPrincipal(() => push(directory))).resolves.toMatchObject({ success: true, ref: 'developer' });
    await expect(asPrincipal(() => fetchRemote(directory))).resolves.toEqual({ success: true });
    await expect(asPrincipal(() => pull(directory))).resolves.toMatchObject({ success: true });
    const authenticatedBeforeListing = remote.authenticated.length;
    await expect(asPrincipal(() => getBranches(directory, { remote: 'live' })))
      .resolves.toMatchObject({ all: expect.arrayContaining(['developer', 'remotes/origin/developer']) });
    expect(remote.authenticated.length).toBeGreaterThan(authenticatedBeforeListing);
    // A durable provisioning retry selects the account explicitly, without a request principal.
    await expect(runGitCommand(directory, ['fetch', remote.url, '+refs/heads/developer:refs/remotes/origin/developer'], {
      includeCredentials: true,
      githubAccountId: 'account-principal',
    })).resolves.toMatchObject({ success: true });

    expect(remote.authenticated.length).toBeGreaterThan(0);
    expect(new Set(remote.authenticated)).toEqual(new Set(['principal']));
    expect(await consulted()).toEqual([]);
  });

  it("checks worktree remote refs and reintegrates commits with only the principal's token", async () => {
    await writeGlobalConfig(['[credential]', `\thelper = ${await hostCredentialHelper(true)} global`]);
    const directory = await createRepository();
    await git(directory, ['push', '-q', remote.bare, 'main']);
    await git(directory, ['fetch', '-q', remote.bare, '+refs/heads/main:refs/remotes/origin/main']);
    await git(directory, ['branch', '-q', '--set-upstream-to=origin/main', 'main']);
    await fs.writeFile(path.join(directory, 'FEATURE.md'), 'feature\n');
    await git(directory, ['add', 'FEATURE.md']);
    await git(directory, ['commit', '-q', '-m', 'feature']);
    await seedRemoteBranch(directory);
    connectPrincipalAccount();
    const asPrincipal = (operation) => runWithRequestPrincipal(managedPrincipal(directory, 'account-principal'), operation);

    await expect(asPrincipal(() => validateWorktreeCreate(directory, {
      mode: 'new', branchName: 'feature', startRef: 'origin/developer',
    }))).resolves.toMatchObject({ ok: true, errors: [] });
    await expect(asPrincipal(() => validateWorktreeCreate(directory, {
      mode: 'existing', existingBranch: 'origin/developer', branchName: 'from-remote',
      ensureRemoteName: 'origin', ensureRemoteUrl: remote.url,
    }))).resolves.toMatchObject({ ok: true, errors: [] });
    const authenticatedBeforeIntegration = remote.authenticated.length;
    await expect(asPrincipal(() => integrateCommits(directory, { sourceBranch: 'developer', targetBranch: 'main' })))
      .resolves.toEqual({ kind: 'success', moved: 1 });

    expect(remote.authenticated.length).toBeGreaterThan(authenticatedBeforeIntegration);
    expect(new Set(remote.authenticated)).toEqual(new Set(['principal']));
    expect(await consulted()).toEqual([]);
  });

  it("never hands a managed user's token to the host's credential helpers", async () => {
    await writeGlobalConfig(['[credential]', `\thelper = ${await hostCredentialHelper(false)} global`]);
    const directory = await createRepository();
    connectPrincipalAccount();

    await expect(runWithRequestPrincipal(managedPrincipal(directory, 'account-principal'), () => push(directory)))
      .resolves.toMatchObject({ success: true });

    expect(new Set(remote.authenticated)).toEqual(new Set(['principal']));
    const handedOver = await consulted();
    expect(handedOver).not.toContain(`helper global store ${checksum(PRINCIPAL_TOKEN)}`);
    expect(handedOver).toEqual([]);
  });

  it("keeps the principal's token from a managed remote that is not github.com", async () => {
    const helper = await hostCredentialHelper(true);
    await writeGlobalConfig([
      '[credential]', `\thelper = ${helper} global`,
      `[credential "${new URL(remote.elsewhere.url).origin}"]`, `\thelper = ${helper} url-scoped`,
    ]);
    const directory = await createRepository(remote.elsewhere.url);
    await seedRemoteBranch(directory);
    connectPrincipalAccount();
    const asPrincipal = (operation) => runWithRequestPrincipal(
      managedPrincipal(directory, 'account-principal', remote.elsewhere.url),
      operation,
    );

    // DevRyan's askpass helper refuses the prompt (push reports only that line).
    const refused = 'unable to read askpass response';
    await expect(asPrincipal(() => push(directory))).rejects.toThrow(refused);
    await expect(asPrincipal(() => fetchRemote(directory))).rejects.toThrow(refused);
    await expect(asPrincipal(() => pull(directory))).rejects.toThrow(refused);
    const retry = await runGitCommand(directory, ['fetch', remote.elsewhere.url, '+refs/heads/developer:refs/remotes/origin/developer'], {
      includeCredentials: true,
      githubAccountId: 'account-principal',
    });
    expect(retry.success).toBe(false);

    // Git asked the host and then sent no credential at all: neither the
    // token nor the host owner's.
    expect(remote.elsewhere.requests).toBeGreaterThanOrEqual(4);
    expect(remote.elsewhere.authenticated).toEqual([]);
    expect(await consulted()).toEqual([]);
  });

  it.each([
    ['a credential helper', async () => writeGlobalConfig(['[credential]', `\thelper = ${await hostCredentialHelper(true)} global`])],
    ['an inherited GIT_ASKPASS', async () => vi.stubEnv('GIT_ASKPASS', await hostAskPass('GIT_ASKPASS'))],
    ['an inherited SSH_ASKPASS', async () => vi.stubEnv('SSH_ASKPASS', await hostAskPass('SSH_ASKPASS'))],
    ['core.askPass', async () => writeGlobalConfig(['[core]', `\taskPass = ${await hostAskPass('core.askPass')}`])],
  ])("keeps a managed user without a connected account from authenticating through %s", async (_source, configure) => {
    const directory = await createRepository();
    await seedRemoteBranch(directory);
    await configure();
    const asPrincipal = (operation) => runWithRequestPrincipal(managedPrincipal(directory, null), operation);

    await expect(asPrincipal(() => fetchRemote(directory))).rejects.toThrow();
    await expect(asPrincipal(() => pull(directory))).rejects.toThrow();
    await expect(asPrincipal(() => push(directory))).rejects.toThrow('The assigned GitHub account is not connected on this host');

    expect(remote.authenticated).not.toContain('host-owner');
    expect(await consulted()).toEqual([]);
  });

  it('runs managed Git without terminal prompts or inherited askpass programs, keeping inherited -c settings', async () => {
    const directory = await createRepository();
    vi.stubEnv('GIT_TERMINAL_PROMPT', undefined);
    vi.stubEnv('GIT_ASKPASS', await hostAskPass('GIT_ASKPASS'));
    vi.stubEnv('SSH_ASKPASS', await hostAskPass('SSH_ASKPASS'));
    vi.stubEnv('GIT_CONFIG_PARAMETERS', "'core.quotepath=false'");

    const env = await runWithRequestPrincipal(managedPrincipal(directory, null), () => (
      buildGitEnv(directory, { includeCredentials: true })
    ));

    expect(env.GIT_TERMINAL_PROMPT).toBe('0');
    expect(env.GIT_ASKPASS).toBeUndefined();
    expect(env.SSH_ASKPASS).toBeUndefined();
    const { stdout } = await execFileAsync(realGit, ['-C', directory, 'config', '--get', 'core.quotepath'], { env });
    expect(stdout.trim()).toBe('false');
  });

  it("leaves unmanaged Git with the host's credential helper and inherited askpass", async () => {
    await writeGlobalConfig(['[credential]', `\thelper = ${await hostCredentialHelper(true)} global`]);
    const directory = await createRepository();
    connectPrincipalAccount();

    expect((await buildGitEnv(directory, { includeCredentials: true })).GIT_CONFIG_PARAMETERS).toBeUndefined();
    await expect(push(directory)).resolves.toMatchObject({ success: true });
    expect(new Set(remote.authenticated)).toEqual(new Set(['host-owner']));
    expect(await consulted()).toEqual(expect.arrayContaining(['helper global get none']));

    await writeGlobalConfig([]);
    vi.stubEnv('GIT_ASKPASS', await hostAskPass('GIT_ASKPASS'));
    remote.authenticated.length = 0;
    await expect(fetchRemote(directory)).resolves.toEqual({ success: true });
    expect(new Set(remote.authenticated)).toEqual(new Set(['host-owner']));
    expect(await consulted()).toContain('GIT_ASKPASS');
  });
});
