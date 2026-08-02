import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

const source = readFileSync(new URL('./AboutSettings.tsx', import.meta.url), 'utf8');

describe('About settings OpenCode version placement', () => {
  test('renders the compact OpenCode version section below the mobile links', () => {
    const linksMarker = source.indexOf('{/* Links row */}');
    const compactSection = source.indexOf('<OpenCodeVersionSection compact />');
    const mobileDialog = source.indexOf('<UpdateDialog', compactSection);

    expect(linksMarker).toBeGreaterThan(-1);
    expect(compactSection).toBeGreaterThan(linksMarker);
    expect(mobileDialog).toBeGreaterThan(compactSection);
  });

  test('renders the full OpenCode version section after the desktop GitHub row', () => {
    const desktopLinks = source.lastIndexOf('<div className="flex items-center gap-4 px-4 py-4">');
    const fullSection = source.indexOf('<OpenCodeVersionSection />');
    const desktopCardEnd = source.indexOf('</div>', fullSection);

    expect(desktopLinks).toBeGreaterThan(-1);
    expect(fullSection).toBeGreaterThan(desktopLinks);
    expect(desktopCardEnd).toBeGreaterThan(fullSection);
  });
});
