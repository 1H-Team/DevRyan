import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const changeRowSource = readFileSync(
  fileURLToPath(new URL('./ChangeRow.tsx', import.meta.url)),
  'utf8',
);

describe('ChangeRow responsive presentation', () => {
  test('shows only the filename in a consistently aligned, truncating label', () => {
    expect(changeRowSource).toContain(
      'min-w-0 flex-1 truncate typography-ui-label text-foreground',
    );
    expect(changeRowSource).toContain('{fileName}');
    expect(changeRowSource).not.toContain('directoryName');
    expect(changeRowSource).not.toContain('flex-row-reverse');
  });

  test('keeps the complete path available when the visible label truncates', () => {
    expect(changeRowSource).toContain('title={file.path}');
  });
});
