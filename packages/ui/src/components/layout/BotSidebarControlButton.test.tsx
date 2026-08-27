import React from 'react';
import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';

import { I18nProvider } from '@/lib/i18n';
import { BotSidebarControlButton } from './BotSidebarControlButton';

describe('BotSidebarControlButton', () => {
  test('maps mobile drawer state to accessible edge controls', () => {
    const markup = renderToStaticMarkup(
      <I18nProvider>
        <div>
          <BotSidebarControlButton side="left" open={false} onToggle={() => undefined} mobile />
          <BotSidebarControlButton side="right" open onToggle={() => undefined} mobile />
        </div>
      </I18nProvider>,
    );

    expect(markup).toContain('data-bot-sidebar-control="left"');
    expect(markup).toContain('aria-label="Open Sessions"');
    expect(markup).toContain('aria-expanded="false"');
    expect(markup).toContain('data-bot-sidebar-control="right"');
    expect(markup).toContain('aria-label="Close Bot Operations"');
    expect(markup).toContain('aria-expanded="true"');
    expect(markup.match(/h-11 w-11/g)).toHaveLength(2);
  });
});
