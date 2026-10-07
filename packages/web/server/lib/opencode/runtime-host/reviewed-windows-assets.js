import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {createHash} from 'node:crypto';

export const REVIEWED_WINDOWS_EXECUTABLES = Object.freeze({
  x64: Object.freeze({
    ast: Object.freeze({ package: '@ast-grep/cli-win32-x64-msvc', version: '0.45.3', member: 'package/ast-grep.exe', size: 51400704,
      integrity: 'sha512-UZrpVbjLQqQIRxWqeMcwyLSIhlDZyhYb8SinssM38Oo6mEB2jMfHCEoigay9UOZTfUR268n72BBV48nW2h+QwA==', sha256: 'daff0f5963faab7617045833132a3538c85eee65f3afeedf347f829a7b8d83fb' }),
    claude: Object.freeze({ package: '@anthropic-ai/claude-code-win32-x64', version: '2.1.251', member: 'package/claude.exe', size: 217360032,
      integrity: 'sha512-fVXAvS2lCMJWD/lcyzzai5pcDQnlldGl8pwyGQ2vBxcuF8LS/7nVDqLOqTZsoAJ+VDKnlkPlPOJytDQEhTHHMQ==', sha256: '8d1229a281281b98fd2dee72b3253a704be4fce4d45207200cd32a9bb5a6c909' }),
  }),
  arm64: Object.freeze({
    ast: Object.freeze({ package: '@ast-grep/cli-win32-arm64-msvc', version: '0.45.3', member: 'package/ast-grep.exe', size: 50103808,
      integrity: 'sha512-X0+81Mgr8zsH6hu4Pqdr5h1IyAFUWbKS1PMkKT6awYiiTo/1uhVM/6WzJ+ohOQPmMTyt4poyyg46u2E4WzKECg==', sha256: '8b881d2e98c303f0f90ad6d2a9422dfe89ab32552873a49c7f35899138e813b7' }),
    claude: Object.freeze({ package: '@anthropic-ai/claude-code-win32-arm64', version: '2.1.251', member: 'package/claude.exe', size: 208465056,
      integrity: 'sha512-6hkf7WoAk74WJuQ/epE+GKy5SJ7RU7kcpy3PRFHt6E1tiYNscihfZY1TMQ+AMQsDo1iFQFHbGITR95+vr3at+w==', sha256: '89e91fed2dc6f6278fa1e179e6401c0a1c252fe80c57ee47f17f10f7f7b4e99c' }),
  }),
});
export const REVIEWED_WINDOWS_LIBSQL_COMMIT = '55bee86d1c284f1ddf2b9e280e870d2b6cef884a';
export const REVIEWED_WINDOWS_LIBSQL_INPUTS = Object.freeze({
  'Cargo.toml': 'cf729f40413e3131258e98579ab760b2e75238255cd56729ebb65b4f410ea953',
  'Cargo.lock': '897f93398893ce805b389b482ddf7555b75365a5f48a2e345703f21c1c58d74e',
  'rust-toolchain.toml': 'df9ff8a9ca1dcbadc9b912fa46d0e99d20f2e3695a4fa4c009df5f02b44bece8',
  'package.json': '9b38bb06405f07a6c7458bd3e821e3bebae0b19b4c6cd8b08607f36916228e50',
});

export function assertWindowsBinaryArchitecture(bytes, arch) {
  assert.ok(bytes.length >= 64 && bytes.toString('ascii', 0, 2) === 'MZ', 'Windows binary header missing');
  const offset = bytes.readUInt32LE(60);
  assert.ok(offset >= 64 && offset + 6 <= bytes.length && bytes.toString('binary', offset, offset + 4) === 'PE\0\0', 'Windows PE header invalid');
  assert.ok(arch === 'x64' || arch === 'arm64', 'Windows architecture unsupported');
  assert.equal(bytes.readUInt16LE(offset + 4), arch === 'arm64' ? 0xaa64 : 0x8664, 'Windows binary architecture differs from host');
}

export const REVIEWED_WINDOWS_LIBSQL_EVIDENCE = 'DevRyan-libsql-source-evidence.json';

