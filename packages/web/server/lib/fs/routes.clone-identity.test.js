import { execFile, spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import express from 'express';
import request from '../../test-supertest.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { registerFsRoutes } from './routes.js';
// service.js fixes the working directory of its global-config reads when it
// loads. The server loads it at startup; loaded here before any test stubs
// HOME, it never names a stub HOME that an earlier test has deleted.
import '../git/index.js';

const execFileAsync = promisify(execFile);

// The keys an identity profile writes, as `git config --list` prints them.
const IDENTITY_KEYS = ['user.name', 'user.email', 'core.sshcommand', 'credential.helper'];
const GLOBAL_IDENTITY = { 'user.name': ['Global User'], 'user.email': ['global-user@example.test'] };
// What the clone adds to the profile's key for its own SSH connection.
const CLONE_SSH_OPTIONS = '-o IdentitiesOnly=yes -o BatchMode=yes -o StrictHostKeyChecking=accept-new';

let root;
let home;
let source;
let destination;
let spawnGit;

const git = (directory, args) => execFileAsync('git', ['-C', directory, ...args], { encoding: 'utf8' });
// Written by path, so only the stub HOME's global config ever changes.
const setGlobalConfig = (key, value) => execFileAsync('git', ['config', '--file', path.join(home, '.gitconfig'), key, value]);

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'devryan-fs-clone-identity-'));
  home = path.join(root, 'home');
  source = path.join(root, 'source');
  destination = path.join(root, 'clones', 'clone');
  await fs.mkdir(home);
  // Git reads only the stub HOME's global config and the temporary
  // repositories: never the user's own global or system configuration, nor a
  // repository named by an inherited GIT_DIR.
  vi.stubEnv('HOME', home);
  vi.stubEnv('GIT_CONFIG_NOSYSTEM', '1');
  for (const name of ['GIT_CONFIG_GLOBAL', 'XDG_CONFIG_HOME', 'GIT_DIR', 'GIT_WORK_TREE']) {
    vi.stubEnv(name, undefined);
  }
  // With an agent socket set, buildGitEnv never probes gpg-agent.
  vi.stubEnv('SSH_AUTH_SOCK', path.join(root, 'agent.sock'));
  // A local path, so the clone itself never starts ssh.
  await execFileAsync('git', ['init', '-q', '-b', 'main', source]);
  await setGlobalConfig('user.name', 'Global User');
  await setGlobalConfig('user.email', 'global-user@example.test');
  spawnGit = vi.fn(spawn);
});

afterEach(async () => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  await fs.rm(root, { recursive: true, force: true });
});

const cloneWithGlobalIdentity = () => {
  const app = express();
  app.use(express.json());
  registerFsRoutes(app, {
    os,
    path,
    fsPromises: fs,
    spawn: spawnGit,
    crypto: { randomUUID: () => 'clone-identity-job' },
    normalizeDirectoryPath: (value) => value,
    resolveProjectDirectory: async () => ({ directory: root }),
    buildAugmentedPath: () => process.env.PATH || '',
    resolveGitBinaryForSpawn: () => 'git',
    devryanUserConfigRoot: path.join(root, 'config'),
  });
  return request(app)
    .post('/api/fs/clone')
    .send({ remoteUrl: source, destinationPath: destination, gitIdentityId: 'global' });
};

// The clone succeeded with exactly these options in front of `git clone`.
const expectClonedWith = (response, gitOptions) => {
  expect(response.body).toEqual({ success: true, path: destination, output: expect.any(String) });
  expect(spawnGit).toHaveBeenCalledOnce();
  expect(spawnGit.mock.calls[0].slice(0, 2)).toEqual(['git', [...gitOptions, 'clone', '--', source, 'clone']]);
};

// Every value of each identity key in the clone's own config file.
const cloneIdentityConfig = async () => {
  const { stdout } = await git(destination, ['config', '--local', '--null', '--list']);
  const config = {};
  for (const entry of stdout.split('\0').filter(Boolean)) {
    const [key, ...lines] = entry.split('\n');
    if (IDENTITY_KEYS.includes(key)) (config[key] ??= []).push(lines.join('\n'));
  }
  return config;
};

const expectClonedWithKey = async (response, sshKey) => {
  expectClonedWith(response, ['-c', `core.sshCommand=ssh -i '${sshKey}' ${CLONE_SSH_OPTIONS}`]);
  expect(await cloneIdentityConfig()).toEqual({
    ...GLOBAL_IDENTITY,
    'core.sshcommand': [`ssh -i '${sshKey}' -o IdentitiesOnly=yes`],
  });
};

describe.skipIf(process.platform === 'win32')('POST /api/fs/clone with the global identity', () => {
  it.each([
    ['a bare key path', 'ssh -i /keys/id_ed25519', '/keys/id_ed25519'],
    ["buildSshCommand's quoted form", "ssh -i '/keys/ssh keys/id_ed25519' -o IdentitiesOnly=yes", '/keys/ssh keys/id_ed25519'],
    ['an unquoted key path with options', 'ssh -i /keys/id_ed25519 -o IdentitiesOnly=yes', '/keys/id_ed25519'],
    ['a double-quoted key path after its options', 'ssh -o IdentitiesOnly=yes -i "/keys/ssh keys/id_ed25519"', '/keys/ssh keys/id_ed25519'],
  ])('clones with the exact key path of %s', async (_, sshCommand, sshKey) => {
    await setGlobalConfig('core.sshCommand', sshCommand);

    await expectClonedWithKey(await cloneWithGlobalIdentity().expect(200), sshKey);
  });

  it('clones with a home-relative key path under HOME', async () => {
    await setGlobalConfig('core.sshCommand', 'ssh -i ~/.ssh/id_ed25519');

    await expectClonedWithKey(await cloneWithGlobalIdentity().expect(200), path.join(home, '.ssh', 'id_ed25519'));
  });

  it.each([
    ['an option a profile cannot carry', 'ssh -i /keys/id_ed25519 -p 2222'],
    ['a shell expansion', 'ssh -i "$HOME/.ssh/id_ed25519"'],
    ['another SSH program', '/usr/bin/ssh -i /keys/id_ed25519'],
    ['an unterminated quote', "ssh -i '/keys/id_ed25519"],
    ["another user's home directory", 'ssh -i ~other/.ssh/id_ed25519'],
  ])('clones without a key for %s, so the global command stays in effect', async (_, sshCommand) => {
    await setGlobalConfig('core.sshCommand', sshCommand);

    expectClonedWith(await cloneWithGlobalIdentity().expect(200), []);
    expect(await cloneIdentityConfig()).toEqual(GLOBAL_IDENTITY);
    const { stdout } = await git(destination, ['config', 'core.sshCommand']);
    expect(stdout).toBe(`${sshCommand}\n`);
  });

  it('refuses a key path DevRyan cannot pass to ssh before writing anything', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    await setGlobalConfig('core.sshCommand', "ssh -i '/keys/old (2019)/id_rsa' -o IdentitiesOnly=yes");

    const response = await cloneWithGlobalIdentity().expect(500);

    expect(response.body).toEqual({ error: 'SSH key path contains invalid characters: /keys/old (2019)/id_rsa' });
    expect(spawnGit).not.toHaveBeenCalled();
    await expect(fs.access(path.dirname(destination))).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
