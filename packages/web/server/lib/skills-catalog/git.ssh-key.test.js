import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { runGit, sshCommandForIdentity } from './git.js';
import { installSkillsFromRepository } from './install.js';
import { scanSkillsRepository } from './scan.js';

const SSH_OPTIONS = ['-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=accept-new'];
// The characters escapeSshKeyPath (lib/git/service.js) and
// escapeCloneSshKeyPath (lib/fs/routes.js) refuse.
const REFUSED_CHARACTERS = [...'`$!"\';&|<>(){}[]*?#~'];

const refusal = (keyPath) => ({
  ok: false,
  error: { kind: 'invalidSource', message: `SSH key path contains invalid characters: ${keyPath}` },
});

describe('sshCommandForIdentity', () => {
  it('gives no command without a key', () => {
    for (const identity of [null, undefined, {}, { sshKey: null }, { sshKey: '' }, { sshKey: '   ' }]) {
      expect(sshCommandForIdentity(identity, 'darwin')).toEqual({ ok: true, sshCommand: null });
    }
  });

  it('single-quotes the trimmed key path', () => {
    expect(sshCommandForIdentity({ sshKey: '  /Users/me/My Keys/id_ed25519 ' }, 'darwin')).toEqual({
      ok: true,
      sshCommand: "ssh -i '/Users/me/My Keys/id_ed25519' -o BatchMode=yes -o StrictHostKeyChecking=accept-new",
    });
  });

  it('uses the MSYS form of a Windows key path', () => {
    expect(sshCommandForIdentity({ sshKey: 'C:\\Users\\Me\\My Keys\\id_ed25519' }, 'win32')).toEqual({
      ok: true,
      sshCommand: "ssh -i '/c/Users/Me/My Keys/id_ed25519' -o BatchMode=yes -o StrictHostKeyChecking=accept-new",
    });
    expect(sshCommandForIdentity({ sshKey: 'D:/keys/id_rsa' }, 'win32').sshCommand)
      .toBe("ssh -i '/d/keys/id_rsa' -o BatchMode=yes -o StrictHostKeyChecking=accept-new");
    expect(sshCommandForIdentity({ sshKey: 'C:\\Keys (old)\\id_rsa' }, 'win32')).toEqual(refusal('C:\\Keys (old)\\id_rsa'));
  });

  it.each(REFUSED_CHARACTERS)('refuses a key path that holds %s', (character) => {
    const sshKey = `/keys/id${character}ed25519`;
    for (const platform of ['darwin', 'linux', 'win32']) {
      expect(sshCommandForIdentity({ sshKey }, platform)).toEqual(refusal(sshKey));
    }
  });
});