// Source and ABI evidence authenticates a resource, never runtime admission.
export function verifyWindowsLibsqlEvidence(evidence, arch) {
  assert.ok(arch === 'x64' || arch === 'arm64', 'Windows architecture unsupported');
  const target = `${arch === 'arm64' ? 'aarch64' : 'x86_64'}-pc-windows-msvc`;
  assert.equal(evidence.schema, 1); assert.equal(evidence.status, 'asset-candidate-passed');
  assert.equal(evidence.stage, 'complete'); assert.equal(evidence.version, '0.5.29');
  assert.equal(evidence.sourceCommit, REVIEWED_WINDOWS_LIBSQL_COMMIT); assert.equal(evidence.target, target);
  assert.equal(evidence.toolchain, `1.85.1-${target}`); assert.equal(evidence.cmakeGenerator, 'NMake Makefiles');
  assert.deepEqual(evidence.inputs, REVIEWED_WINDOWS_LIBSQL_INPUTS); assert.deepEqual(evidence.inputSha256, REVIEWED_WINDOWS_LIBSQL_INPUTS);
  assert.ok(Array.isArray(evidence.smokes) && evidence.smokes.length === 2);
  for (const [index, runtime] of ['node', 'bun'].entries()) {
    const probe = evidence.smokes[index];
    assert.equal(probe.status, 'passed'); assert.equal(probe.platform, 'win32');
    assert.equal(probe.arch, arch); assert.equal(probe.runtime, runtime);
    assert.ok(typeof probe.version === 'string' && (runtime === 'bun' ? probe.version === '1.3.14' : /^22\./.test(probe.version)));
  }
  assert.equal(evidence.binary, `DevRyan-libsql-win32-${arch}.node`);
  assert.match(evidence.sha256, /^[a-f0-9]{64}$/);
  return evidence;
}

/** Classify only this architecture's original assets; unknown assets grant nothing. */
export function reviewedWindowsRuntimeAsset(file, arch) {
  const pins = REVIEWED_WINDOWS_EXECUTABLES[arch];
  assert.ok(pins && Object.hasOwn(REVIEWED_WINDOWS_EXECUTABLES, arch), 'Windows architecture unsupported');
  const kind = file.path === `DevRyan-ast-grep-win32-${arch}.exe` ? 'ast'
    : file.path === `DevRyan-Claude-win32-${arch}.exe` ? 'claude'
    : file.path === `DevRyan-libsql-win32-${arch}.node` ? 'libsql'
    : file.path === REVIEWED_WINDOWS_LIBSQL_EVIDENCE ? 'evidence' : null;
  if (!kind) return null;
  assert.equal(file.role, 'asset'); assert.equal(file.signing?.mode, 'unsigned');
  assert.equal(file.mode, kind === 'ast' || kind === 'claude' ? 0o755 : 0o644);
  if (kind === 'ast' || kind === 'claude') {
    assert.equal(file.sha256, pins[kind].sha256); assert.equal(file.size, pins[kind].size);
  } else if (kind === 'evidence') assert.ok(file.size > 0 && file.size <= 65536);
  return kind;
}

/** Parse only the bounded bytes bound by the manifest, not a later path read. */
export async function readWindowsLibsqlEvidence(file, row, arch) {
  assert.ok(Number.isSafeInteger(row.size) && row.size > 0 && row.size <= 65536);
  assert.match(row.sha256, /^[a-f0-9]{64}$/);
  const handle = await fs.open(file, 'r');
  try {
    const before = await handle.stat();
    assert.ok(before.isFile() && before.nlink === 1 && before.size === row.size);
    const bytes = Buffer.alloc(row.size + 1); let length = 0;
    while (length < bytes.length) {
      const {bytesRead} = await handle.read(bytes, length, bytes.length - length, length);
      if (!bytesRead) break;
      length += bytesRead;
    }
    assert.equal(length, row.size);
    const after = await handle.stat();
    for (const key of ['dev', 'ino', 'size', 'mtimeMs', 'ctimeMs']) assert.equal(after[key], before[key]);
    const exact = bytes.subarray(0, length);
    assert.equal(createHash('sha256').update(exact).digest('hex'), row.sha256);
    return verifyWindowsLibsqlEvidence(JSON.parse(exact.toString('utf8')), arch);
  } finally { await handle.close(); }
}
