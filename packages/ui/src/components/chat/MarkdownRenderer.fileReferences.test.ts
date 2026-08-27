import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

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

  test('keeps Bot markdown independent from the OpenCode directory provider', () => {
    const source = readFileSync(new URL('./MarkdownRendererImpl.tsx', import.meta.url), 'utf8');
    const rendererBranch = source.slice(
      source.indexOf('const MarkdownRendererImpl'),
      source.indexOf('export const MarkdownRenderer ='),
    );
    const simpleRendererBranch = source.slice(
      source.indexOf('const SimpleMarkdownRendererImpl'),
      source.indexOf('export const SimpleMarkdownRenderer ='),
    );

    expect(rendererBranch).toContain('props.enableFileReferences === false');
    expect(rendererBranch).toContain('<MarkdownRendererContent {...props} effectiveDirectory="" />');
    expect(rendererBranch.indexOf('enableFileReferences === false')).toBeLessThan(
      rendererBranch.indexOf('<MarkdownRendererWithDirectory {...props} />'),
    );
    expect(simpleRendererBranch).toContain('props.enableFileReferences === false');
    expect(simpleRendererBranch).toContain('<SimpleMarkdownRendererContent {...props} effectiveDirectory="" />');
    expect(source).toContain('prev.enableFileReferences === next.enableFileReferences');
  });
});
