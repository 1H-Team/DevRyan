import { afterEach, expect, test, vi } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { CLAUDE_ASSET, CLAUDE_PACKAGE, CLAUDE_TEAM, claudeArchiveURL, downloadClaudeInstallation,
  extractClaudeArchive, readClaudeDownload, validateClaudeInstallation, newerClaude, probeClaudeProtocol } from './managed-claude-installation.js';

const roots = [];
afterEach(async () => { for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true }); });
const root = async () => { const value = await fs.mkdtemp(path.join(os.tmpdir(), 'claude-install-test-')); roots.push(value); return value; };
function archiveOf(entries) {
  const records = [];
  for (const { name, bytes, type = '0' } of entries) {
    const header = Buffer.alloc(512);
    header.write(name, 0, 100); header.write('0000755\0', 100); header.write(bytes.length.toString(8).padStart(11, '0') + '\0', 124);
    header.fill(32, 148, 156); header.write(type, 156);
    header.write(header.reduce((sum, byte) => sum + byte, 0).toString(8).padStart(6, '0') + '\0 ', 148);
    records.push(header, bytes, Buffer.alloc((512 - bytes.length % 512) % 512));
  }
  const archive = gzipSync(Buffer.concat([...records, Buffer.alloc(1024)]));
  return { archive, integrity: 'sha512-' + createHash('sha512').update(archive).digest('base64') };
}
const binary = () => { const bytes = Buffer.alloc(64); bytes.writeUInt32LE(0xfeedfacf, 0); bytes.writeUInt32LE(0x0100000c, 4); return bytes; };
test('protocol preflight sends only initialization and waits for process termination', async () => {
  for (const success of [true, false]) {
    const child = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), kill: vi.fn() });
    const spawn = vi.fn(() => child);
    let settled = false;
    const result = probeClaudeProtocol('/private/claude', { cwd: '/isolated', env: { HOME: '/isolated' } }, spawn)
      .then(() => { settled = true; return 'ready'; }, error => { settled = true; return error.code; });
    const request = JSON.parse(child.stdin.read().toString());
    expect(request.type).toBe('control_request');
    expect(request.request.subtype).toBe('initialize');
    expect(spawn.mock.calls[0][0]).toBe('/usr/bin/sandbox-exec');
    expect(spawn.mock.calls[0][1][1]).toContain('(deny network*)');
    child.stdout.write(JSON.stringify({ type: 'control_response', response: { request_id: request.request_id,
      subtype: success ? 'success' : 'error', response: {} } }) + '\n');
    await Promise.resolve();
    expect(settled).toBe(false);
    expect(child.kill).toHaveBeenCalledWith('SIGTERM');
    child.emit('close', 0);
    expect(await result).toBe(success ? 'ready' : 'claude_protocol_unavailable');
    child.stdin.destroy(); child.stdout.destroy(); child.stderr.destroy();
  }
});
test('future official versions install without a compiled hash or version allowlist', async () => {
  const directory = await root(), version = '9.4.123', bytes = binary();
  const { archive, integrity } = archiveOf([{ name: 'package/claude', bytes }]);
  const fetchImpl = vi.fn(async url => url === claudeArchiveURL(version) ? new Response(archive) : Response.json({
    name: CLAUDE_PACKAGE, version, dist: { tarball: claudeArchiveURL(version), integrity } }));
  const preflight = vi.fn(async () => {});
  const record = await downloadClaudeInstallation({ directory, version, fetchImpl, verifyPublisher: async () => 'a'.repeat(40), preflight });
  expect(record).toMatchObject({ version, package: CLAUDE_PACKAGE, signatureTeamID: CLAUDE_TEAM, size: bytes.length });
  expect(await fs.readFile(path.join(directory, CLAUDE_ASSET))).toEqual(bytes);
  expect(preflight).toHaveBeenCalledWith(path.join(directory, CLAUDE_ASSET), version);
  expect(fetchImpl.mock.calls.every(([, options]) => options.redirect === 'error' && options.credentials === 'omit')).toBe(true);
  expect(validateClaudeInstallation(record, { path: CLAUDE_ASSET, sha256: record.sha256, size: record.size, mode: 0o755,
    signing: { mode: 'release', teamID: CLAUDE_TEAM, cdhash: record.cdhash } })).toBe(record);
});
test('corrupt archives, wrong architecture, traversal, duplicate executable and links refuse', () => {
  const valid = archiveOf([{ name: 'package/claude', bytes: binary() }]);
  expect(() => extractClaudeArchive(Buffer.from('corrupt'), valid.integrity)).toThrow('claude_archive_integrity');
  for (const entries of [
    [{ name: 'package/claude', bytes: Buffer.alloc(64) }],
    [{ name: '../claude', bytes: binary() }],
    [{ name: 'package/claude', bytes: binary() }, { name: 'package/claude', bytes: binary() }],
    [{ name: 'package/claude', bytes: binary(), type: '2' }],
  ]) {
    const { archive, integrity } = archiveOf(entries);
    expect(() => extractClaudeArchive(archive, integrity)).toThrow();
  }
});
test('bounded downloads reject failures, oversized declarations and oversized streams', async () => {
  for (const response of [new Response('', { status: 503 }), new Response('ok', { headers: { 'content-length': '10' } }), new Response('12345')]) {
    await expect(readClaudeDownload('fixture', 4, { fetchImpl: async () => response })).rejects.toThrow();
  }
});
test('foreign URLs and package identities cannot supply a candidate', async () => {
  for (const change of [{ name: 'other' }, { version: '3.0.1' }, { dist: { tarball: 'https://evil.test/claude', integrity: 'sha512-' + 'a'.repeat(86) + '==' } }]) {
    const directory = await root();
    await expect(downloadClaudeInstallation({ directory, version: '3.0.0', fetchImpl: async () => Response.json({ name: CLAUDE_PACKAGE,
      version: '3.0.0', dist: { tarball: claudeArchiveURL('3.0.0'), integrity: 'sha512-' + 'a'.repeat(86) + '==' }, ...change }) })).rejects.toThrow('claude_metadata_invalid');
    expect(await fs.readdir(directory)).toEqual([]);
  }
});
test('signature and protocol failures remove the staged executable', async () => {
  for (const phase of ['signature', 'protocol']) {
    const directory = await root(), version = '3.0.0', { archive, integrity } = archiveOf([{ name: 'package/claude', bytes: binary() }]);
    await expect(downloadClaudeInstallation({ directory, version,
      fetchImpl: async url => url === claudeArchiveURL(version) ? new Response(archive) : Response.json({ name: CLAUDE_PACKAGE, version, dist: { tarball: claudeArchiveURL(version), integrity } }),
      verifyPublisher: async () => { if (phase === 'signature') throw new Error('publisher'); return 'a'.repeat(40); },
      preflight: async () => { throw new Error('protocol'); },
    })).rejects.toThrow(phase === 'signature' ? 'publisher' : 'protocol');
    expect(await fs.readdir(directory)).toEqual([]);
  }
});
test('version ordering is numeric and never treats prereleases or equal releases as newer', () => {
  expect(newerClaude('2.1.302', '2.1.99')).toBe(true);
  expect(newerClaude('2.1.302', '2.1.302')).toBe(false);
  expect(newerClaude('2.1.302-beta', '2.1.301')).toBe(false);
  expect(newerClaude('2.1.302', '3.0.0')).toBe(false);
});
