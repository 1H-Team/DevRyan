import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';

import { I18nProvider } from '@/lib/i18n';
import { GitHubProfileControl } from './SidebarFooter';

describe('GitHubProfileControl', () => {
  test('renders the assigned GitHub avatar from status', () => {
    const markup = renderToStaticMarkup(
      <I18nProvider>
        <GitHubProfileControl githubAuthStatus={{
          connected: true,
          user: {
            login: 'developer',
            id: 7,
            avatarUrl: 'https://avatars.example/developer',
            name: 'Developer',
            email: undefined,
          },
        }} />
      </I18nProvider>,
    );

    expect(markup).toContain('<img');
    expect(markup).toContain('https://avatars.example/developer');
  });

  test('prefers activeAccountId and live assigned-user data over a host-global current account', () => {
    const markup = renderToStaticMarkup(
      <I18nProvider>
        <GitHubProfileControl githubAuthStatus={{
          connected: true,
          activeAccountId: 'assigned',
          user: {
            login: 'assigned-dev',
            id: 42,
            avatarUrl: 'https://avatars.example/live-assigned',
            name: 'Assigned Developer',
          },
          accounts: [
            {
              id: 'host-current',
              current: true,
              user: { login: 'host', id: 1, avatarUrl: 'https://avatars.example/host' },
            },
            {
              id: 'assigned',
              current: false,
              user: { login: 'assigned-dev', id: 42, avatarUrl: 'https://avatars.example/stale' },
            },
          ],
        }} />
      </I18nProvider>,
    );

    expect(markup).toContain('https://avatars.example/live-assigned');
    expect(markup).not.toContain('https://avatars.example/host');
    expect(markup).toContain('h-full w-full');
  });

  test('renders a stable GitHub glyph while an assigned profile is loading', () => {
    const markup = renderToStaticMarkup(
      <I18nProvider><GitHubProfileControl showPlaceholder /></I18nProvider>,
    );

    expect(markup).toContain('aria-label="GitHub"');
    expect(markup).toContain('<svg');
  });

  test('does not let a mismatched top-level user replace the assigned account avatar', () => {
    const markup = renderToStaticMarkup(
      <I18nProvider>
        <GitHubProfileControl githubAuthStatus={{
          connected: true,
          activeAccountId: 'assigned',
          user: { login: 'host-admin', id: 1, avatarUrl: 'https://avatars.example/host' },
          accounts: [{
            id: 'assigned',
            current: true,
            user: { login: 'assigned-dev', id: 42, avatarUrl: 'https://avatars.example/assigned' },
          }],
        }} />
      </I18nProvider>,
    );

    expect(markup).toContain('https://avatars.example/assigned');
    expect(markup).not.toContain('https://avatars.example/host');
  });
});
