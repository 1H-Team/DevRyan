import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';

import { RuntimeLoadingScreen } from './RuntimeLoadingScreen';

describe('RuntimeLoadingScreen', () => {
  test('renders the responsive theme-colored loading contract', () => {
    const markup = renderToStaticMarkup(
      <RuntimeLoadingScreen message="Warming agent runtime" />,
    );

    expect(markup).toContain('data-runtime-loading-screen=""');
    expect(markup).toContain('data-mode="page"');
    expect(markup).toContain('aria-busy="true"');
    expect(markup).toContain('role="status"');
    expect(markup).toContain('aria-live="polite"');
    expect(markup).toContain('width="169" height="169"');
    expect(markup).toContain('stroke="currentColor"');
    expect(markup).toContain('width:min(169px, 42vw)');
    expect(markup).toContain('bg-background');
    expect(markup).toContain('text-foreground');
    expect(markup).toContain('text-muted-foreground');
    expect(markup).toContain('Warming agent runtime');
    expect(markup).not.toContain('rounded-full');
  });

  test('renders an opaque full-app error overlay with a retry action', () => {
    const markup = renderToStaticMarkup(
      <RuntimeLoadingScreen
        mode="overlay"
        state="error"
        message={'OpenCode failed <unsafe>'}
        onRetry={() => undefined}
        isRetrying
      />,
    );

    expect(markup).toContain('data-mode="overlay"');
    expect(markup).toContain('aria-busy="false"');
    expect(markup).toContain('fixed inset-0 z-[9999]');
    expect(markup).not.toContain('bg-background/90');
    expect(markup).toContain('role="alert"');
    expect(markup).toContain('Startup needs attention');
    expect(markup).toContain('OpenCode failed &lt;unsafe&gt;');
    expect(markup).toContain('disabled=""');
    expect(markup).toContain('Retrying…');
  });
});
