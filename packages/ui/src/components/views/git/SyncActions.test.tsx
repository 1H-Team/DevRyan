import React from 'react';
import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';

import { I18nProvider } from '@/lib/i18n';
import { SyncActions, type SyncAction } from './SyncActions';

const markup = (syncAction: SyncAction) => renderToStaticMarkup(
  <I18nProvider>
    <SyncActions syncAction={syncAction} remotes={[{ name: 'origin', fetchUrl: '', pushUrl: '' }]} onFetch={() => {}}
      disabled={false} aheadCount={1} />
  </I18nProvider>,
);

describe('SyncActions', () => {
  test('shows a spinner while a push runs and never a progress label', () => {
    const html = markup('push');
    expect(html).toContain('animate-spin');
    expect(html).not.toContain('data-git-push-progress');
  });

  test('shows no progress label while idle', () => {
    expect(markup(null)).not.toContain('data-git-push-progress');
    expect(markup('fetch')).not.toContain('data-git-push-progress');
  });
});
