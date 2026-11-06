import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const accounts = vi.hoisted(() => new Map());

vi.mock('../github/auth.js', () => ({
  getGitHubAuthById: (accountId) => accounts.get(accountId) || null,
}));

import { runWithRequestPrincipal } from '../multi-user/request-context.js';
import { buildGitEnv } from './service.js';

const PRINCIPAL_TOKEN = 'principal-token';

let dataDirectory;
let realGit;
let root;

beforeAll(async () => {
  realGit = execFileSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).trim();
  // The askpass helper is created once per process, so one data root serves the file.
  dataDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'devryan-git-askpass-data-'));
});

afterAll(async () => {
  await fs.rm(dataDirectory, { recursive: true, force: true });
});

beforeEach(async () => {
  accounts.clear();
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'devryan-git-askpass-'));
  const home = path.join(root, 'home');
  await fs.mkdir(home);
  // Git reads only this home's (empty) global configuration, never the user's own.
  vi.stubEnv('HOME', home);
  vi.stubEnv('XDG_CONFIG_HOME', path.join(home, '.config'));
  vi.stubEnv('GIT_CONFIG_NOSYSTEM', '1');
  for (const name of [
    'GIT_CONFIG_GLOBAL', 'GIT_CONFIG_SYSTEM', 'GIT_CONFIG_COUNT', 'GIT_CONFIG_PARAMETERS',
    'GIT_ASKPASS', 'SSH_ASKPASS', 'DEVRYAN_GIT_ASKPASS_TOKEN',
  ]) vi.stubEnv(name, undefined);
  vi.stubEnv('GIT_TERMINAL_PROMPT', '0');
  // With an agent socket set, buildGitEnv never probes gpg-agent.
  vi.stubEnv('SSH_AUTH_SOCK', path.join(root, 'agent.sock'));
  vi.stubEnv('DEVRYAN_DATA_DIR', dataDirectory);
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await fs.rm(root, { recursive: true, force: true });
});

// The environment of a credentialed managed Git operation: DevRyan's askpass
// helper and the principal's token, with every host credential source cleared.
const managedGitEnv = () => {
  accounts.set('account-principal', {
    accessToken: PRINCIPAL_TOKEN,
    user: { login: 'principal-user', id: 909, name: 'principal-user Name', email: 'principal-user@example.test' },
  });
  return runWithRequestPrincipal({
    id: 'managed-principal',
    email: 'managed-user@example.test',
    displayName: 'managed-user',
    role: 'developer',
    scope: 'managed',
    githubAccountId: 'account-principal',
    assignments: [{ repositoryPath: root, githubAccountId: 'account-principal' }],
  }, () => buildGitEnv(root, { includeCredentials: true }));
};

const run = (command, args, { env, input = null }) => new Promise((resolve, reject) => {
  const child = spawn(command, args, { env, stdio: [input === null ? 'ignore' : 'pipe', 'pipe', 'pipe'] });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => { stdout += chunk; });
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  child.on('error', reject);
  child.on('close', (code) => resolve({ code, stdout, stderr }));
  if (input !== null) {
    // Git can exit before it reads all of its input (EPIPE), for example when it
    // gives up on a credential; its exit status and output are what count.
    child.stdin.on('error', () => {});
    child.stdin.end(input);
  }
});

// Git runs the askpass program with one argument, the prompt.
const ask = async (prompt, env) => run(env.GIT_ASKPASS, [prompt], { env });

// `git credential fill` asks the configured helpers (none here) and then
// askpass, with the prompt Git itself formats for the credential.
const fill = async (fields, env, args = []) => run(realGit, [...args, 'credential', 'fill'], {
  env,
  input: `${fields.join('\n')}\n\n`,
});

