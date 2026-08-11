import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

const mainSource = readFileSync(new URL('../main.mjs', import.meta.url), 'utf8');
const exportStart = mainSource.indexOf("case 'desktop_export_diagnostics':");
const exportEnd = mainSource.indexOf("case 'desktop_read_file':", exportStart);
const exportBlock = mainSource.slice(exportStart, exportEnd);

describe('desktop diagnostics export contract', () => {
  test('uses the requesting renderer session with credentials and CSRF protection', () => {
    expect(exportStart).toBeGreaterThan(-1);
    expect(exportEnd).toBeGreaterThan(exportStart);
    expect(exportBlock).toContain('const rendererSession = browserWindow?.webContents?.session;');
    expect(exportBlock).toContain('await rendererSession.fetch(');
    expect(exportBlock).toContain("credentials: 'include'");
    expect(exportBlock).toContain("'X-DevRyan-CSRF': '1'");
    expect(exportBlock).not.toContain('const response = await fetch(');
  });

  test('surfaces structured server errors before creating a diagnostics temp file', () => {
    expect(exportBlock).toContain('const payload = await response.clone().json().catch(() => null);');
    expect(exportBlock).toContain("typeof payload?.error === 'string'");
    expect(exportBlock.indexOf('if (!response.ok || !response.body)')).toBeLessThan(
      exportBlock.indexOf('await cleanupExpiredDiagnosticsTemps(result.filePath)'),
    );
    expect(exportBlock.indexOf('if (result.canceled || !result.filePath)')).toBeLessThan(
      exportBlock.indexOf('await rendererSession.fetch('),
    );
  });
});
