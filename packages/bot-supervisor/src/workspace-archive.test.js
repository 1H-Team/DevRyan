import { describe, expect, test } from 'bun:test';

import {
  BOT_WORKSPACE_FILE_MAX_BYTES,
  buildBotResourceFileArchive,
  buildBotSharedFileArchive,
  buildBotWorkspaceFileArchive,
  normalizeBotWorkspaceFile,
} from './workspace-archive.js';

const readOctal = (buffer, offset, length) => Number.parseInt(
  buffer.subarray(offset, offset + length).toString('ascii').replace(/[\0 ]+$/u, ''),
  8,
);

describe('Bot workspace file archives', () => {
  test('builds one deterministic non-executable ustar file owned by the Bot user', () => {
    const result = buildBotWorkspaceFileArchive({
      path: 'approval-check.txt',
      content: 'BOT_APPROVAL_OK',
    });

    expect(result.path).toBe('approval-check.txt');
    expect(result.bytes).toBe(15);
    expect(result.sha256).toBe('887d2d4bb547561d54e01ded904df1d98685cfbe4e3959ef115a84919d20f4f1');
    expect(result.archive.byteLength % 512).toBe(0);
    expect(result.archive.subarray(0, 18).toString('ascii')).toBe('approval-check.txt');
    expect(readOctal(result.archive, 100, 8)).toBe(0o600);
    expect(readOctal(result.archive, 108, 8)).toBe(10001);
    expect(readOctal(result.archive, 116, 8)).toBe(10001);
    expect(readOctal(result.archive, 124, 12)).toBe(15);
    expect(result.archive.subarray(512, 527).toString('utf8')).toBe('BOT_APPROVAL_OK');
    expect(result.archive.subarray(-1024).every((byte) => byte === 0)).toBe(true);

    const header = Buffer.from(result.archive.subarray(0, 512));
    const storedChecksum = readOctal(header, 148, 8);
    header.fill(0x20, 148, 156);
    expect([...header].reduce((sum, byte) => sum + byte, 0)).toBe(storedChecksum);
  });

  test('accepts only one bounded top-level file and never traversal or internal mounts', () => {
    for (const path of ['../secret', 'folder/file.txt', '.devryan', '.opencode', 'bad\\name']) {
      expect(() => normalizeBotWorkspaceFile({ path, content: 'safe' })).toThrow();
    }
    expect(() => normalizeBotWorkspaceFile({
      path: 'large.txt',
      content: 'a'.repeat(BOT_WORKSPACE_FILE_MAX_BYTES + 1),
    })).toThrow();
    expect(normalizeBotWorkspaceFile({ path: 'safe.txt', content: '' }).path).toBe('safe.txt');
  });

  test('builds a binary-safe deterministic Shared archive and verifies source integrity', () => {
    const bytes = Buffer.from([0, 1, 2, 255]);
    const result = buildBotSharedFileArchive({
      channelId: 'c0000000-0000-4000-8000-000000000001',
      messageId: 'd0000000-0000-4000-8000-000000000001',
      filename: 'fixture.bin',
      contentBase64: bytes.toString('base64'),
      expectedSize: bytes.byteLength,
      sha256: '3d1f57c984978ef98a18378c8166c1cb8ede02c03eeb6aee7e2f121dfeee3e56',
    });
    expect(result.path).toBe(
      'c0000000-0000-4000-8000-000000000001/d0000000-0000-4000-8000-000000000001/fixture.bin',
    );
    expect(result.archive.subarray(0, 37).toString('ascii')).toBe(
      'c0000000-0000-4000-8000-000000000001/',
    );
    expect(result.archive[156]).toBe(0x35);
    expect(readOctal(result.archive, 100, 8)).toBe(0o700);
    expect(readOctal(result.archive, 108, 8)).toBe(10001);
    expect(result.archive.subarray(512, 549).toString('ascii')).toBe(
      'd0000000-0000-4000-8000-000000000001/',
    );
    expect(result.archive[512 + 156]).toBe(0x35);
    expect(result.archive.subarray(1024, 1035).toString('ascii')).toBe('fixture.bin');
    expect(result.archive.subarray(1024 + 345, 1024 + 418).toString('ascii')).toBe(
      'c0000000-0000-4000-8000-000000000001/d0000000-0000-4000-8000-000000000001',
    );
    expect(result.archive.subarray(1536, 1540)).toEqual(bytes);
    expect(() => buildBotSharedFileArchive({
      channelId: 'c0000000-0000-4000-8000-000000000001',
      messageId: 'd0000000-0000-4000-8000-000000000001',
      filename: '../fixture.bin',
      contentBase64: bytes.toString('base64'),
      expectedSize: bytes.byteLength,
      sha256: '3d1f57c984978ef98a18378c8166c1cb8ede02c03eeb6aee7e2f121dfeee3e56',
    })).toThrow();
  });

  test('builds a bounded Resources archive without allowing traversal or internal mounts', () => {
    const bytes = Buffer.from('Operations handbook', 'utf8');
    const sha256 = '806641856668f898c0205e244393ec655e1ac9094ec0a1f520ec487ec3d6ca16';
    const result = buildBotResourceFileArchive({
      resourcePath: 'manuals/start.txt',
      contentBase64: bytes.toString('base64'),
      expectedSize: bytes.byteLength,
      sha256,
    });

    expect(result).toMatchObject({
      path: 'Resources/manuals/start.txt',
      filename: 'start.txt',
      bytes: bytes.byteLength,
      sha256,
    });
    expect(result.archive.subarray(0, 10).toString('ascii')).toBe('Resources/');
    expect(result.archive[156]).toBe(0x35);
    expect(result.archive.subarray(512, 520).toString('ascii')).toBe('manuals/');
    expect(result.archive.subarray(512 + 345, 512 + 354).toString('ascii')).toBe('Resources');
    expect(result.archive.subarray(1024, 1033).toString('ascii')).toBe('start.txt');
    expect(result.archive.subarray(1024 + 345, 1024 + 362).toString('ascii')).toBe('Resources/manuals');
    expect(result.archive.subarray(1536, 1536 + bytes.byteLength)).toEqual(bytes);

    for (const resourcePath of ['../secret.txt', 'manuals/.opencode/config', 'manuals/bad name.txt']) {
      expect(() => buildBotResourceFileArchive({
        resourcePath,
        contentBase64: bytes.toString('base64'),
        expectedSize: bytes.byteLength,
        sha256,
      })).toThrow();
    }
  });
});
