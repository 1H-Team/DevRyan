import { execFile, execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import express from 'express';
import request from '../../test-supertest.js';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const accounts = vi.hoisted(() => new Map());

vi.mock('../github/auth.js', () => ({
  getGitHubAuthById: (accountId) => accounts.get(accountId) || null,
}));

import { runWithRequestPrincipal } from '../multi-user/request-context.js';
import { startHttpsHosts } from '../git/test-https-hosts.js';
import { registerFsRoutes } from './routes.js';
// service.js fixes the working directory of its global-config reads when it
// loads; loaded here, before any test stubs HOME (see routes.clone-identity.test.js).
import '../git/index.js';

const execFileAsync = promisify(execFile);

// The host owner's credential, as a configured helper or askpass would supply it.
const HOST_OWNER = { username: 'host-owner', password: 'host-owner-token' };
const PRINCIPAL_TOKEN = 'principal-token';

let dataDirectory;
let realGit;
let root;
let sources;
let destination;
let remote;
let spawnGit;

const git = (directory, args) => execFileAsync(realGit, ['-C', directory, ...args], { encoding: 'utf8' });

beforeAll(async () => {
  realGit = execFileSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).trim();
  // The askpass helper is created once per process, so one data root serves the file.
  dataDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'devryan-clone-credentials-data-'));
});

afterAll(async () => {
  await fs.rm(dataDirectory, { recursive: true, force: true });
});

beforeEach(async () => {
  accounts.clear();
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'devryan-clone-credentials-'));
  sources = path.join(root, 'credential-sources.log');
  destination = path.join(root, 'clones', 'repository');
  const home = path.join(root, 'home');
  await fs.mkdir(home);
  // Git reads only this file's global configuration, never the user's own.
  vi.stubEnv('HOME', home);
  vi.stubEnv('XDG_CONFIG_HOME', path.join(home, '.config'));
  vi.stubEnv('GIT_CONFIG_NOSYSTEM', '1');
  for (const name of [
    'GIT_CONFIG_GLOBAL', 'GIT_CONFIG_SYSTEM', 'GIT_CONFIG_COUNT', 'GIT_CONFIG_PARAMETERS',
    'GIT_ASKPASS', 'SSH_ASKPASS', 'DEVRYAN_GIT_ASKPASS_TOKEN', 'GIT_DIR', 'GIT_WORK_TREE',
    // The remotes' hosts are routed to a local proxy by Git configuration alone.
    'HTTP_PROXY', 'http_proxy', 'HTTPS_PROXY', 'https_proxy', 'ALL_PROXY', 'all_proxy', 'NO_PROXY', 'no_proxy',
  ]) vi.stubEnv(name, undefined);
  // A clone that runs out of credential sources must fail, never wait on the
  // terminal running the tests.
  vi.stubEnv('GIT_TERMINAL_PROMPT', '0');
  // With an agent socket set, buildGitEnv never probes gpg-agent.
  vi.stubEnv('SSH_AUTH_SOCK', path.join(root, 'agent.sock'));
  vi.stubEnv('DEVRYAN_DATA_DIR', dataDirectory);
  remote = await startRemote();
  spawnGit = vi.fn(spawn);
});

afterEach(async () => {
  await remote?.close();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  await fs.rm(root, { recursive: true, force: true });
});

// A private GitHub repository at https://github.com, served by `git
// http-backend` and holding one commit on main, and the same repository at
// https://git.example.test, a host that is not GitHub. Each host accepts the
// host owner's credential and the principal's token, counts its requests and
// records which credential authenticated each one. github.com redirects
// `owner/moved.git` to the repository on git.example.test.
const startRemote = async () => {
  const projectRoot = path.join(root, 'served');
  const bare = path.join(projectRoot, 'owner', 'repository.git');
  const seed = path.join(root, 'seed');
  await fs.mkdir(path.dirname(bare), { recursive: true });
  await execFileAsync(realGit, ['init', '-q', '--bare', '-b', 'main', bare]);
  await execFileAsync(realGit, ['init', '-q', '-b', 'main', seed]);
  await git(seed, ['-c', 'user.name=Seed', '-c', 'user.email=seed@example.test', 'commit', '-q', '--allow-empty', '-m', 'initial']);
  await git(seed, ['push', '-q', bare, 'main']);
  const head = (await git(seed, ['rev-parse', 'HEAD'])).stdout.trim();
  const credentials = new Map([
    [`${HOST_OWNER.username}:${HOST_OWNER.password}`, 'host-owner'],
    [`x-access-token:${PRINCIPAL_TOKEN}`, 'principal'],
  ]);
  const host = (record, redirects = {}) => (incoming, response) => {
    record.requests += 1;
    const moved = Object.entries(redirects).find(([prefix]) => incoming.url.startsWith(prefix));
    if (moved) {
      response.writeHead(301, { Location: `${moved[1]}${incoming.url.slice(moved[0].length)}` }).end();
      return;
    }
    const basic = /^Basic (.+)$/.exec(incoming.headers.authorization || '');
    const identity = basic ? credentials.get(Buffer.from(basic[1], 'base64').toString('utf8')) || 'rejected' : null;
    if (identity) record.authenticated.push(identity);
    if (!identity || identity === 'rejected') {
      response.writeHead(401, { 'WWW-Authenticate': 'Basic realm="devryan-test"' }).end();
      return;
    }
    serveGit(incoming, response, projectRoot, identity);
  };
  const github = { url: 'https://github.com/owner/repository.git', requests: 0, authenticated: [] };
  const elsewhere = { url: 'https://git.example.test/owner/repository.git', requests: 0, authenticated: [] };
  const hosts = await startHttpsHosts({
    'github.com': host(github, { '/owner/moved.git/': 'https://git.example.test/owner/repository.git/' }),
    'git.example.test': host(elsewhere),
  });
  await fs.mkdir(path.join(process.env.XDG_CONFIG_HOME, 'git'), { recursive: true });
  await fs.writeFile(path.join(process.env.XDG_CONFIG_HOME, 'git', 'config'), `${hosts.gitConfig.join('\n')}\n`);
  return Object.assign(github, { head, elsewhere, close: hosts.close });
};

