import assert from 'node:assert/strict';
import { test } from 'node:test';
import { assertCompiledAssetReply } from './compiled-process.mjs';

test('compiled asset proof rejects silent Photon fallback, wrong binary identity and missing native activation', () => {
  const reply = { protocol: 1, type: 'assets-verified', buildId: 'a'.repeat(64), parser: { bash: true, powershell: true },
    photon: { width: 1, height: 1, mime: 'image/png' }, ffi: { loaded: true },
    pty: { sha256: 'd333339292bb9f9a739dbce9e2ababbce81b3040ea3d064b8a9b359a1c05ab61', size: 42, executable: true } };
  assertCompiledAssetReply(reply, reply.buildId);
  for (const bad of [{ ...reply, photon: { available: false } }, { ...reply, buildId: 'b'.repeat(64) },
    { ...reply, ffi: { loaded: false } }, { ...reply, parser: { bash: true, powershell: false } },
    { ...reply, pty: { ...reply.pty, sha256: 'c'.repeat(64) } }]) assert.throws(() => assertCompiledAssetReply(bad, reply.buildId));
});
