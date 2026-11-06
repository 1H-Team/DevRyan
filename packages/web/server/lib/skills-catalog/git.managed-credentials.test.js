import { execFile, execFileSync, spawn } from 'node:child_process';
import fsSync from 'node:fs';
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
import { registerSkillRoutes } from '../opencode/skill-routes.js';
import {
  clearCache,
  getCacheKey,
  getCachedScan,
  installSkillsFromRepository,
  parseSkillRepoSource,
  scanSkillsRepository,
  setCachedScan,
} from './index.js';
// service.js fixes the working directory of its global-config reads when it
// loads; loaded here, before any test stubs HOME.
import '../git/index.js';

const execFileAsync = promisify(execFile);

// The host owner's credential, as a configured helper or askpass would supply it.
const HOST_OWNER = { username: 'host-owner', password: 'host-owner-token' };
const PRINCIPAL_TOKEN = 'principal-token';
const SOURCE = 'acme/skills';
const SKILLS = ['alpha', 'beta'];

let dataDirectory;
let realGit;
let root;
let sources;
let sshLog;
let remote;

const git = (directory, args) => execFileAsync(realGit, ['-C', directory, ...args], { encoding: 'utf8' });

beforeAll(async () => {
  realGit = execFileSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).trim();
  // The askpass helper is created once per process, so one data root serves the file.
  dataDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'devryan-skills-credentials-data-'));
});

afterAll(async () => {
  await fs.rm(dataDirectory, { recursive: true, force: true });
});

beforeEach(async () => {
  accounts.clear();
  clearCache();
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'devryan-skills-credentials-'));
  sources = path.join(root, 'credential-sources.log');
  const home = path.join(root, 'home');
  await fs.mkdir(home);
  // Git reads only this file's global configuration, never the user's own.
  vi.stubEnv('HOME', home);
  vi.stubEnv('XDG_CONFIG_HOME', path.join(home, '.config'));
  vi.stubEnv('GIT_CONFIG_NOSYSTEM', '1');
  for (const name of [
    'GIT_CONFIG_GLOBAL', 'GIT_CONFIG_SYSTEM', 'GIT_CONFIG_COUNT', 'GIT_CONFIG_PARAMETERS',
    'GIT_ASKPASS', 'SSH_ASKPASS', 'DEVRYAN_GIT_ASKPASS_TOKEN', 'GIT_DIR', 'GIT_WORK_TREE',
    'GIT_SSH', 'GIT_SSH_COMMAND', 'GIT_ALLOW_PROTOCOL',
    // The remote's host is routed to a local proxy by Git configuration alone.
    'HTTP_PROXY', 'http_proxy', 'HTTPS_PROXY', 'https_proxy', 'ALL_PROXY', 'all_proxy', 'NO_PROXY', 'no_proxy',
  ]) vi.stubEnv(name, undefined);
  // A clone that runs out of credential sources must fail, never wait on the
  // terminal running the tests.
  vi.stubEnv('GIT_TERMINAL_PROMPT', '0');
  // With an agent socket set, buildGitEnv never probes gpg-agent.
  vi.stubEnv('SSH_AUTH_SOCK', path.join(root, 'agent.sock'));
  vi.stubEnv('DEVRYAN_DATA_DIR', dataDirectory);
  // A stand-in ssh first on PATH records every start and fails it.
  const bin = path.join(root, 'bin');
  await fs.mkdir(bin);
  sshLog = path.join(root, 'ssh.log');
  await fs.writeFile(path.join(bin, 'ssh'), `#!/bin/sh\nprintf '%s\\n' "$*" >> '${sshLog}'\nexit 255\n`, { mode: 0o755 });
  vi.stubEnv('PATH', `${bin}${path.delimiter}${process.env.PATH}`);
  remote = await startRemote();
});

afterEach(async () => {
  await remote?.close();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  clearCache();
  await fs.rm(root, { recursive: true, force: true });
});

