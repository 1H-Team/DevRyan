import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { createFfmpegInstaller } from './ffmpeg.js';

const roots = [];
afterEach(async () => { for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true }); });
const fixture = async () => {
  const root = await fs.mkdtemp(path.join(process.cwd(), '.ffmpeg-test-'));
  roots.push(root);
  const contents = { binary: 'fixture executable', license: 'license', readme: 'source/build instructions' };
  const manifest = { release: 'b6.1.1', source: 'https://fixture.invalid/source', platforms: { 'darwin-arm64':
    Object.fromEntries(Object.entries(contents).map(([key, value]) => [key, { url: `https://fixture.invalid/${key}`,
      sha256: crypto.createHash('sha256').update(value).digest('hex') }])) } };
  const calls = [];
  let corrupt = false, codecFailure = false;
  const installer = createFfmpegInstaller({ installRoot: root, platform: 'darwin', arch: 'arm64', manifest,
    fetchImpl: async url => { calls.push(url); return new Response(corrupt ? 'wrong bytes' : contents[new URL(url).pathname.slice(1)]); },
    runCommand: async (_binary, args) => {
      if (args[0] === '-version') return { ok: true, stdout: 'ffmpeg version fixture\n' };
      if (codecFailure) return { ok: false, stderr: 'encoder unavailable' };
      await fs.writeFile(args.at(-1), 'encoded frame');
      return { ok: true };
    },
  });
  return { root, installer, calls, corrupt: () => { corrupt = true; }, failCodec: () => { codecFailure = true; } };
};

describe('managed recording dependency', () => {
  it('verifies, atomically activates, reuses and single-flights a complete distribution', async () => {
    const f = await fixture();
    expect((await f.installer.status()).ok).toBe(false);
    const first = f.installer.ensureInstalled(), second = f.installer.ensureInstalled();
    expect(second).toBe(first);
    expect(await first).toMatchObject({ ok: true, state: 'ready', changed: true });
    expect(await f.installer.ensureInstalled()).toMatchObject({ ok: true });
    expect(f.calls).toHaveLength(3);
    expect(await fs.readFile(path.join(f.root, 'ffmpeg/README'), 'utf8')).toContain('source');
    expect(await fs.readdir(f.root)).toEqual(['ffmpeg']);
  });
  it('rejects checksum mismatch and retains the previous verified binary on failed repair', async () => {
    const f = await fixture();
    expect((await f.installer.ensureInstalled()).ok).toBe(true);
    f.corrupt();
    const repaired = await f.installer.ensureInstalled({ repair: true });
    expect(repaired.ok).toBe(true);
    expect(repaired.issues[0].message).toContain('checksum');
    expect(await fs.readFile(repaired.binaryPath, 'utf8')).toBe('fixture executable');
    expect(await fs.readdir(f.root)).toEqual(['ffmpeg']);
  });
  it('does not activate a binary whose encoding probe fails', async () => {
    const f = await fixture(); f.failCodec();
    const result = await f.installer.ensureInstalled();
    expect(result.ok).toBe(false);
    expect(result.issues.at(-1).message).toContain('libvpx');
    expect(await fs.readdir(f.root)).toEqual([]);
  });
  it('detects an altered executable even after a successful cached status', async () => {
    const f = await fixture(); const installed = await f.installer.ensureInstalled();
    await fs.writeFile(installed.binaryPath, 'tampered');
    expect((await f.installer.status()).ok).toBe(false);
  });
  it('repairs missing distribution notices even after a cached successful status', async () => {
    const f = await fixture(); await f.installer.ensureInstalled();
    await fs.rm(path.join(f.root, 'ffmpeg/LICENSE'));
    expect((await f.installer.status()).ok).toBe(false);
    expect((await f.installer.ensureInstalled()).ok).toBe(true);
    expect(await fs.readFile(path.join(f.root, 'ffmpeg/LICENSE'), 'utf8')).toBe('license');
  });
  it('reports unsupported platforms without downloading', async () => {
    const f = await fixture();
    const installer = createFfmpegInstaller({ installRoot: f.root, platform: 'win32', arch: 'arm64',
      fetchImpl: () => { throw new Error('unexpected network'); }, runCommand: () => { throw new Error('unexpected probe'); } });
    expect(await installer.ensureInstalled()).toMatchObject({ ok: false, state: 'unsupported' });
  });
  it('reports HTTP download failure and removes staging files', async () => {
    const f = await fixture();
    const installer = createFfmpegInstaller({ installRoot: f.root, fetchImpl: async () => new Response('', { status: 503 }),
      runCommand: () => { throw new Error('unexpected probe'); }, platform: 'darwin', arch: 'arm64' });
    expect((await installer.ensureInstalled()).issues.at(-1).message).toContain('503');
    expect(await fs.readdir(f.root)).toEqual([]);
  });
});
