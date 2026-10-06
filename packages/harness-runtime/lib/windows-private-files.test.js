import { test, expect } from 'bun:test';
import { parseWindowsFileIdentity } from './windows-private-files.js';

test('Windows identity receipts reject guessed, widened and malformed shapes', () => {
  const identity = { protocol: 'devryan.windows-file-identity/1', volume: '0123456789abcdef',
    fileId: '0123456789abcdef0123456789abcdef', type: 'file', reparsePoint: false,
    linkCount: 1, currentOwner: true, privateAcl: true };
  expect(parseWindowsFileIdentity(JSON.stringify(identity))).toEqual(identity);
  for (const changed of [{ extra: true }, { protocol: 'other' }, { volume: null }, { volume: 1234567890123456 },
    { fileId: 'short' }, { fileId: [identity.fileId] },
    { type: 'symlink' }, { reparsePoint: 0 }, { currentOwner: 'true' }, { privateAcl: null },
    { linkCount: 0 }, { linkCount: 1.5 }, { linkCount: Number.MAX_SAFE_INTEGER + 1 }]) {
    expect(() => parseWindowsFileIdentity(JSON.stringify({ ...identity, ...changed }))).toThrow('private_windows_file_unverified');
  }
  for (const raw of ['null', '[]', '{}', '{', ' '.repeat(4097)]) {
    expect(() => parseWindowsFileIdentity(raw)).toThrow('private_windows_file_unverified');
  }
});
