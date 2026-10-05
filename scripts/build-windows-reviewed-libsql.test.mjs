import assert from 'node:assert/strict';
import test from 'node:test';
import { assertWindowsBinaryArchitecture } from './build-windows-reviewed-libsql.mjs';

test('native dependency architecture refuses foreign and truncated PE images', () => {
  const image = Buffer.alloc(128); image.write('MZ'); image.writeUInt32LE(64, 60); image.write('PE\0\0', 64, 'binary'); image.writeUInt16LE(0xaa64, 68);
  assert.doesNotThrow(() => assertWindowsBinaryArchitecture(image, 'arm64'));
  assert.throws(() => assertWindowsBinaryArchitecture(image, 'x64'), /differs from host/);
  for (const bytes of [image.subarray(0, 63), image.subarray(0, 69), Buffer.alloc(128)]) assert.throws(() => assertWindowsBinaryArchitecture(bytes, 'arm64'));
});
