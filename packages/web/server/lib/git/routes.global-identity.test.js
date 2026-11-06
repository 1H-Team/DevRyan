import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import express from 'express';
import request from '../../test-supertest.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../github/auth.js', () => ({
  getGitHubAuthById: () => null,
}));

import { registerGitRoutes } from './routes.js';

const execFileAsync = promisify(execFile);

// The keys an identity profile writes, as `git config --list` prints them.
const IDENTITY_KEYS = ['user.name', 'user.email', 'core.sshcommand', 'credential.helper'];
const PREVIOUS_SSH_COMMAND = "ssh -i '/previous/id_ed25519' -o IdentitiesOnly=yes";
const GLOBAL_IDENTITY = { 'user.name': ['Global User'], 'user.email': ['global-user@example.test'] };

let root;
let home;
let directory;

const git = (args) => execFileAsync('git', ['-C', directory, ...args], { encoding: 'utf8' });
// Written by path, so only the stub HOME's global config ever changes.
const setGlobalConfig = (key, value) => execFileAsync('git', ['config', '--file', path.join(home, '.gitconfig'), key, value]);

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'devryan-git-global-identity-'));
  home = path.join(root, 'home');
  directory = path.join(root, 'repository');
  await fs.mkdir(home);
  await fs.mkdir(directory);
  // Git reads only the stub HOME's global config and the temporary repository:
  // never the user's own global or system configuration, nor a repository
  // named by an inherited GIT_DIR.
  vi.stubEnv('HOME', home);
  vi.stubEnv('GIT_CONFIG_NOSYSTEM', '1');
  for (const name of ['GIT_CONFIG_GLOBAL', 'XDG_CONFIG_HOME', 'GIT_DIR', 'GIT_WORK_TREE']) {
    vi.stubEnv(name, undefined);
  }
  // With an agent socket set, buildGitEnv never probes gpg-agent.
  vi.stubEnv('SSH_AUTH_SOCK', path.join(root, 'agent.sock'));
  await git(['init', '-q', '-b', 'main']);
  await setGlobalConfig('user.name', 'Global User');
  await setGlobalConfig('user.email', 'global-user@example.test');
});

afterEach(async () => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  await fs.rm(root, { recursive: true, force: true });
});

const applyGlobalIdentity = () => {
  const app = express();
  app.use(express.json());
  registerGitRoutes(app);
  return request(app).post('/api/git/set-identity').query({ directory }).send({ profileId: 'global' });
};

// Every value of each identity key in the repository's own config file.
const localIdentityConfig = async () => {
  const { stdout } = await git(['config', '--local', '--null', '--list']);
  const config = {};
  for (const entry of stdout.split('\0').filter(Boolean)) {
    const [key, ...lines] = entry.split('\n');
    if (IDENTITY_KEYS.includes(key)) (config[key] ??= []).push(lines.join('\n'));
  }
  return config;
};

// A previous token profile's credential helper and SSH profile's key command.
const setPreviousAuthentication = async () => {
  await git(['config', '--local', 'credential.helper', 'store']);
  await git(['config', '--local', 'core.sshCommand', PREVIOUS_SSH_COMMAND]);
};

const expectGlobalKeyApplied = async (response, sshKey) => {
  expect(response.body).toEqual({
    success: true,
    profile: {
      id: 'global',
      name: 'Global Identity',
      userName: 'Global User',
      userEmail: 'global-user@example.test',
      sshKey,
    },
  });
  expect(await localIdentityConfig()).toEqual({
    ...GLOBAL_IDENTITY,
    'core.sshcommand': [`ssh -i '${sshKey}' -o IdentitiesOnly=yes`],
  });
};

describe.skipIf(process.platform === 'win32')('POST /api/git/set-identity with the global profile', () => {
  it.each([
    ['a bare key path', 'ssh -i /keys/id_ed25519', '/keys/id_ed25519'],
    ["buildSshCommand's quoted form", "ssh -i '/keys/ssh keys/id_ed25519' -o IdentitiesOnly=yes", '/keys/ssh keys/id_ed25519'],
    ['an unquoted key path with options', 'ssh -i /keys/id_ed25519 -o IdentitiesOnly=yes', '/keys/id_ed25519'],
    ['a double-quoted key path after its options', 'ssh -o IdentitiesOnly=yes -i "/keys/ssh keys/id_ed25519"', '/keys/ssh keys/id_ed25519'],
  ])('applies the exact key path of %s', async (_, sshCommand, sshKey) => {
    await setPreviousAuthentication();
    await setGlobalConfig('core.sshCommand', sshCommand);

    await expectGlobalKeyApplied(await applyGlobalIdentity().expect(200), sshKey);
  });

  it('applies a home-relative key path under HOME', async () => {
    await setPreviousAuthentication();
    await setGlobalConfig('core.sshCommand', 'ssh -i ~/.ssh/id_ed25519');

    await expectGlobalKeyApplied(await applyGlobalIdentity().expect(200), path.join(home, '.ssh', 'id_ed25519'));
  });

  it.each([
    ['an option a profile cannot carry', 'ssh -i /keys/id_ed25519 -p 2222'],
    ['a shell expansion', 'ssh -i "$HOME/.ssh/id_ed25519"'],
    ['another SSH program', '/usr/bin/ssh -i /keys/id_ed25519'],
    ['an unterminated quote', "ssh -i '/keys/id_ed25519"],
    ["another user's home directory", 'ssh -i ~other/.ssh/id_ed25519'],
  ])('applies no SSH key for %s, so the global command stays in effect', async (_, sshCommand) => {
    await setGlobalConfig('core.sshCommand', sshCommand);

    const response = await applyGlobalIdentity().expect(200);

    expect(response.body.profile.sshKey).toBeNull();
    expect(await localIdentityConfig()).toEqual(GLOBAL_IDENTITY);
    const { stdout } = await git(['config', 'core.sshCommand']);
    expect(stdout).toBe(`${sshCommand}\n`);
  });

  it('refuses a key path DevRyan cannot write and leaves the previous identity in place', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    await git(['config', '--local', 'user.name', 'Previous User']);
    await git(['config', '--local', 'user.email', 'previous-user@example.test']);
    await git(['config', '--local', 'core.sshCommand', PREVIOUS_SSH_COMMAND]);
    await setGlobalConfig('core.sshCommand', "ssh -i '/keys/old (2019)/id_rsa' -o IdentitiesOnly=yes");

    const response = await applyGlobalIdentity().expect(500);

    expect(response.body).toEqual({ error: 'SSH key path contains invalid characters: /keys/old (2019)/id_rsa' });
    expect(await localIdentityConfig()).toEqual({
      'user.name': ['Previous User'],
      'user.email': ['previous-user@example.test'],
      'core.sshcommand': [PREVIOUS_SSH_COMMAND],
    });
  });
});
