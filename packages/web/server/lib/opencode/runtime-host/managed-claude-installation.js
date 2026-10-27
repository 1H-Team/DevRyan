import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';

const exec = promisify(execFile);
export const CLAUDE_PACKAGE = '@anthropic-ai/claude-code-darwin-arm64';
export const CLAUDE_ASSET = 'DevRyan-Claude-darwin-arm64';
export const CLAUDE_TEAM = 'Q6L2SF6YDW';
export const stableClaudeVersion = value => typeof value === 'string' && /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(value);
export const claudeFailure = code => Object.assign(new Error(code), { code, status: 503 });
export const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
export const claudeArchiveURL = version => `https://registry.npmjs.org/${CLAUDE_PACKAGE}/-/claude-code-darwin-arm64-${version}.tgz`;
export const newerClaude = (left, right) => {
  if (!stableClaudeVersion(left) || !stableClaudeVersion(right)) return false;
  const a = left.split('.').map(Number), b = right.split('.').map(Number);
  return a.some((value, index) => value > b[index] && a.slice(0, index).every((previous, i) => previous === b[i]));
};

export function validateClaudeInstallation(record, file) {
  if (!record || record.schema !== 1 || record.package !== CLAUDE_PACKAGE || !stableClaudeVersion(record.version)
    || record.platform !== 'darwin-arm64' || record.archiveUrl !== claudeArchiveURL(record.version)
    || !/^sha512-[A-Za-z0-9+/]{86}==$/.test(record.archiveIntegrity ?? '')
    || record.signatureTeamID !== CLAUDE_TEAM || !/^[a-f0-9]{40,64}$/.test(record.cdhash ?? '')
    || !/^[a-f0-9]{64}$/.test(record.sha256 ?? '') || !Number.isSafeInteger(record.size) || record.size < 32 || record.size > 384 * 1024 * 1024
    || file && (file.path !== CLAUDE_ASSET || file.sha256 !== record.sha256 || file.size !== record.size || file.mode !== 0o755
      || file.signing?.mode !== 'release' || file.signing.teamID !== CLAUDE_TEAM || file.signing.cdhash !== record.cdhash)) {
    throw claudeFailure('claude_installation_invalid');
  }
  return record;
}

export async function readClaudeDownload(url, maxBytes, { fetchImpl = fetch, timeout = 120000 } = {}) {
  const response = await fetchImpl(url, { credentials: 'omit', redirect: 'error', signal: AbortSignal.timeout(timeout) });
  if (!response.ok || !response.body || Number(response.headers.get('content-length')) > maxBytes) throw claudeFailure('claude_download_failed');
  const reader = response.body.getReader(), chunks = []; let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read(); if (done) break;
      size += value.byteLength;
      if (size > maxBytes) throw claudeFailure('claude_download_too_large');
      chunks.push(value);
    }
    return Buffer.concat(chunks, size);
  } finally { await reader.cancel().catch(() => {}); }
}

/** Extract exactly one regular executable; never materialize archive paths or links. */
export function extractClaudeArchive(archive, integrity) {
  if (typeof integrity !== 'string' || integrity !== 'sha512-' + createHash('sha512').update(archive).digest('base64')) throw claudeFailure('claude_archive_integrity');
  const tar = gunzipSync(archive, { maxOutputLength: 400 * 1024 * 1024 });
  let binary;
  for (let offset = 0; offset + 512 <= tar.length;) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every(byte => byte === 0)) break;
    const field = (start, end) => header.subarray(start, end).toString('utf8').replace(/\0.*$/s, '');
    const name = field(0, 100), prefix = field(345, 500), type = field(156, 157);
    const length = field(124, 136).trim(), checksum = field(148, 156).trim();
    const sum = header.reduce((total, byte, index) => total + (index >= 148 && index < 156 ? 32 : byte), 0);
    if (!/^[0-7]+$/.test(length) || !/^[0-7]+$/.test(checksum) || parseInt(checksum, 8) !== sum
      || prefix || !name || name.startsWith('/') || name.split('/').some(part => part === '..' || part === '.')
      || /[\\\u0000-\u001f]/.test(name) || !['', '0', '5'].includes(type)) throw claudeFailure('claude_archive_invalid');
    const size = parseInt(length, 8), start = offset + 512;
    if (!Number.isSafeInteger(size) || start + size > tar.length) throw claudeFailure('claude_archive_invalid');
    if (name === 'package/claude') {
      if (binary || type === '5' || size < 32 || size > 384 * 1024 * 1024) throw claudeFailure('claude_archive_invalid');
      binary = tar.subarray(start, start + size);
    }
    offset = start + Math.ceil(size / 512) * 512;
  }
  if (!binary || binary.readUInt32LE(0) !== 0xfeedfacf || binary.readUInt32LE(4) !== 0x0100000c) throw claudeFailure('claude_architecture_invalid');
  return binary;
}