const serveGit = (incoming, response, projectRoot, identity) => {
  const url = new URL(incoming.url, 'http://127.0.0.1');
  const backend = spawn(realGit, ['http-backend'], {
    env: {
      PATH: process.env.PATH,
      HOME: path.join(root, 'server-home'),
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_PROJECT_ROOT: projectRoot,
      GIT_HTTP_EXPORT_ALL: '1',
      PATH_INFO: url.pathname,
      QUERY_STRING: url.search.slice(1),
      REQUEST_METHOD: incoming.method,
      CONTENT_TYPE: incoming.headers['content-type'] || '',
      REMOTE_USER: identity,
      REMOTE_ADDR: '127.0.0.1',
      ...(incoming.headers['content-encoding'] ? { HTTP_CONTENT_ENCODING: incoming.headers['content-encoding'] } : {}),
      ...(incoming.headers['git-protocol'] ? { GIT_PROTOCOL: incoming.headers['git-protocol'] } : {}),
    },
  });
  incoming.pipe(backend.stdin);
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

// Every credential source records itself in one log; no credential value is written.
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
  'cat >/dev/null',
  `printf 'helper %s %s\\n' "$1" "$2" >> '${sources}'`,
  ...(answers ? [`[ "$2" = get ] && printf 'username=${HOST_OWNER.username}\\npassword=${HOST_OWNER.password}\\n'`] : []),
  'exit 0',
]);

// An askpass program such as VS Code's, answering with the host owner's credential.
const hostAskPass = (label) => writeScript(`host-${label}`, [
  `printf '${label}\\n' >> '${sources}'`,
  `case "$1" in *[Uu]sername*) echo '${HOST_OWNER.username}' ;; *) echo '${HOST_OWNER.password}' ;; esac`,
]);

const writeGlobalConfig = (lines) => fs.writeFile(path.join(process.env.HOME, '.gitconfig'), `${lines.join('\n')}\n`);

// Only administrators reach the route: authorizeManagedRequest refuses other managed roles.
const managedAdmin = (githubAccountId) => ({
  id: `managed-admin-${githubAccountId || 'unconnected'}`,
  email: 'managed-admin@example.test',
  displayName: 'managed-admin',
  role: 'admin',
  scope: 'managed',
  githubAccountId,
  assignments: [],
});

// The host owner, signed in to the multi-user runtime.
const LOCAL_ADMIN = { id: 'local-admin', role: 'admin', scope: 'local-admin', assignments: [] };

const connectPrincipalAccount = () => accounts.set('account-principal', {
  accessToken: PRINCIPAL_TOKEN,
  user: { login: 'principal-user', id: 909, name: 'principal-user Name', email: 'principal-user@example.test' },
});

const augmentedPathEntry = () => path.join(root, 'augmented-bin');

const clone = (principal, remoteUrl = remote.url) => {
  const app = express();
  app.use(express.json());
  // As the multi-user middleware runs every authorized request.
  if (principal) app.use((_request, _response, next) => runWithRequestPrincipal(principal, next));
  registerFsRoutes(app, {
    os,
    path,
    fsPromises: fs,
    spawn: spawnGit,
    crypto: { randomUUID: () => 'clone-credentials-job' },
    normalizeDirectoryPath: (value) => value,
    resolveProjectDirectory: async () => ({ directory: root }),
    buildAugmentedPath: (value) => [augmentedPathEntry(), value].join(path.delimiter),
    resolveGitBinaryForSpawn: () => realGit,
    devryanUserConfigRoot: path.join(root, 'config'),
  });
  return request(app)
    .post('/api/fs/clone')
    .send({ remoteUrl, destinationPath: destination });
};

