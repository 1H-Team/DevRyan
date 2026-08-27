import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

import {
  buildBotStartupAttentionHtml,
  buildStartupErrorHtml,
  buildStartupSplashHtml,
  resolveStartupSplashPalette,
  withStartupSplashPalette,
} from './startup-splash.mjs';

const mainSource = () => readFileSync(new URL('./main.mjs', import.meta.url), 'utf8');

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

  it('resolves one concrete palette for the native navigation handoff', () => {
    expect(resolveStartupSplashPalette({ themeMode: 'system' }, false)).toEqual({
      variant: 'light',
      background: '#FFFCF0',
      foreground: '#100F0F',
    });
    expect(resolveStartupSplashPalette({
      themeMode: 'system',
      splashBgDark: '#202124',
      splashFgDark: '#f1f3f4',
    }, true)).toEqual({
      variant: 'dark',
      background: '#202124',
      foreground: '#f1f3f4',
    });
  });

  it('passes the palette only to the local startup document', () => {
    const palette = resolveStartupSplashPalette({ themeMode: 'dark' }, true);
    const localUrl = withStartupSplashPalette(
      'http://127.0.0.1:3000/?existing=1#startup',
      'http://127.0.0.1:3000',
      palette,
    );

    expect(localUrl).toContain('existing=1');
    expect(localUrl).toContain('__ocSplashBackground=%23151313');
    expect(localUrl).toContain('__ocSplashForeground=%23CECDC3');
    expect(localUrl).toContain('__ocSplashVariant=dark');
    expect(localUrl).toContain('#startup');
    expect(withStartupSplashPalette('https://remote.example/', 'http://127.0.0.1:3000', palette))
      .toBe('https://remote.example/');
  });

  it('keeps the BrowserWindow and renderer navigation on the same palette', () => {
    const source = mainSource();

    expect(source).toContain('backgroundColor: startupSplashPalette.background');
    expect(source).toContain('mainWindow.setBackgroundColor(startupSplashPalette.background)');
    expect(source).toContain('withStartupSplashPalette(url, localOrigin, startupSplashPalette)');
    expect(source).toContain('navigateWindow(mainWindow, startupUrl');
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

  it('renders a Bot-only attention screen with retry and launch-scoped continue actions', () => {
    const html = buildBotStartupAttentionHtml(
      { themeMode: 'light' },
      { message: 'Docker is unavailable <private>' },
    );

    expect(html).toContain('Private Bot runtime needs attention');
    expect(html).toContain('openchamber://retry-bot-runtime');
    expect(html).toContain('openchamber://continue-without-bots');
    expect(html).toContain('Docker is unavailable &lt;private&gt;');
    expect(html).not.toContain('openchamber://retry-startup');
  });

  it('activates the local UI before background Bot preparation and retries without restarting the server', () => {
    const source = mainSource();
    const startupBlock = source.slice(
      source.indexOf('const startDesktopRuntime ='),
      source.indexOf('const compareSemver ='),
    );
    const retryBlock = source.slice(
      source.indexOf('const retryBotRuntimeStartup ='),
      source.indexOf('const startDesktopRuntime ='),
    );

    expect(startupBlock).toContain('if (isLocalStartupTarget(startupContext)');
    expect(startupBlock).not.toContain('await requirePreparedBotRuntime();');
    expect(startupBlock.indexOf('await activateMainWindow('))
      .toBeLessThan(startupBlock.indexOf('prepareBotRuntimeInBackground();'));
    expect(retryBlock).toContain('await requirePreparedBotRuntime();');
    expect(retryBlock).toContain('await activatePendingBotStartupContext();');
    expect(retryBlock).not.toContain('killSidecar');
    expect(source).toContain("if (parsed.hostname === BOT_RUNTIME_CONTINUE_HOST) return 'continue-without-bots'");
    expect(source).toContain('log.warn(\'[bots] continuing current launch without a ready private Bot runtime\')');
    expect(source).toContain(': state.botRuntimeOperationSnapshot || getBotRuntimeManager().operationStatus()');
  });
});
