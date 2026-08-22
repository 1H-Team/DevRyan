import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

const indexHtml = () => readFileSync(resolve(import.meta.dirname, 'index.html'), 'utf8');
const siteManifest = () => JSON.parse(readFileSync(resolve(import.meta.dirname, 'public/site.webmanifest'), 'utf8'));

describe('initial loading splash', () => {
  it('uses the unified responsive theme-aware loading contract', () => {
    const html = indexHtml();

    expect(html).toContain('--splash-background-light: #FFFCF0');
    expect(html).toContain('--splash-stroke-light: #100F0F');
    expect(html).toContain('--splash-background-dark: #151313');
    expect(html).toContain('--splash-stroke-dark: #CECDC3');
    expect(html).toContain('class="splash-logo" width="169" height="169"');
    expect(html).toContain('width: min(169px, 42vw)');
    expect(html).toContain('stroke="currentColor"');
    expect(html).toContain('margin-top: 24px');
    expect(html).toContain('role="status" aria-live="polite" aria-atomic="true"');
    expect(html).not.toContain('stroke="#1e2a38"');
    expect(html).not.toContain('var(--splash-logo-stroke)');
  });

  it('prevents document scrollbars while the initial loading splash is visible', () => {
    const html = indexHtml();

    expect(html).toContain('html,\n      body {');
    expect(html).toContain('margin: 0;');
    expect(html).toContain('overflow: hidden;');
    expect(html).toContain('position: fixed;');
    expect(html).toContain('inset: 0;');
  });
});

describe('web metadata branding', () => {
  it('uses DevRyan for the document title and install metadata', () => {
    const html = indexHtml();

    expect(html).toContain("const defaultAppName = 'DevRyan - AI Coding Assistant'");
    expect(html).toContain("const defaultShortName = 'DevRyan'");
    expect(html).toContain('<title>DevRyan - AI Coding Assistant</title>');
    expect(html).toContain('<meta name="application-name" content="DevRyan" />');
    expect(html).toContain('<meta name="apple-mobile-web-app-title" content="DevRyan" />');
  });

  it('uses DevRyan for the static web manifest name fields', () => {
    const manifest = siteManifest();

    expect(manifest.name).toBe('DevRyan - AI Coding Companion');
    expect(manifest.short_name).toBe('DevRyan');
  });
});
