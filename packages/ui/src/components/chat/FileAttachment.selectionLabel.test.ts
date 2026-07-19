import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

const source = readFileSync(new URL('./FileAttachment.tsx', import.meta.url), 'utf8');

describe('VS Code selection attachment labels', () => {
  test('uses the workspace-relative path instead of the basename', () => {
    expect(source).toContain("const normalizedRelativePath = relativePath.replace(/\\\\/g, '/') || fileName");
    expect(source).toContain('`${normalizedRelativePath}:${selectionRange}`');
    expect(source).not.toContain('`${fileName}:${selectionRange}`');
  });
});