export async function verifyClaudePublisher(file) {
  await exec('/usr/bin/codesign', ['--verify', '--strict', '-R', `=anchor apple generic and certificate leaf[subject.OU] = "${CLAUDE_TEAM}"`, file], { timeout: 15000, maxBuffer: 65536 });
  const { stderr } = await exec('/usr/bin/codesign', ['-d', '--verbose=4', file], { timeout: 15000, maxBuffer: 65536 });
  const cdhash = /^CDHash=([a-f0-9]{40,64})$/m.exec(stderr)?.[1];
  if (!cdhash || /^TeamIdentifier=(.+)$/m.exec(stderr)?.[1] !== CLAUDE_TEAM) throw claudeFailure('claude_publisher_invalid');
  return cdhash;
}

/** Negotiate the SDK control channel with no prompt, network, settings, or Keychain access. */
export function probeClaudeProtocol(file, { cwd, env }, spawnImpl = spawn) {
  return new Promise((resolve, reject) => {
    const child = spawnImpl('/usr/bin/sandbox-exec', ['-p',
      '(version 1)(allow default)(deny network*)(deny process-exec (literal "/usr/bin/security"))',
      file, '--print', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose',
      '--setting-sources', '', '--tools', '', '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}'],
    { cwd, env, stdio: ['pipe', 'pipe', 'pipe'] });
    let buffer = '', size = 0, accepted = false, failed = false, escalation;
    const stop = () => {
      child.kill('SIGTERM');
      escalation ??= setTimeout(() => child.kill('SIGKILL'), 1000);
    };
    const timer = setTimeout(() => { failed = true; stop(); }, 20000);
    const finish = error => {
      clearTimeout(timer); clearTimeout(escalation);
      if (error || failed || !accepted) reject(claudeFailure('claude_protocol_unavailable')); else resolve();
    };
    child.once('error', finish);
    child.once('close', () => finish());
    child.stdin.on('error', () => { failed = true; stop(); });
    child.stderr.on('data', chunk => { size += chunk.length; if (size > 1024 * 1024) { failed = true; stop(); } });
    child.stdout.on('data', chunk => {
      size += chunk.length;
      if (size > 1024 * 1024) { failed = true; stop(); return; }
      buffer += chunk.toString('utf8');
      let newline;
      while ((newline = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1);
        try {
          const value = JSON.parse(line);
          if (value.type === 'control_response' && value.response?.request_id === 'devryan-preflight') {
            accepted = value.response.subtype === 'success' && value.response.response !== null && typeof value.response.response === 'object';
            if (!accepted) failed = true;
            stop();
          }
        } catch { failed = true; stop(); }
      }
    });
    child.stdin.write(JSON.stringify({ type: 'control_request', request_id: 'devryan-preflight', request: { subtype: 'initialize', hooks: {}, sdkMcpServers: [] } }) + '\n');
  });
}

export async function preflightClaude(file, version) {
  const home = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), 'devryan-claude-preflight-'));
  try {
    const env = { PATH: '/usr/bin:/bin', HOME: home, TMPDIR: home, CLAUDE_CONFIG_DIR: home,
      DISABLE_AUTOUPDATER: '1', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1' };
    const options = { cwd: home, env, timeout: 20000, maxBuffer: 256 * 1024 };
    const result = await exec(file, ['--version'], options);
    if (result.stdout.trim() !== `${version} (Claude Code)`) throw claudeFailure('claude_version_invalid');
    const help = await exec(file, ['--help'], options);
    for (const flag of ['--input-format', '--output-format', '--resume', '--permission-mode']) {
      if (!help.stdout.includes(flag)) throw claudeFailure('claude_protocol_unavailable');
    }
    await probeClaudeProtocol(file, options);
  } finally { await fs.rm(home, { recursive: true, force: true }); }
}

/** Shared by packaged fallback hydration and the host updater. No user credentials. */
export async function downloadClaudeInstallation({ directory, version, fetchImpl = fetch, verifyPublisher = verifyClaudePublisher, preflight = preflightClaude, onPhase = () => {} }) {
  if (!stableClaudeVersion(version)) throw claudeFailure('claude_version_invalid');
  onPhase('downloading');
  const metadata = JSON.parse((await readClaudeDownload(`https://registry.npmjs.org/@anthropic-ai%2Fclaude-code-darwin-arm64/${version}`, 256 * 1024, { fetchImpl, timeout: 10000 })).toString());
  if (metadata.name !== CLAUDE_PACKAGE || metadata.version !== version || metadata.dist?.tarball !== claudeArchiveURL(version)
    || !/^sha512-[A-Za-z0-9+/]{86}==$/.test(metadata.dist?.integrity ?? '')) throw claudeFailure('claude_metadata_invalid');
  const archive = await readClaudeDownload(metadata.dist.tarball, 160 * 1024 * 1024, { fetchImpl });
  onPhase('checking');
  const binary = extractClaudeArchive(archive, metadata.dist.integrity), file = path.join(directory, CLAUDE_ASSET);
  await fs.writeFile(file, binary, { flag: 'wx', mode: 0o755 });
  try {
    const cdhash = await verifyPublisher(file);
    await preflight(file, version);
    return validateClaudeInstallation({ schema: 1, package: CLAUDE_PACKAGE, version, platform: 'darwin-arm64',
      archiveUrl: metadata.dist.tarball, archiveIntegrity: metadata.dist.integrity, sha256: sha256(binary), size: binary.length,
      signatureTeamID: CLAUDE_TEAM, cdhash });
  } catch (error) { await fs.rm(file, { force: true }); throw error; }
}
