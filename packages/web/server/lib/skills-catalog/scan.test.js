import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { scanSkillsRepository } from './scan.js';

const temporaryRoots = [];
const savedEnv = new Map();
const setEnv = (key, value) => {
  if (!savedEnv.has(key)) savedEnv.set(key, process.env[key]);
  process.env[key] = value;
};

afterEach(() => {
  for (const [key, value] of savedEnv) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  savedEnv.clear();
  for (const root of temporaryRoots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

// A local bare repository stands in for github.com/acme/skills, and a `git`
// wrapper first on PATH records every Git command the scan starts.
const createSkillsSource = () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'devryan-skills-scan-test-'));
  temporaryRoots.push(root);
  const realGit = execFileSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).trim();
  const git = (cwd, ...args) => execFileSync(realGit, ['-c', 'user.name=test', '-c', 'user.email=test@example.com', ...args], { cwd, stdio: 'pipe' });
  const work = path.join(root, 'work');
  for (const skillDir of ['skills/alpha', 'skills/beta', 'plugins/bundle/skills/gamma', 'plugins/bundle/skills/delta']) {
    fs.mkdirSync(path.join(work, skillDir), { recursive: true });
    fs.writeFileSync(path.join(work, skillDir, 'SKILL.md'), `---\nname: ${path.basename(skillDir)}\ndescription: ${path.basename(skillDir)} skill\n---\nBody\n`);
  }
  git(work, 'init', '-q');
  git(work, 'add', '.');
  git(work, 'commit', '-qm', 'skills');
  const bare = path.join(root, 'remote', 'acme', 'skills.git');
  git(root, 'clone', '-q', '--bare', work, bare);
  git(bare, 'config', 'uploadpack.allowFilter', 'true');

  const binDir = path.join(root, 'bin');
  const log = path.join(root, 'git.log');
  fs.mkdirSync(binDir);
  fs.writeFileSync(path.join(binDir, 'git'), `#!/bin/sh\necho "$*" >> "${log}"\nexec "${realGit}" "$@"\n`, { mode: 0o755 });
  setEnv('PATH', `${binDir}${path.delimiter}${process.env.PATH}`);
  setEnv('GIT_CONFIG_COUNT', '1');
  setEnv('GIT_CONFIG_KEY_0', `url.file://${path.join(root, 'remote')}/.insteadOf`);
  setEnv('GIT_CONFIG_VALUE_0', 'https://github.com/');

  return () => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8').split('\n').filter(Boolean) : []);
};

describe.skipIf(process.platform === 'win32')('scanSkillsRepository', () => {
  it('lists only the subpath skills and reads them from the sparse checkout, with no git show per skill', async () => {
    const gitCommands = createSkillsSource();

    const result = await scanSkillsRepository({ source: 'acme/skills', subpath: 'skills' });

    expect(result.ok).toBe(true);
    expect(result.items.map((item) => item.skillDir)).toEqual(['skills/alpha', 'skills/beta']);
    expect(result.items.map((item) => item.description)).toEqual(['alpha skill', 'beta skill']);
    expect(result.items.every((item) => item.warnings === undefined)).toBe(true);
    const commands = gitCommands();
    expect(commands.filter((line) => line.includes(' show '))).toEqual([]);
    expect(commands.some((line) => /ls-files -- skills$/.test(line))).toBe(true);
  });

  it('scans every skill in the repository when no subpath is given', async () => {
    const gitCommands = createSkillsSource();

    const result = await scanSkillsRepository({ source: 'acme/skills' });

    expect(result.ok).toBe(true);
    expect(result.items.map((item) => item.skillName)).toEqual(['alpha', 'beta', 'delta', 'gamma']);
    expect(gitCommands().filter((line) => line.includes(' show '))).toEqual([]);
  });
});