const expectCloned = async (response) => {
  expect(response.body).toEqual({ success: true, path: destination, output: expect.any(String) });
  expect((await git(destination, ['rev-parse', 'HEAD'])).stdout.trim()).toBe(remote.head);
};

describe.skipIf(process.platform === 'win32')('POST /api/fs/clone credential sources', () => {
  it.each([
    ["the host owner's credential", true],
    ['no credential', false],
  ])("clones for a managed user with only the principal's token while the host's helpers hold %s", async (_, answers) => {
    const helper = await hostCredentialHelper(answers);
    await writeGlobalConfig([
      '[credential]', `\thelper = ${helper} global`,
      `[credential "${new URL(remote.url).origin}"]`, `\thelper = ${helper} url-scoped`,
    ]);
    connectPrincipalAccount();

    await expectCloned(await clone(managedAdmin('account-principal')).expect(200));

    expect(new Set(remote.authenticated)).toEqual(new Set(['principal']));
    // Never asked, and never handed the principal's token to store.
    expect(await consulted()).toEqual([]);
    expect(spawnGit.mock.calls[0][2].env.PATH.split(path.delimiter)[0]).toBe(augmentedPathEntry());
  });

  it("keeps the principal's token from a managed clone of a host that is not github.com", async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const helper = await hostCredentialHelper(true);
    await writeGlobalConfig([
      '[credential]', `\thelper = ${helper} global`,
      `[credential "${new URL(remote.elsewhere.url).origin}"]`, `\thelper = ${helper} url-scoped`,
    ]);
    connectPrincipalAccount();

    const response = await clone(managedAdmin('account-principal'), remote.elsewhere.url).expect(500);

    expect(response.body.error).toContain('unable to read askpass response');
    expect(response.body.error).toContain("could not read Username for 'https://git.example.test'");
    // Git asked the host and then sent no credential at all: neither the
    // token nor the host owner's.
    expect(remote.elsewhere.requests).toBeGreaterThan(0);
    expect(remote.elsewhere.authenticated).toEqual([]);
    expect(await consulted()).toEqual([]);
  });

  it("keeps the principal's token from a managed clone that github.com redirects to another host", async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    connectPrincipalAccount();

    const response = await clone(managedAdmin('account-principal'), 'https://github.com/owner/moved.git').expect(500);

    // Git follows the redirect and asks for the credential of the host it lands on.
    expect(response.body.error).toContain("could not read Username for 'https://git.example.test'");
    expect(remote.requests).toBeGreaterThan(0);
    expect(remote.elsewhere.requests).toBeGreaterThan(0);
    expect(remote.authenticated).toEqual([]);
    expect(remote.elsewhere.authenticated).toEqual([]);
  });

  it.each([
    ['a credential helper', async () => writeGlobalConfig(['[credential]', `\thelper = ${await hostCredentialHelper(true)} global`])],
    ['an inherited GIT_ASKPASS', async () => vi.stubEnv('GIT_ASKPASS', await hostAskPass('GIT_ASKPASS'))],
    ['an inherited SSH_ASKPASS', async () => vi.stubEnv('SSH_ASKPASS', await hostAskPass('SSH_ASKPASS'))],
    ['core.askPass', async () => writeGlobalConfig(['[core]', `\taskPass = ${await hostAskPass('core.askPass')}`])],
  ])('keeps a managed user without a connected account from cloning through %s', async (_, configure) => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    await configure();

    const response = await clone(managedAdmin(null)).expect(500);

    expect(response.body.error).toContain('could not read Username');
    expect(remote.authenticated).toEqual([]);
    expect(await consulted()).toEqual([]);
  });

  it.each([
    ['without a request principal', null],
    ['for the local administrator', LOCAL_ADMIN],
  ])("leaves an unmanaged clone with the host's credential helper and inherited askpass, %s", async (_, principal) => {
    // A connected account never gives an unmanaged clone a token.
    connectPrincipalAccount();
    await writeGlobalConfig(['[credential]', `\thelper = ${await hostCredentialHelper(true)} global`]);

    await expectCloned(await clone(principal).expect(200));
    expect(new Set(remote.authenticated)).toEqual(new Set(['host-owner']));
    expect(await consulted()).toContain('helper global get');

    await fs.rm(destination, { recursive: true, force: true });
    await writeGlobalConfig([]);
    vi.stubEnv('GIT_ASKPASS', await hostAskPass('GIT_ASKPASS'));
    remote.authenticated.length = 0;

    await expectCloned(await clone(principal).expect(200));
    expect(new Set(remote.authenticated)).toEqual(new Set(['host-owner']));
    expect(await consulted()).toContain('GIT_ASKPASS');
  });
});
