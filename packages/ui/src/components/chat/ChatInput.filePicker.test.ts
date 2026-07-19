import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

const source = readFileSync(new URL('./ChatInput.tsx', import.meta.url), 'utf8');

describe('ChatInput file picker ownership', () => {
  test('mounts one stable file input outside responsive attachment controls', () => {
    expect(source.match(/data-composer-file-input="true"/g)?.length).toBe(1);
    expect(source.match(/type="file"/g)?.length).toBe(1);
    expect(source).not.toContain('fileInputRef: React.RefObject');
    expect(source).not.toContain('handleLocalFileSelect: (event: React.ChangeEvent');
  });

  test('resets the input after processing so the same file can be selected again', () => {
    expect(source).toContain("event.target.value = ''");
  });
});