describe.skipIf(process.platform === 'win32')("DevRyan's Git askpass helper", () => {
  it.each([
    ["Username for 'https://github.com': ", 'x-access-token'],
    ["Password for 'https://x-access-token@github.com': ", PRINCIPAL_TOKEN],
    ["Username for 'https://GitHub.com': ", 'x-access-token'],
    ["Username for 'https://github.com/owner/repository.git': ", 'x-access-token'],
    ["Password for 'https://x-access-token@github.com/owner/repository.git': ", PRINCIPAL_TOKEN],
    ["Password for 'https://octocat@github.com': ", PRINCIPAL_TOKEN],
  ])('answers %j', async (prompt, answer) => {
    const env = await managedGitEnv();

    await expect(ask(prompt, env)).resolves.toEqual({ code: 0, stdout: `${answer}\n`, stderr: '' });
  });

  it.each([
    ['another host', "Username for 'https://git.example.test': "],
    ['another host, with the username', "Password for 'https://x-access-token@git.example.test': "],
    ['a host starting with github.com', "Username for 'https://github.com.example.test': "],
    ['a host ending in github.com', "Username for 'https://notgithub.com': "],
    ['a subdomain of github.com', "Username for 'https://gist.github.com': "],
    ['github.com as a path', "Username for 'https://example.test/github.com': "],
    ['plain HTTP', "Username for 'http://github.com': "],
    ['a port', "Username for 'https://github.com:8443': "],
    ['a proxy', "Username for 'http://proxy.example.test:3128': "],
    ['a client certificate', "Password for 'cert:///home/user/client.p12': "],
    ['an SSH key passphrase', "Enter passphrase for key '/home/user/.ssh/id_ed25519': "],
    ['a prompt without a URL', 'Username: '],
    ['a glob as the host', "Username for 'https://*': "],
    // Older Git prints the username undecoded, so these name another host.
    ['an undecoded username ending in @github.com', "Password for 'https://x-access-token@github.com@git.example.test': "],
    ['an undecoded username with a github.com path', "Password for 'https://x-access-token@github.com/x@git.example.test': "],
    ['an undecoded username that is a github.com URL', "Password for 'https://github.com/x@git.example.test': "],
    ['a host after two @', "Password for 'https://a@b@github.com': "],
    ['an empty username', "Password for 'https://@github.com': "],
  ])('fails for %s', async (_case, prompt) => {
    const env = await managedGitEnv();

    const result = await ask(prompt, env);

    expect(result.code).not.toBe(0);
    expect(result.stdout).toBe('');
  });

  it('fails every prompt without a token', async () => {
    const env = await managedGitEnv();
    delete env.DEVRYAN_GIT_ASKPASS_TOKEN;

    const result = await ask("Username for 'https://github.com': ", env);

    expect(result.code).not.toBe(0);
    expect(result.stdout).toBe('');
  });

  it.each([
    ['github.com', ['protocol=https', 'host=github.com'], []],
    ['github.com in another letter case', ['protocol=https', 'host=GitHub.com'], []],
    ['a github.com path with credential.useHttpPath', ['protocol=https', 'host=github.com', 'path=owner/repository.git'], ['-c', 'credential.useHttpPath=true']],
  ])("gives Git the principal's token for %s", async (_case, fields, args) => {
    const env = await managedGitEnv();

    const result = await fill(fields, env, args);

    expect(result.code).toBe(0);
    expect(result.stdout).toContain('username=x-access-token\n');
    expect(result.stdout).toContain(`password=${PRINCIPAL_TOKEN}\n`);
  });

  it("answers Git's password prompt for a github.com URL with its own username", async () => {
    const env = await managedGitEnv();

    const result = await fill(['url=https://octocat@github.com/owner/repository.git'], env);

    expect(result.code).toBe(0);
    expect(result.stdout).toContain('username=octocat\n');
    expect(result.stdout).toContain(`password=${PRINCIPAL_TOKEN}\n`);
  });

  it.each([
    ['another host', ['protocol=https', 'host=git.example.test'], "could not read Username for 'https://git.example.test'"],
    ['plain HTTP', ['protocol=http', 'host=github.com'], "could not read Username for 'http://github.com'"],
    ['a port', ['protocol=https', 'host=github.com:8443'], "could not read Username for 'https://github.com:8443'"],
    [
      'a username that names github.com',
      ['url=https://x-access-token%40github.com%2Fx@git.example.test/repository.git'],
      "could not read Password for 'https://x-access-token%40github.com%2Fx@git.example.test'",
    ],
  ])("keeps the principal's token from Git for %s", async (_case, fields, failure) => {
    const env = await managedGitEnv();

    const result = await fill(fields, env);

    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain(failure);
    expect(result.stdout).not.toContain(PRINCIPAL_TOKEN);
  });
});