// Git runs core.sshCommand through the shell. These tests clone
// git@github.com:acme/skills.git through a stand-in `ssh` first on PATH, which
// records its arguments and serves the clone from a local bare repository, so
// the real shell and the real Git decide what the key path becomes.
describe.skipIf(process.platform === 'win32')('skills catalog Git identity SSH key', () => {
  let root;
  let gitLog;
  let sshLog;
  let injectedLog;
  let keyWithSpace;
  let keyWithSemicolon;

  const readLines = (file) => (fs.existsSync(file) ? fs.readFileSync(file, 'utf8').split('\n').filter(Boolean) : []);
  // Every git command the catalog started.
  const gitCommands = () => readLines(gitLog);
  // The arguments of every ssh connection Git opened, one array per connection.
  const sshCalls = () => readLines(sshLog).map((line) => line.split('\x1f').slice(0, -1));
  const expectEverySshCallToName = (keyPath) => {
    const calls = sshCalls();
    expect(calls.length).toBeGreaterThan(0);
    for (const call of calls) expect(call.slice(0, 6)).toEqual(['-i', keyPath, ...SSH_OPTIONS]);
  };
  const installAlpha = (identity) => installSkillsFromRepository({
    source: 'acme/skills',
    identity,
    scope: 'project',
    targetSource: 'opencode',
    workingDirectory: path.join(root, 'project'),
    userSkillDir: path.join(root, 'user-skills'),
    selections: [{ skillDir: 'skills/alpha' }],
  });

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'devryan-skills-ssh-key-'));
    const realGit = execFileSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).trim();
    // Git reads none of the user's global or system configuration, and no
    // inherited SSH command or repository overrides the catalog's own.
    vi.stubEnv('GIT_CONFIG_NOSYSTEM', '1');
    vi.stubEnv('GIT_CONFIG_GLOBAL', path.join(root, 'global.gitconfig'));
    for (const name of ['GIT_SSH_COMMAND', 'GIT_SSH', 'GIT_SSH_VARIANT', 'GIT_CONFIG_COUNT', 'GIT_CONFIG_PARAMETERS', 'GIT_DIR', 'GIT_WORK_TREE']) {
      vi.stubEnv(name, undefined);
    }

    const git = (cwd, ...args) => execFileSync(realGit, ['-c', 'user.name=test', '-c', 'user.email=test@example.com', ...args], { cwd, stdio: 'pipe' });
    const work = path.join(root, 'work');
    for (const skill of ['alpha', 'beta']) {
      fs.mkdirSync(path.join(work, 'skills', skill), { recursive: true });
      fs.writeFileSync(path.join(work, 'skills', skill, 'SKILL.md'), `---\nname: ${skill}\ndescription: ${skill} skill\n---\nBody\n`);
    }
    git(work, 'init', '-q', '-b', 'main');
    git(work, 'add', '.');
    git(work, 'commit', '-qm', 'skills');
    const bare = path.join(root, 'remote', 'acme', 'skills.git');
    git(root, 'clone', '-q', '--bare', work, bare);
    git(bare, 'config', 'uploadpack.allowFilter', 'true');

    const binDir = path.join(root, 'bin');
    gitLog = path.join(root, 'git.log');
    sshLog = path.join(root, 'ssh.log');
    injectedLog = path.join(root, 'injected.log');
    fs.mkdirSync(binDir);
    const writeScript = (name, body) => fs.writeFileSync(path.join(binDir, name), `#!/bin/sh\n${body}`, { mode: 0o755 });
    writeScript('git', `echo "$*" >> '${gitLog}'\nexec '${realGit}' "$@"\n`);
    // ssh to github.com: needs `-i` naming an existing file, then serves
    // `git-upload-pack 'acme/skills.git'` from the bare repository.
    writeScript('ssh', [
      `printf '%s\\037' "$@" >> '${sshLog}'`,
      `printf '\\n' >> '${sshLog}'`,
      'key=',
      'while [ "$#" -gt 0 ]; do',
      '  case "$1" in',
      '    -i) key=$2; shift 2 ;;',
      '    -o) shift 2 ;;',
      '    *) break ;;',
      '  esac',
      'done',
      'if [ ! -f "$key" ]; then echo "ssh: identity file $key not accessible" >&2; exit 255; fi',
      `if [ "$1" != 'git@github.com' ] || [ "$2" != "git-upload-pack 'acme/skills.git'" ]; then echo "ssh: could not resolve hostname $1" >&2; exit 255; fi`,
      `exec '${realGit}' upload-pack '${bare}'`,
      '',
    ].join('\n'));
    // Runs only if the shell executes text from a key path.
    writeScript('devryan-skills-injected', `printf '%s\\n' "$*" >> '${injectedLog}'\nexit 1\n`);
    vi.stubEnv('PATH', `${binDir}${path.delimiter}${process.env.PATH}`);

    // Placeholder files: the stand-in ssh only checks that the key exists.
    keyWithSpace = path.join(root, 'My Keys', 'id_ed25519');
    keyWithSemicolon = path.join(root, 'keys', 'id_ed25519;devryan-skills-injected');
    for (const keyPath of [keyWithSpace, keyWithSemicolon]) {
      fs.mkdirSync(path.dirname(keyPath), { recursive: true });
      fs.writeFileSync(keyPath, 'placeholder\n', { mode: 0o600 });
    }
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('scans with a key path that holds a space, passing the whole path to ssh -i', async () => {
    const result = await scanSkillsRepository({ source: 'acme/skills', identity: { sshKey: keyWithSpace } });

    expectEverySshCallToName(keyWithSpace);
    expect(result).toMatchObject({ ok: true, normalizedRepo: 'acme/skills' });
    expect(result.items.map((item) => item.skillName)).toEqual(['alpha', 'beta']);
  });

  it('installs with a key path that holds a space, passing the whole path to ssh -i', async () => {
    const result = await installAlpha({ sshKey: keyWithSpace });

    expectEverySshCallToName(keyWithSpace);
    expect(result).toEqual({ ok: true, installed: [{ skillName: 'alpha', scope: 'project', source: 'opencode' }], skipped: [] });
    expect(fs.readFileSync(path.join(root, 'project', '.opencode', 'skills', 'alpha', 'SKILL.md'), 'utf8')).toContain('description: alpha skill');
  });

  it('refuses to scan with a key path that holds a shell metacharacter, before running git', async () => {
    const result = await scanSkillsRepository({ source: 'acme/skills', identity: { sshKey: keyWithSemicolon } });

    expect(readLines(injectedLog)).toEqual([]);
    expect(result).toEqual(refusal(keyWithSemicolon));
    expect(gitCommands()).toEqual([]);
    expect(sshCalls()).toEqual([]);
  });

  it('refuses to install with a key path that holds a shell metacharacter, before running git', async () => {
    const result = await installAlpha({ sshKey: keyWithSemicolon });

    expect(readLines(injectedLog)).toEqual([]);
    expect(result).toEqual(refusal(keyWithSemicolon));
    expect(gitCommands()).toEqual([]);
    expect(sshCalls()).toEqual([]);
    expect(fs.existsSync(path.join(root, 'project'))).toBe(false);
  });

  it('runGit refuses such a key path itself, without starting git', async () => {
    const result = await runGit(['ls-remote', 'git@github.com:acme/skills.git'], { identity: { sshKey: keyWithSemicolon } });

    expect(result).toEqual({
      ok: false,
      stdout: '',
      stderr: '',
      message: `SSH key path contains invalid characters: ${keyWithSemicolon}`,
      code: null,
      signal: null,
    });
    expect(readLines(injectedLog)).toEqual([]);
    expect(gitCommands()).toEqual([]);
  });
});
