import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const source = readFileSync(
  fileURLToPath(new URL('./PierreDiffViewer.tsx', import.meta.url)),
  'utf8',
);

describe('PierreDiffViewer omitted-line expansion', () => {
  test('expands every unchanged region from any omitted-lines separator', () => {
    expect(source).toContain("event.target.closest('[data-separator][data-expand-index]')");
    expect(source).toContain('setExpandedRevisionKey(diffRevisionKey)');
    expect(source).toContain('expandUnchanged: showFullFile');
    expect(source).not.toContain('expansionLineCount:');
  });

  test('returns to collapsed rendering when the selected file revision changes', () => {
    expect(source).toContain('setExpandedRevisionKey(null)');
    expect(source).toContain('}, [fileName, modified, original]);');
  });
});
