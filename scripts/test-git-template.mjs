// Empty Git repositories for tests, copied from one per-process template.
// `git init` costs a process spawn (~15 ms); copying the template's .git costs
// ~1.5 ms, which matters for suites that create a repository per test.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

let template;

function templateDirectory() {
  if (template) return template;
  const root = mkdtempSync(path.join(os.tmpdir(), 'devryan-git-template-'));
  process.once('exit', () => rmSync(root, { recursive: true, force: true }));
  // No hook samples or description: only what `git init` needs to make a repository.
  execFileSync('git', ['init', '--quiet', '--template=', root], { stdio: 'ignore' });
  template = path.join(root, '.git');
  return template;
}

/** Make `directory` (created if missing) an empty Git repository, as `git init --quiet` would. */
export async function initGitRepository(directory) {
  await fs.mkdir(directory, { recursive: true });
  await fs.cp(templateDirectory(), path.join(directory, '.git'), { recursive: true });
  return directory;
}
