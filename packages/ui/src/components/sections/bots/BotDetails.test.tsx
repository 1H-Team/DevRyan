import React from 'react';
import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';

import { I18nProvider } from '@/lib/i18n';
import { BotDetails, BotStatusSummary } from './BotDetails';
import { managementDetail } from './botManagementTestFixtures';

describe('BotDetails', () => {
  test('renders the durable profile and avatar controls without interrupting the Overview flow with status metadata', () => {
    const markup = renderToStaticMarkup(
      <I18nProvider><BotDetails bot={managementDetail().bot} onSave={() => {}} /></I18nProvider>,
    );

    expect(markup).toContain('Profile');
    expect(markup).toContain('Upload');
    expect(markup).toContain('PNG, JPEG, or WebP');
    expect(markup).toContain('Description');
    expect(markup).not.toContain('Short Summary');
    // Tenancy is no longer a per-Bot choice, so it is not shown.
    expect(markup).not.toContain('Tenancy');
    expect(markup).not.toContain('Lifecycle');
    expect(markup).not.toContain('Active revision');
    expect(markup).toContain('Save Overview');
  });

  test('renders concise status and timestamps without revision metadata', () => {
    const markup = renderToStaticMarkup(
      <I18nProvider><BotStatusSummary bot={managementDetail().bot} /></I18nProvider>,
    );

    expect(markup).toContain('Status');
    expect(markup).toContain('Created');
    expect(markup).toContain('Updated');
    expect(markup).not.toContain('Active revision');
    expect(markup).toContain('<dl');
  });

  test('uses initials only when there is no uploaded image or migrated legacy glyph', () => {
    const bot = { ...managementDetail().bot, avatarFallback: null };
    const markup = renderToStaticMarkup(
      <I18nProvider><BotDetails bot={bot} onSave={() => {}} /></I18nProvider>,
    );
    expect(markup).toContain('RD');
  });

  test('keeps client avatar bounds aligned with the server contract and allows reselecting a file', () => {
    const source = readFileSync(new URL('./BotDetails.tsx', import.meta.url), 'utf8');
    expect(source).toContain("new Set(['image/png', 'image/jpeg', 'image/webp'])");
    expect(source).toContain('5 * 1024 * 1024');
    expect(source).toContain("event.currentTarget.value = ''");
    expect(source).toContain('setAvatar(null)');
  });
});
