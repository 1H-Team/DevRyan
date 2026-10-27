import { afterEach, describe, expect, it } from 'vitest';
import { lstat, mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  applyDevRyanSidecarToConfig,
  getDevRyanSidecarPath,
  migrateDevRyanSidecarDirectory,
  persistDevRyanFromConfig,
  readDevRyanSidecar,
} from './devryan-sidecar.js';

const roots = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('DevRyan sidecar migration', () => {
  it('reads old settings, writes canonical settings, and leaves old data available', async () => {
    const root = await mkdtemp(join(tmpdir(), 'devryan-sidecar-'));
    roots.push(root);
    const configPath = join(root, 'config.json');
    const legacyPath = join(root, '.openchamber', 'config.json');
    await mkdir(join(root, '.openchamber'));
    await writeFile(legacyPath, JSON.stringify({ agentOverrides: { old: { model: 'old/model' } } }));

    const synthetic = applyDevRyanSidecarToConfig({ openchamber: { legacy: true } }, configPath);
    expect(synthetic).toEqual({ devryan: { legacy: true, agentOverrides: { old: { model: 'old/model' } } } });

    const sanitized = persistDevRyanFromConfig({ ...synthetic, devryan: { ...synthetic.devryan, current: true } }, configPath);
    expect(sanitized).toEqual({});
    expect(JSON.parse(await readFile(getDevRyanSidecarPath(configPath), 'utf8'))).toMatchObject({ current: true, legacy: true });
    expect((await lstat(getDevRyanSidecarPath(configPath))).mode & 0o777).toBe(0o600);
    expect(readDevRyanSidecar(configPath)).toMatchObject({ current: true, legacy: true });
    expect(JSON.parse(await readFile(legacyPath, 'utf8'))).toHaveProperty('agentOverrides.old');
  });

  it('copies legacy managed artifacts once and keeps newer canonical files', async () => {
    const root = await mkdtemp(join(tmpdir(), 'devryan-sidecar-copy-'));
    roots.push(root);
    await mkdir(join(root, '.openchamber', 'backups'), { recursive: true });
    await mkdir(join(root, '.devryan'));
    await writeFile(join(root, '.openchamber', 'user-profile-manifest.json'), '{"legacy":true}');
    await writeFile(join(root, '.openchamber', 'backups', 'agent.md'), 'legacy');
    await writeFile(join(root, '.devryan', 'user-profile-manifest.json'), '{"current":true}');

    migrateDevRyanSidecarDirectory(root);
    migrateDevRyanSidecarDirectory(root);

    expect(await readFile(join(root, '.devryan', 'user-profile-manifest.json'), 'utf8')).toBe('{"current":true}');
    expect(await readFile(join(root, '.devryan', 'backups', 'agent.md'), 'utf8')).toBe('legacy');
    expect(await readFile(join(root, '.openchamber', 'backups', 'agent.md'), 'utf8')).toBe('legacy');
    expect((await lstat(join(root, '.devryan', '.legacy-openchamber-imported'))).isFile()).toBe(true);
    expect((await lstat(join(root, '.devryan'))).mode & 0o777).toBe(0o700);
    await writeFile(join(root, '.openchamber', 'later.json'), '{}');
    migrateDevRyanSidecarDirectory(root);
    await expect(readFile(join(root, '.devryan', 'later.json'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('retries a partial copy after an unsupported legacy entry is removed', async () => {
    const root = await mkdtemp(join(tmpdir(), 'devryan-sidecar-retry-'));
    roots.push(root);
    await mkdir(join(root, '.openchamber'));
    await writeFile(join(root, '.openchamber', 'a.json'), '{"old":true}');
    await symlink('a.json', join(root, '.openchamber', 'link.json'));
    expect(() => migrateDevRyanSidecarDirectory(root)).toThrow(/Unsupported legacy/);
    await expect(lstat(join(root, '.devryan', '.legacy-openchamber-imported'))).rejects.toMatchObject({ code: 'ENOENT' });
    await rm(join(root, '.openchamber', 'link.json'));
    migrateDevRyanSidecarDirectory(root);
    expect(await readFile(join(root, '.devryan', 'a.json'), 'utf8')).toBe('{"old":true}');
    expect((await lstat(join(root, '.devryan', '.legacy-openchamber-imported'))).isFile()).toBe(true);
  });
});
