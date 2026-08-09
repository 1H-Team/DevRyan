import { describe, expect, it } from 'vitest';

import { buildStartupErrorHtml, buildStartupSplashHtml } from './startup-splash.mjs';

describe('Electron startup splash', () => {
  it('uses the white app icon when the saved startup theme is dark', () => {
    const html = buildStartupSplashHtml({ themeMode: 'dark' });

    expect(html).toContain('data-splash-variant="dark"');
    expect(html).toContain('stroke="#fff"');
    expect(html).toContain('width="169" height="169"');
  });

  it('keeps the black app icon when the saved startup theme is light', () => {
    const html = buildStartupSplashHtml({ themeMode: 'light' });

    expect(html).toContain('data-splash-variant="light"');
    expect(html).toContain('stroke="#1e2a38"');
    expect(html).toContain('width="169" height="169"');
  });

  it('renders a retryable startup error without allowing error text to become markup', () => {
    const html = buildStartupErrorHtml(
      { themeMode: 'dark' },
      { message: 'fetch failed (ENOTFOUND) <script>unsafe()</script>' },
    );

    expect(html).toContain('data-splash-variant="dark"');
    expect(html).toContain('openchamber://retry-startup');
    expect(html).toContain('fetch failed (ENOTFOUND) &lt;script&gt;unsafe()&lt;/script&gt;');
    expect(html).not.toContain('<script>unsafe()</script>');
  });
});
