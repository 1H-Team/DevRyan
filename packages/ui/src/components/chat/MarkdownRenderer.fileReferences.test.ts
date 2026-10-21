import { describe, expect, test } from 'bun:test';

import {
  __testFileReferenceHelpers,
} from './fileReferenceHelpers';

describe('MarkdownRenderer file reference helpers', () => {
  test('rejects numeric-only extension tokens from utility classes', () => {
    expect(__testFileReferenceHelpers.isLikelyFilePath('p-0.5')).toBe(false);
    expect(__testFileReferenceHelpers.isLikelyFilePath('bottom-0.5 right-0.5')).toBe(false);
  });

  test('rejects whitespace-containing command strings', () => {
    expect(__testFileReferenceHelpers.isLikelyFilePath(
      'bun test packages/ui/src/components/chat/message/parts/UserTextPart.test.ts',
    )).toBe(false);
  });

  test('keeps normal source paths, dotfiles, and known basenames linkable', () => {
    expect(__testFileReferenceHelpers.isLikelyFilePath('packages/ui/src/components/chat/MarkdownRendererImpl.tsx')).toBe(true);
    expect(__testFileReferenceHelpers.isLikelyFilePath('.gitignore')).toBe(true);
    expect(__testFileReferenceHelpers.isLikelyFilePath('README')).toBe(true);
  });

  test('builds optional scoped stat requests for file reference probes', () => {
    const request = __testFileReferenceHelpers.buildFileReferenceStatRequest(
      '/repo/src/index.ts',
      '/repo',
    );

    expect(request).toEqual({
      path: '/repo/src/index.ts',
      options: {
        directory: '/repo',
        optional: true,
      },
    });
  });
});
