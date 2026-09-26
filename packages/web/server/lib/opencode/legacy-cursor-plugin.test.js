import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, beforeEach, expect, test } from 'vitest';
import { LEGACY_CURSOR_PLUGIN_HASH, retireLegacyCursorPlugin } from './legacy-cursor-plugin.js';

const fixture = Buffer.from('export default async () => ({ tool: { read: {}, glob: {} } });\n');
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
// Only the fixture bytes stand in for the audited bundle. Production hashing
// is separately checked below; tests never read the installed user profile.
const fixtureHash = bytes => bytes.equals(fixture) ? LEGACY_CURSOR_PLUGIN_HASH : hash(bytes);
let root;
beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'legacy-cursor-test-')); });
afterEach(() => { fs.rmSync(root, { recursive: true, force: true }); });
const write = (name, bytes) => { const file = path.join(root, name); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, bytes); return file; };
const migrate = (io = fs) => retireLegacyCursorPlugin({ configDirectory: root, fs: io, hashContent: fixtureHash });

test('production ownership requires the exact observed content fingerprint', () => {
  expect(LEGACY_CURSOR_PLUGIN_HASH).toBe('954ceb8ef4de6ac2cb3e95d81d56a11bda58d396d2dd7756915724e193d8f622');
  const file = write('plugin/cursor-acp.js', fixture);
  expect(retireLegacyCursorPlugin({ configDirectory: root })).toMatchObject({ ok: false, conflicts: [file], changed: false });
  expect(fs.readFileSync(file)).toEqual(fixture);
});

test.each(['plugin', 'plugins'])('retires the auto-discovered %s copy and only its duplicate registrations', directory => {
  const file = write(`${directory}/cursor-acp.js`, fixture);
  const unrelated = './plugin/custom-cursor-acp.js';
  write('opencode.json', JSON.stringify({ plugin: [`./${directory}/cursor-acp.js`, file, pathToFileURL(file).href,
    [`./${directory}/cursor-acp.js`, { enabled: true }], './plugins/devryan-open-cursor.mjs', unrelated], theme: 'dark' }));
  write('opencode.jsonc', `// keep this comment\n{"plugin":["./${directory}/cursor-acp.js","user-plugin"],"permission":"ask"}`);
  const result = migrate();
  expect(result).toMatchObject({ ok: true, changed: true, removed: [file] });
  expect(fs.existsSync(file)).toBe(false);
  expect(result.backups[0]).toMatch(/\.disabled$/);
  expect(fs.readFileSync(result.backups[0])).toEqual(fixture);
  expect(JSON.parse(fs.readFileSync(path.join(root, 'opencode.json'), 'utf8'))).toEqual({ plugin: ['./plugins/devryan-open-cursor.mjs', unrelated], theme: 'dark' });
  expect(fs.readFileSync(path.join(root, 'opencode.jsonc'), 'utf8')).toContain('// keep this comment');
  expect(migrate()).toMatchObject({ ok: true, changed: false, removed: [] });
});

test('preserves both copies if either was customized', () => {
  const good = write('plugin/cursor-acp.js', fixture);
  const custom = write('plugins/cursor-acp.js', 'custom implementation');
  expect(migrate()).toMatchObject({ ok: false, changed: false, conflicts: [custom] });
  expect(fs.readFileSync(good)).toEqual(fixture);
  expect(fs.readFileSync(custom, 'utf8')).toBe('custom implementation');
});

// open-cursor's installer creates this symlink by default. The package lives
// outside the profile, e.g. a global npm prefix.
const link = (name, target) => {
  const file = path.join(root, name);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.symlinkSync(target, file);
  return file;
};
const packageEntry = (bytes) => {
  const file = path.join(root, 'global/lib/node_modules/@rama_nigg/open-cursor/dist/plugin-entry.js');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, bytes);
  return file;
};

test('retires a symlink to the audited bundle as a link, never touching its target', () => {
  const target = write('elsewhere/bundle.js', fixture);
  const file = link('plugin/cursor-acp.js', target);
  write('opencode.json', JSON.stringify({ plugin: ['./plugin/cursor-acp.js', './plugins/devryan-open-cursor.mjs'] }));
  const result = migrate();
  expect(result).toMatchObject({ ok: true, changed: true, removed: [file] });
  expect(fs.existsSync(file)).toBe(false);
  expect(fs.readFileSync(target)).toEqual(fixture);
  const record = result.backups.find((backup) => backup.endsWith('.link.json'));
  expect(JSON.parse(fs.readFileSync(record, 'utf8'))).toEqual({ link: target, target });
  expect(JSON.parse(fs.readFileSync(path.join(root, 'opencode.json'), 'utf8')).plugin).toEqual(['./plugins/devryan-open-cursor.mjs']);
  expect(migrate()).toMatchObject({ ok: true, changed: false, removed: [] });
});

test('retires the installer symlink into any open-cursor package version', () => {
  const target = packageEntry('a newer open-cursor release');
  const file = link('plugin/cursor-acp.js', path.relative(path.join(root, 'plugin'), target));
  expect(migrate()).toMatchObject({ ok: true, removed: [file] });
  expect(fs.readFileSync(target, 'utf8')).toBe('a newer open-cursor release');
});

test('retires a dangling installer symlink after the package was uninstalled', () => {
  const file = link('plugins/cursor-acp.js', path.join(root, 'gone/@rama_nigg/open-cursor/dist/plugin-entry.js'));
  expect(migrate()).toMatchObject({ ok: true, removed: [file] });
});

