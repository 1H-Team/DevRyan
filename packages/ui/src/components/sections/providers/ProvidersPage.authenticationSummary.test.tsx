import React from 'react';
import { describe, expect, mock, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { I18nProvider } from '@/lib/i18n';
mock.module('@/components/ui/ProviderLogo', () => ({ ProviderLogo: () => null }));
const { ProviderAuthenticationSummary } = await import('./ProvidersPage');

type SummaryProps = React.ComponentProps<typeof ProviderAuthenticationSummary>;
const render = (overrides: Partial<SummaryProps> = {}) => renderToStaticMarkup(
  <I18nProvider><ProviderAuthenticationSummary
    providerId="anthropic"
    connectionState="connected"
    cursorConfigured={false}
    claudeStatus={null}
    claudeLoading={false}
    {...overrides}
  /></I18nProvider>,
);
const authenticated = { installed: true, loggedIn: true, authStatus: 'authenticated' as const };

describe('collapsed provider authentication summary', () => {
  test('does not call a configured but unavailable Claude account connected', () => {
    const markup = render({ claudeStatus: {
      installed: true, loggedIn: false, authStatus: 'unavailable',
      error: 'Selected Claude account is unavailable.',
    } });
    expect(markup).toContain('Claude Code status unavailable');
    expect(markup).toContain('Selected Claude account is unavailable.');
    expect(markup).not.toContain('Connected');
    expect(markup).not.toContain('status-success');
    expect(markup).not.toContain('<button');
  });

  test('shows checking while the existing status request is pending or not loaded', () => {
    for (const props of [{}, { claudeStatus: authenticated, claudeLoading: true }]) {
      const markup = render(props);
      expect(markup).toContain('Checking Claude Code');
      expect(markup).not.toContain('status-success');
    }
  });

  test('requires both authenticated status and loggedIn for a successful check mark', () => {
    const markup = render({ claudeStatus: authenticated });
    expect(markup).toContain('Claude Code authenticated');
    expect(markup).toContain('status-success');
    for (const claudeStatus of [
      { ...authenticated, loggedIn: false },
      { installed: true, loggedIn: true },
      { ...authenticated, authStatus: 'error' as const },
      { ...authenticated, installed: false },
    ]) expect(render({ claudeStatus })).not.toContain('status-success');
  });

  test('exposes a safe status error without claiming authentication', () => {
    const markup = render({ claudeStatus: { installed: true, authStatus: 'error', error: 'Status unavailable.' } });
    expect(markup).toContain('Claude Code status unavailable');
    expect(markup).toContain('Status unavailable.');
    expect(markup).not.toContain('status-success');
  });

  test('disconnect-pending and disconnected configuration win over a cached authenticated account', () => {
    for (const connectionState of ['disconnect_pending', 'not_connected'] as const) {
      const markup = render({ connectionState, claudeStatus: authenticated });
      expect(markup).not.toContain('Claude Code authenticated');
      expect(markup).not.toContain('status-success');
      expect(markup).not.toContain('data-claude-auth-state');
    }
  });

  test('preserves other configured providers and Cursor setup semantics', () => {
    expect(render({ providerId: 'openai' })).toContain('Connected');
    expect(render({ providerId: 'cursor-acp' })).not.toContain('status-success');
    expect(render({ providerId: 'cursor-acp', cursorConfigured: true })).toContain('Connected');
  });
});
