import { describe, expect, test } from 'vitest';
import { readFileSync } from 'node:fs';

const extensionSource = readFileSync(new URL('./extension.ts', import.meta.url), 'utf8');
const providerSource = readFileSync(new URL('./ChatViewProvider.ts', import.meta.url), 'utf8');

describe('VS Code workspace-relative selection names', () => {
  test('keeps every editor command relative to one workspace root', () => {
    const editorCommandPaths = extensionSource.match(/asRelativePath\(editor\.document\.uri,[^)]+\)/g) ?? [];
    expect(editorCommandPaths.length).toBe(3);
    expect(editorCommandPaths.every((value) => value.endsWith(', false)'))).toBe(true);
  });

  test('normalizes active-editor relative paths to forward slashes', () => {
    expect(providerSource).toContain("asRelativePath(editor.document.uri, false).replace(/\\\\/g, '/')");
  });
});