test('keeps a symlink to unrecognized code and its target untouched', () => {
  const target = write('mine/cursor.js', 'my own cursor plugin');
  const file = link('plugin/cursor-acp.js', target);
  const config = write('opencode.json', '{"plugin":["./plugin/cursor-acp.js"]}');
  const before = fs.readFileSync(config);
  expect(migrate()).toMatchObject({ ok: false, changed: false, conflicts: [file] });
  expect(fs.readlinkSync(file)).toBe(target);
  expect(fs.readFileSync(target, 'utf8')).toBe('my own cursor plugin');
  expect(fs.readFileSync(config)).toEqual(before);
  expect(migrate()).toMatchObject({ ok: false, conflicts: [file] });
  const dangling = link('plugins/cursor-acp.js', path.join(root, 'missing.js'));
  expect(migrate().conflicts).toContain(dangling);
});

test('resumes a symlink retirement from its link record', () => {
  const target = packageEntry(fixture);
  const file = link('plugin/cursor-acp.js', target);
  write('config.json', JSON.stringify({ plugin: ['./plugin/cursor-acp.js'] }));
  const interrupted = migrate({ ...fs, unlinkSync: (entry) => {
    if (entry === file) throw new Error('interrupted');
    return fs.unlinkSync(entry);
  } });
  expect(interrupted).toMatchObject({ ok: false, changed: true });
  expect(fs.lstatSync(file).isSymbolicLink()).toBe(true);
  expect(migrate()).toMatchObject({ ok: true, removed: [file] });
  write('config.json', JSON.stringify({ plugin: ['./plugin/cursor-acp.js', 'custom'] }));
  expect(migrate().ok).toBe(true);
  expect(JSON.parse(fs.readFileSync(path.join(root, 'config.json'), 'utf8')).plugin).toEqual(['custom']);
  expect(fs.readFileSync(target)).toEqual(fixture);
});

test('a user-confirmed retirement moves unrecognized copies to backups', () => {
  const custom = write('plugin/cursor-acp.js', 'custom implementation');
  const target = write('mine/cursor.js', 'my own cursor plugin');
  const linked = link('plugins/cursor-acp.js', target);
  write('opencode.json', '{"plugin":["./plugin/cursor-acp.js","./plugins/cursor-acp.js","kept"]}');
  const result = retireLegacyCursorPlugin({ configDirectory: root, hashContent: fixtureHash, userConfirmed: true });
  expect(result).toMatchObject({ ok: true, changed: true, removed: [custom, linked] });
  const byteBackup = result.backups.find((backup) => backup.endsWith('.disabled'));
  expect(byteBackup).toContain(hash(Buffer.from('custom implementation')));
  expect(fs.readFileSync(byteBackup, 'utf8')).toBe('custom implementation');
  expect(fs.readFileSync(target, 'utf8')).toBe('my own cursor plugin');
  expect(JSON.parse(fs.readFileSync(path.join(root, 'opencode.json'), 'utf8')).plugin).toEqual(['kept']);
});

test('never overwrites a damaged backup', () => {
  write('plugin/cursor-acp.js', fixture);
  const first = migrate();
  write('plugin/cursor-acp.js', fixture);
  fs.writeFileSync(first.backups[0], 'damaged');
  expect(migrate()).toMatchObject({ ok: false, changed: false });
  expect(fs.readFileSync(first.backups[0], 'utf8')).toBe('damaged');
});

test('resumes after configuration commit and an interrupted source removal', () => {
  const file = write('plugin/cursor-acp.js', fixture);
  write('config.json', JSON.stringify({ plugin: ['./plugin/cursor-acp.js'] }));
  const interrupted = migrate({ ...fs, unlinkSync: target => {
    if (target === file) throw new Error('interrupted');
    return fs.unlinkSync(target);
  } });
  expect(interrupted).toMatchObject({ ok: false, changed: true });
  expect(fs.readFileSync(interrupted.backups[0])).toEqual(fixture);
  expect(migrate()).toMatchObject({ ok: true, removed: [file] });
  // A stale config restored independently is reconciled from the verified backup.
  write('config.json', JSON.stringify({ plugin: ['./plugin/cursor-acp.js', 'custom'] }));
  expect(migrate().ok).toBe(true);
  expect(JSON.parse(fs.readFileSync(path.join(root, 'config.json'), 'utf8')).plugin).toEqual(['custom']);
});

test('a failed backup write is retryable without removing source or changing config', () => {
  const file = write('plugin/cursor-acp.js', fixture);
  const config = write('opencode.json', '{"plugin":["./plugin/cursor-acp.js"]}');
  const before = fs.readFileSync(config);
  const result = migrate({ ...fs, linkSync: () => { throw new Error('disk full'); } });
  expect(result.ok).toBe(false);
  expect(fs.readFileSync(file)).toEqual(fixture);
  expect(fs.readFileSync(config)).toEqual(before);
  expect(migrate().ok).toBe(true);
});

test('invalid configuration blocks retirement without destroying either file', () => {
  const file = write('plugin/cursor-acp.js', fixture);
  const config = write('opencode.jsonc', '{ invalid');
  expect(migrate()).toMatchObject({ ok: false, changed: false, conflicts: [config] });
  expect(fs.readFileSync(file)).toEqual(fixture);
});
