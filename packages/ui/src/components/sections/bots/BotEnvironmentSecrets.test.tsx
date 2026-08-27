import React from 'react';
import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';

import type { BotsApi } from '@/lib/botsApi';
import { BotEnvironmentSecrets } from './BotEnvironmentSecrets';

const BOT_ID = 'b0000000-0000-4000-8000-000000000001';
const api = {
  listBotEnvironmentSecrets: async () => ({ environmentSecrets: [] }),
  putBotEnvironmentSecret: async () => { throw new Error('not called during render'); },
  deleteBotEnvironmentSecret: async () => { throw new Error('not called during render'); },
} as unknown as Pick<
  BotsApi,
  'listBotEnvironmentSecrets' | 'putBotEnvironmentSecret' | 'deleteBotEnvironmentSecret'
>;

describe('BotEnvironmentSecrets', () => {
  test('renders a concise write-only editor without descriptive copy or prefilled values', () => {
    const markup = renderToStaticMarkup(<BotEnvironmentSecrets botId={BOT_ID} api={api} />);
    expect(markup).toContain('Environment secrets (.env)');
    expect(markup).not.toContain('Values are write-only and are never shown again.');
    expect(markup).not.toContain('may reveal them if explicitly instructed');
    expect(markup).toContain('type="password"');
    expect(markup).not.toContain('value="secret');
  });

  test('keeps metadata visible but hides mutation controls for non-managers', () => {
    const markup = renderToStaticMarkup(
      <BotEnvironmentSecrets botId={BOT_ID} api={api} readOnly />,
    );
    expect(markup).toContain('Environment secrets (.env)');
    expect(markup).not.toContain('Add secret');
    expect(markup).not.toContain('type="password"');
  });
});