// A private skills repository at https://github.com/acme/skills.git, served by
// `git http-backend` with skills/alpha and skills/beta. It accepts the host
// owner's credential and the principal's token, counts its requests and
// records which credential authenticated each one. Like GitHub it serves
// partial clones, so a blobless clone fetches blobs again during checkout.
const startRemote = async () => {
  const projectRoot = path.join(root, 'served');
  const bare = path.join(projectRoot, 'acme', 'skills.git');
  const seed = path.join(root, 'seed');
  await fs.mkdir(path.dirname(bare), { recursive: true });
  await execFileAsync(realGit, ['init', '-q', '--bare', '-b', 'main', bare]);
  await git(bare, ['config', 'uploadpack.allowFilter', 'true']);
  await execFileAsync(realGit, ['init', '-q', '-b', 'main', seed]);
  for (const skill of SKILLS) {
    await fs.mkdir(path.join(seed, 'skills', skill), { recursive: true });
    await fs.writeFile(path.join(seed, 'skills', skill, 'SKILL.md'), `---\nname: ${skill}\ndescription: ${skill} skill\n---\nBody\n`);
  }
  await git(seed, ['add', '.']);
  await git(seed, ['-c', 'user.name=Seed', '-c', 'user.email=seed@example.test', 'commit', '-q', '-m', 'skills']);
  await git(seed, ['push', '-q', bare, 'main']);
  const credentials = new Map([
    [`${HOST_OWNER.username}:${HOST_OWNER.password}`, 'host-owner'],
    [`x-access-token:${PRINCIPAL_TOKEN}`, 'principal'],
  ]);
  const github = { requests: 0, authenticated: [] };
  const hosts = await startHttpsHosts({
    'github.com': (incoming, response) => {
      github.requests += 1;
      const basic = /^Basic (.+)$/.exec(incoming.headers.authorization || '');
      const identity = basic ? credentials.get(Buffer.from(basic[1], 'base64').toString('utf8')) || 'rejected' : null;
      if (identity) github.authenticated.push(identity);
      if (!identity || identity === 'rejected') {
        response.writeHead(401, { 'WWW-Authenticate': 'Basic realm="devryan-test"' }).end();
        return;
      }
      serveGit(incoming, response, projectRoot, identity);
    },
  });
  await fs.mkdir(path.join(process.env.XDG_CONFIG_HOME, 'git'), { recursive: true });
  await fs.writeFile(path.join(process.env.XDG_CONFIG_HOME, 'git', 'config'), `${hosts.gitConfig.join('\n')}\n`);
  return Object.assign(github, { url: 'https://github.com/acme/skills.git', close: hosts.close });
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

const sshStarts = async () => (await fs.readFile(sshLog, 'utf8').catch(() => ''))
  .split('\n').filter(Boolean);

const writeScript = async (name, body) => {
  const file = path.join(root, name);
  await fs.writeFile(file, ['#!/bin/sh', ...body, ''].join('\n'), { mode: 0o755 });
  return file;
};

// A credential helper such as osxkeychain or `gh auth git-credential`, run as
// `<helper> <label> get|store|erase`, holding the host owner's credential.
const hostCredentialHelper = () => writeScript('host-credential-helper', [
  'cat >/dev/null',
  `printf 'helper %s %s\\n' "$1" "$2" >> '${sources}'`,
  `[ "$2" = get ] && printf 'username=${HOST_OWNER.username}\\npassword=${HOST_OWNER.password}\\n'`,
  'exit 0',
]);

// An askpass program such as VS Code's, answering with the host owner's credential.
const hostAskPass = (label) => writeScript(`host-${label}`, [
  `printf '${label}\\n' >> '${sources}'`,
  `case "$1" in *[Uu]sername*) echo '${HOST_OWNER.username}' ;; *) echo '${HOST_OWNER.password}' ;; esac`,
]);

const writeGlobalConfig = (lines) => fs.writeFile(path.join(process.env.HOME, '.gitconfig'), `${lines.join('\n')}\n`);

const useHostCredentialHelper = async () => {
  const helper = await hostCredentialHelper();
  await writeGlobalConfig([
    '[credential]', `\thelper = ${helper} global`,
    '[credential "https://github.com"]', `\thelper = ${helper} url-scoped`,
  ]);
};

// Managed administrators reach the catalog routes by default; other managed
// roles need the skills.catalog settings permission (authorizeManagedRequest).
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

const projectDirectory = () => path.join(root, 'project');

// The host's Git identity profiles. The second key path is one the catalog
// refuses to put in a shell command.
const profiles = () => [
  { id: 'deploy-key', name: 'Deploy key', sshKey: path.join(root, 'keys', 'id_ed25519') },
  { id: 'refused-key', name: 'Refused key', sshKey: path.join(root, 'keys', 'id_ed25519;refused') },
];
const PROFILE_OPTIONS = [{ id: 'deploy-key', name: 'Deploy key' }, { id: 'refused-key', name: 'Refused key' }];

// The catalog routes with the real scan, install and cache, and one catalog
// source that names the repository, and `gitIdentityId` when given.
const catalogApp = (principal, { gitIdentityId } = {}) => {
  const app = express();
  app.use(express.json());
  // As the multi-user middleware runs every authorized request.
  if (principal) app.use((_request, _response, next) => runWithRequestPrincipal(principal, next));
  registerSkillRoutes(app, {
    fs: fsSync,
    path,
    os,
    resolveProjectDirectory: async () => ({ directory: projectDirectory() }),
    resolveOptionalProjectDirectory: async () => ({ directory: null }),
    readSettingsFromDisk: async () => ({
      skillCatalogs: [{ id: 'team', label: 'Team skills', source: SOURCE, ...(gitIdentityId ? { gitIdentityId } : {}) }],
    }),
    sanitizeSkillCatalogs: (value) => value,
    sanitizeHiddenSkills: () => [],
    markConfigChange: async () => ({}),
    SKILL_DIR: path.join(root, 'user-skills'),
    getCuratedSkillsSources: () => [],
    getCacheKey,
    getCachedScan,
    setCachedScan,
    parseSkillRepoSource,
    scanSkillsRepository,
    installSkillsFromRepository,
    isClawdHubSource: () => false,
    getProfiles: profiles,
    getProfile: (id) => profiles().find((profile) => profile.id === id) || null,
  });
  return app;
};

// `gitIdentityId` is the request's for scan and install, the stored catalog
// source's for the catalog source listing.
const scan = (principal, { gitIdentityId } = {}) => request(catalogApp(principal))
  .post('/api/config/skills/scan')
  .send({ source: SOURCE, gitIdentityId });
const install = (principal, { gitIdentityId } = {}) => request(catalogApp(principal))
  .post('/api/config/skills/install')
  .send({
    source: SOURCE,
    gitIdentityId,
    scope: 'project',
    targetSource: 'opencode',
    selections: [{ skillDir: 'skills/alpha' }],
  });
const catalogSource = (principal, { gitIdentityId } = {}) => request(catalogApp(principal, { gitIdentityId }))
  .get('/api/config/skills/catalog/source')
  .query({ sourceId: 'team' });

const skillNames = (response) => (response.body.items || []).map((item) => item.skillName);

const expectScanned = (response) => {
  expect(response.body.ok).toBe(true);
  expect(skillNames(response)).toEqual(SKILLS);
};

const expectInstalled = async (response) => {
  expect(response.body).toMatchObject({ ok: true, installed: [{ skillName: 'alpha', scope: 'project', source: 'opencode' }], skipped: [] });
  expect(await fs.readFile(path.join(projectDirectory(), '.opencode', 'skills', 'alpha', 'SKILL.md'), 'utf8'))
    .toContain('description: alpha skill');
};

const ROUTES = [
  ['POST /api/config/skills/scan', scan, 200, expectScanned, 401],
  ['POST /api/config/skills/install', install, 200, expectInstalled, 401],
  ['GET /api/config/skills/catalog/source', catalogSource, 200, expectScanned, 500],
];

describe.skipIf(process.platform === 'win32')('skills catalog Git credential sources', () => {
  it.each(ROUTES)("authenticates a managed user's %s with only the principal's token, never the host's helpers", async (_, call, status, expectDone) => {
    await useHostCredentialHelper();
    connectPrincipalAccount();

    const response = await call(managedAdmin('account-principal'));

    expect(response.status).toBe(status);
    await expectDone(response);
    expect(remote.authenticated.length).toBeGreaterThan(0);
    expect(new Set(remote.authenticated)).toEqual(new Set(['principal']));
    // Never asked, and never handed the principal's token to store.
    expect(await consulted()).toEqual([]);
  });

  it.each(ROUTES)('keeps a managed user without a connected account from authenticating %s through the host helper', async (_, call, _status, _expectDone, failedStatus) => {
    await useHostCredentialHelper();

    const response = await call(managedAdmin(null));

    expect(response.status).toBe(failedStatus);
    expect(response.body.error).toMatchObject({ kind: 'authRequired' });
    expect(remote.requests).toBeGreaterThan(0);
    expect(remote.authenticated).toEqual([]);
    expect(await consulted()).toEqual([]);
    expect(fsSync.existsSync(projectDirectory())).toBe(false);
  });

  it.each([
    ['an inherited GIT_ASKPASS', async () => vi.stubEnv('GIT_ASKPASS', await hostAskPass('GIT_ASKPASS'))],
    ['an inherited SSH_ASKPASS', async () => vi.stubEnv('SSH_ASKPASS', await hostAskPass('SSH_ASKPASS'))],
    ['core.askPass', async () => writeGlobalConfig(['[core]', `\taskPass = ${await hostAskPass('core.askPass')}`])],
  ])('keeps a managed user without a connected account from scanning through %s', async (_, configure) => {
    await configure();

    const response = await scan(managedAdmin(null));

    expect(response.status).toBe(401);
    expect(response.body.error).toMatchObject({ kind: 'authRequired' });
    expect(remote.authenticated).toEqual([]);
    expect(await consulted()).toEqual([]);
  });

  it.each([
    ['without a request principal', null],
    ['for the local administrator', LOCAL_ADMIN],
  ])("leaves an unmanaged scan with the host's credential helper and inherited askpass, %s", async (_, principal) => {
    // A connected account never gives an unmanaged scan a token.
    connectPrincipalAccount();
    await useHostCredentialHelper();

    expectScanned(await scan(principal).expect(200));
    expect(new Set(remote.authenticated)).toEqual(new Set(['host-owner']));
    expect(await consulted()).toContain('helper global get');

    await writeGlobalConfig([]);
    vi.stubEnv('GIT_ASKPASS', await hostAskPass('GIT_ASKPASS'));
    remote.authenticated.length = 0;

    expectScanned(await scan(principal).expect(200));
    expect(new Set(remote.authenticated)).toEqual(new Set(['host-owner']));
    expect(await consulted()).toContain('GIT_ASKPASS');
  });

  // Managed Git refuses the SSH transport, so a managed scan or install
  // ignores the identity profile's key (owner decision 2026-11-06).
  it.each(ROUTES.flatMap(([route, call, status, expectDone]) => [
    { route, call, status, expectDone, profile: 'deploy-key', names: 'an identity profile with an SSH key' },
    { route, call, status, expectDone, profile: 'refused-key', names: 'a profile whose key path the catalog refuses' },
  ]))("clones a managed user's $route over HTTPS with only the principal's token although it names $names", async ({ call, status, expectDone, profile }) => {
    await useHostCredentialHelper();
    connectPrincipalAccount();

    const response = await call(managedAdmin('account-principal'), { gitIdentityId: profile });

    expect(response.status).toBe(status);
    await expectDone(response);
    expect(new Set(remote.authenticated)).toEqual(new Set(['principal']));
    expect(await consulted()).toEqual([]);
    expect(await sshStarts()).toEqual([]);
  });

  it.each([
    ['POST /api/config/skills/scan', scan],
    ['POST /api/config/skills/install', install],
  ])('offers a managed user who cannot read the repository no identity profiles from %s', async (_, call) => {
    const response = await call(managedAdmin(null), { gitIdentityId: 'deploy-key' });

    expect(response.status).toBe(401);
    expect(response.body.error).toEqual({
      kind: 'authRequired',
      message: 'Authentication required to access this repository. Connect a GitHub account that can read it.',
      sshOnly: true,
      identities: [],
    });
    expect(response.body.recovery.safeRetry).toBe('Retry after connecting a GitHub account that can read the repository');
    expect(remote.authenticated).toEqual([]);
    expect(await sshStarts()).toEqual([]);
  });

  it.each([
    ['without a request principal', null],
    ['for the local administrator', LOCAL_ADMIN],
  ])("still offers an unmanaged scan that cannot read the repository the host's identity profiles, %s", async (_, principal) => {
    const response = await scan(principal);

    expect(response.status).toBe(401);
    expect(response.body.error).toEqual({
      kind: 'authRequired',
      message: 'Authentication required to access this repository',
      sshOnly: true,
      identities: PROFILE_OPTIONS,
    });
    expect(response.body.recovery.safeRetry).toBe('Retry with a Git identity that can read the repository');
  });
});

// The catalog source listing caches each scan for 30 minutes.
describe.skipIf(process.platform === 'win32')('skills catalog scan cache', () => {
  it("never serves a managed user a listing scanned with the host's credentials", async () => {
    await useHostCredentialHelper();
    expectScanned(await catalogSource(null).expect(200));
    const requests = remote.requests;

    const response = await catalogSource(managedAdmin(null));

    expect(response.status).toBe(500);
    expect(response.body.error).toMatchObject({ kind: 'authRequired' });
    expect(response.body.items).toBeUndefined();
    expect(remote.requests).toBeGreaterThan(requests);
  });

  it("never serves one managed user's listing to another", async () => {
    connectPrincipalAccount();
    expectScanned(await catalogSource(managedAdmin('account-principal')).expect(200));

    const response = await catalogSource(managedAdmin(null));

    expect(response.status).toBe(500);
    expect(response.body.error).toMatchObject({ kind: 'authRequired' });
    expect(response.body.items).toBeUndefined();
  });

  it("reuses each managed user's own listing and one listing shared by unmanaged requests", async () => {
    connectPrincipalAccount();
    expectScanned(await catalogSource(managedAdmin('account-principal')).expect(200));
    let requests = remote.requests;
    expectScanned(await catalogSource(managedAdmin('account-principal')).expect(200));
    expect(remote.requests).toBe(requests);

    // The host's own scan runs with its own credentials.
    await useHostCredentialHelper();
    remote.authenticated.length = 0;
    expectScanned(await catalogSource(null).expect(200));
    expect(remote.requests).toBeGreaterThan(requests);
    expect(new Set(remote.authenticated)).toEqual(new Set(['host-owner']));
    requests = remote.requests;
    expectScanned(await catalogSource(LOCAL_ADMIN).expect(200));
    expect(remote.requests).toBe(requests);
  });
});
