import { describe, expect, it } from 'vitest';

import { buildStartupErrorHtml, buildStartupSplashHtml } from './startup-splash.mjs';

describe('Electron startup splash', () => {
  it('uses one foreground-colored large mark when the saved startup theme is dark', () => {
    const html = buildStartupSplashHtml({ themeMode: 'dark' });

    expect(html).toContain('data-splash-variant="dark"');
    expect(html).toContain('--splash-background: #151313');
    expect(html).toContain('--splash-foreground: #CECDC3');
    expect(html).toContain('stroke="currentColor"');
    expect(html).toContain('width="169" height="169"');
    expect(html).not.toContain('splash-logo-light');
    expect(html).not.toContain('splash-logo-dark');
  });

  it('honors persisted custom light colors without a fixed black logo', () => {
    const html = buildStartupSplashHtml({
      themeMode: 'light',
      splashBgLight: '#fefefe',
      splashFgLight: '#242424',
    });

    expect(html).toContain('data-splash-variant="light"');
    expect(html).toContain('--splash-background: #fefefe');
    expect(html).toContain('--splash-foreground: #242424');
    expect(html).toContain('stroke="currentColor"');
    expect(html).toContain('width="169" height="169"');
  });

  it('keeps system mode responsive to the operating-system color scheme', () => {
    const html = buildStartupSplashHtml({ themeMode: 'system' });

    expect(html).toContain('data-splash-variant="system"');
    expect(html).toContain('@media (prefers-color-scheme: dark)');
    expect(html).toContain('--splash-background: #151313');
    expect(html).toContain('--splash-foreground: #CECDC3');
  });

  it('renders a matching large-logo retry screen without allowing error text to become markup', () => {
    const html = buildStartupErrorHtml(
      { themeMode: 'dark' },
      { message: 'fetch failed (ENOTFOUND) <script>unsafe()</script>' },
    );

    expect(html).toContain('data-splash-variant="dark"');
    expect(html).toContain('width="169" height="169"');
    expect(html).toContain('stroke="currentColor"');
    expect(html).toContain('Startup needs attention');
    expect(html).toContain('role="alert"');
    expect(html).toContain('openchamber://retry-startup');
    expect(html).toContain('fetch failed (ENOTFOUND) &lt;script&gt;unsafe()&lt;/script&gt;');
    expect(html).not.toContain('<script>unsafe()</script>');
  });
});
