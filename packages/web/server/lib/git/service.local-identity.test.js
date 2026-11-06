import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../github/auth.js', () => ({
  getGitHubAuthById: () => null,
}));

import { getCurrentIdentity, setLocalIdentity } from './service.js';

const execFileAsync = promisify(execFile);

// The keys an identity profile writes, as `git config --list` prints them.
const IDENTITY_KEYS = ['user.name', 'user.email', 'core.sshcommand', 'credential.helper'];
const PREVIOUS_SSH_COMMAND = "ssh -i '/previous/id_ed25519' -o IdentitiesOnly=yes";

let root;
let directory;

const git = (args) => execFileAsync('git', ['-C', directory, ...args], { encoding: 'utf8' });

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'devryan-git-identity-'));
  const home = path.join(root, 'home');
  directory = path.join(root, 'repository');
  await fs.mkdir(home);
  await fs.mkdir(directory);
  // Git reads and writes only the temporary repository: never the user's global
  // or system configuration, nor a repository named by an inherited GIT_DIR.
  vi.stubEnv('HOME', home);
  vi.stubEnv('GIT_CONFIG_NOSYSTEM', '1');
  for (const name of ['GIT_CONFIG_GLOBAL', 'XDG_CONFIG_HOME', 'GIT_DIR', 'GIT_WORK_TREE']) {
    vi.stubEnv(name, undefined);
  }
  // With an agent socket set, buildGitEnv never probes gpg-agent.
  vi.stubEnv('SSH_AUTH_SOCK', path.join(root, 'agent.sock'));
  await git(['init', '-q', '-b', 'main']);
});

afterEach(async () => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  await fs.rm(root, { recursive: true, force: true });
});

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

describe.skipIf(process.platform === 'win32')('setLocalIdentity', () => {
  it("applies an SSH profile's key command and clears a token profile's credential helper", async () => {
    await git(['config', '--local', 'credential.helper', 'store']);
    await git(['config', '--local', 'core.sshCommand', PREVIOUS_SSH_COMMAND]);
    const sshKey = path.join(root, 'ssh keys', 'id_ed25519');

    await expect(setLocalIdentity(directory, {
      userName: 'SSH User', userEmail: 'ssh-user@example.test', authType: 'ssh', sshKey,
    })).resolves.toBe(true);

    const sshCommand = `ssh -i '${sshKey}' -o IdentitiesOnly=yes`;
    expect(await localIdentityConfig()).toEqual({
      'user.name': ['SSH User'],
      'user.email': ['ssh-user@example.test'],
      'core.sshcommand': [sshCommand],
    });
    await expect(getCurrentIdentity(directory)).resolves.toEqual({
      userName: 'SSH User', userEmail: 'ssh-user@example.test', sshCommand,
    });
  });

  it("applies a token profile's credential helper and clears an SSH profile's key command", async () => {
    await git(['config', '--local', 'core.sshCommand', PREVIOUS_SSH_COMMAND]);

    await expect(setLocalIdentity(directory, {
      userName: 'Token User', userEmail: 'token-user@example.test', authType: 'token', host: 'github.com',
    })).resolves.toBe(true);

    expect(await localIdentityConfig()).toEqual({
      'user.name': ['Token User'],
      'user.email': ['token-user@example.test'],
      'credential.helper': ['store'],
    });
  });

  it('refuses an SSH key path that could break out of its quotes', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});

    await expect(setLocalIdentity(directory, {
      userName: 'SSH User', userEmail: 'ssh-user@example.test', authType: 'ssh',
      sshKey: "/keys/id_ed25519' -o ProxyCommand='false",
    })).rejects.toThrow('SSH key path contains invalid characters');

    expect((await localIdentityConfig())['core.sshcommand']).toBeUndefined();
  });

  it('writes nothing when it refuses the SSH key path', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    await git(['config', '--local', 'user.name', 'Previous User']);
    await git(['config', '--local', 'user.email', 'previous-user@example.test']);
    await git(['config', '--local', 'credential.helper', 'store']);

    await expect(setLocalIdentity(directory, {
      userName: 'SSH User', userEmail: 'ssh-user@example.test', authType: 'ssh',
      sshKey: '/keys/old (2019)/id_rsa',
    })).rejects.toThrow('SSH key path contains invalid characters');

    expect(await localIdentityConfig()).toEqual({
      'user.name': ['Previous User'],
      'user.email': ['previous-user@example.test'],
      'credential.helper': ['store'],
    });
  });
});
