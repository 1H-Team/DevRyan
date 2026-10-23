// Shared isolation for opt-in Claude transport probes. No credentials are read
// on import or while preparing an offline fixture.
import fs from 'node:fs/promises';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { applyMeridianHttpHotfix } from '../../packages/web/server/lib/opencode/meridian-http-hotfix.js';
import { MERIDIAN_PREFIX_EDITS } from '../../packages/web/server/lib/opencode/meridian-passthrough-hotfix.js';

export const repository = path.resolve(import.meta.dirname, '../..');
export const studyModel = 'claude-opus-4-8';
export const studyEffort = 'medium';

export async function requireCacheDirectory(directory) {
  const cache = await fs.realpath(path.join(repository, '.cache'));
  const absolute = path.resolve(directory);
  if (!absolute.startsWith(`${cache}${path.sep}`)) throw new Error('Claude fixture output must resolve inside repository .cache');
  let ancestor = absolute;
  for (;;) {
    try {
      const canonical = await fs.realpath(ancestor);
      if (canonical !== cache && !canonical.startsWith(`${cache}${path.sep}`)) throw new Error('Claude fixture output escapes repository .cache');
      break;
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      ancestor = path.dirname(ancestor);
    }
  }
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  const resolved = await fs.realpath(directory);
  if (!resolved.startsWith(`${cache}${path.sep}`)) throw new Error('Claude fixture output must resolve inside repository .cache');
  return resolved;
}

export function fixtureGit(workspace, args) {
  return execFileSync('git', ['-c', 'core.hooksPath=/dev/null', ...args], {
    cwd: workspace, encoding: 'utf8', timeout: 10_000,
    env: { PATH: process.env.PATH, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

export async function prepareMeridianFixture({ outputRoot, arm, installedModules }) {
  if (!['control', 'candidate'].includes(arm) || !path.isAbsolute(installedModules)) throw new Error('Expected a comparison arm and explicit installed modules');
  const parent = await requireCacheDirectory(outputRoot);
  const root = await fs.mkdtemp(path.join(parent, `${arm}-`));
  const packageRoot = path.join(root, 'node_modules/@rynfar/meridian');
  await fs.mkdir(path.dirname(packageRoot), { recursive: true });
  await fs.cp(path.join(installedModules, '@rynfar/meridian'), packageRoot, { recursive: true, dereference: true });
  const manifest = JSON.parse(await fs.readFile(path.join(packageRoot, 'package.json'), 'utf8'));
  const dependencies = new Set([...Object.keys(manifest.dependencies ?? {}), ...Object.keys(manifest.optionalDependencies ?? {}), `@libsql/${process.platform}-${process.arch}`]);
  // Newer libsql releases use libc-qualified native package names on Linux.
  // Read the installed dependency manifest instead of guessing that suffix.
  try {
    const libsql = JSON.parse(await fs.readFile(path.join(installedModules, 'libsql/package.json'), 'utf8'));
    for (const name of Object.keys(libsql.optionalDependencies ?? {})) {
      if (name.startsWith('@libsql/')) dependencies.add(name);
    }
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  for (const dependency of dependencies) {
    try { await fs.access(path.join(installedModules, dependency)); } catch { continue; }
    const target = path.join(root, 'node_modules', dependency);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.symlink(path.join(installedModules, dependency), target, 'dir');
  }
  const patch = applyMeridianHttpHotfix({ configDirectory: root });
  if (!patch.ok) throw new Error(patch.error);
  const entry = path.join(packageRoot, 'dist', patch.entry);
  if (arm === 'control') {
    if (manifest.version !== '1.62.6') throw new Error('Historical uncorrected control requires Meridian 1.62.6; use candidate for corrected upgrade comparisons');
    const complete = await fs.readFile(entry, 'utf8');
    // Retain the already-installed HTTP and handoff fixes in the control.
    const previous = MERIDIAN_PREFIX_EDITS.reduce((text, [before, after]) => text.replace(after, before), complete);
    await fs.writeFile(entry, previous);
  }
  const sourceSha256 = createHash('sha256').update(await fs.readFile(entry)).digest('hex');
  const workspace = path.join(root, 'workspace');
  const config = path.join(root, 'config');
  await fs.mkdir(workspace);
  await fs.mkdir(config);
  await fs.writeFile(path.join(config, 'sdk-features.json'), JSON.stringify({ opencode: {
    codeSystemPrompt: true, clientSystemPrompt: false, memory: false, dreaming: false,
  } }));
  return { root, packageRoot, workspace, config, sourceSha256, patch, entry };
}

export function isolatedClaudeEnvironment(fixture, claudeExecutable) {
  if (!path.isAbsolute(claudeExecutable)) throw new Error('Claude executable must be explicit and absolute');
  return {
    PATH: process.env.PATH, USER: process.env.USER, TMPDIR: process.env.TMPDIR,
    CLAUDE_CONFIG_DIR: path.join(fixture.root, 'claude'),
    XDG_CONFIG_HOME: path.join(fixture.root, 'xdg/config'),
    XDG_DATA_HOME: path.join(fixture.root, 'xdg/data'),
    XDG_STATE_HOME: path.join(fixture.root, 'xdg/state'),
    XDG_CACHE_HOME: path.join(fixture.root, 'xdg/cache'),
    MERIDIAN_CONFIG_DIR: fixture.config,
    MERIDIAN_SESSION_DIR: path.join(fixture.root, 'sessions'),
    MERIDIAN_WORKDIR: fixture.workspace, MERIDIAN_CLAUDE_PATH: claudeExecutable,
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', DISABLE_AUTOUPDATER: '1',
    CLAUDE_CODE_ENABLE_PROMPT_SUGGESTION: 'false',
  };
}
