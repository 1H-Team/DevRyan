import React, { act } from 'react';
import { describe, expect, mock, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { withDom } from '@/test/mountedDom';
import { beginRuntimeCapabilityRead, observeRuntimeCapabilityHealth, resetRuntimeCapabilitiesForTests } from '@/lib/opencode/runtime-capabilities';
import { I18nProvider } from '@/lib/i18n';
mock.module('@/components/ui/ProviderLogo', () => ({ ProviderLogo: () => null }));
const { ProviderAuthenticationSummary } = await import('./ProvidersPage');

type SummaryProps = React.ComponentProps<typeof ProviderAuthenticationSummary>;
const render = (overrides: Partial<SummaryProps> = {}) => renderToStaticMarkup(
  <I18nProvider><ProviderAuthenticationSummary
    providerId="anthropic"
    connectionState="connected"
    cursorConfigured={false}
    {...overrides}
  /></I18nProvider>,
);

describe('collapsed provider authentication summary', () => {
  test('summarizes Claude providers from their saved connection without a Claude CLI status check', () => {
    for (const providerId of ['anthropic', 'claude-agent']) {
      const markup = render({ providerId });
      expect(markup).toContain('Connected');
      expect(markup).toContain('status-success');
      expect(markup).not.toContain('Checking sign-in…');
      expect(markup).not.toContain('Signed in');
      expect(markup).not.toContain('data-claude-auth-state');
      expect(markup).not.toContain('data-claude-inference-health');
    }
  });

  test('disconnect-pending and disconnected configuration never show a Claude provider as connected', () => {
    for (const connectionState of ['disconnect_pending', 'not_connected'] as const) {
      const markup = render({ connectionState });
      expect(markup).not.toContain('Connected');
      expect(markup).not.toContain('status-success');
      expect(markup).not.toContain('data-claude-auth-state');
    }
  });

  test('preserves other configured providers and Cursor setup semantics', () => {
    expect(render({ providerId: 'openai' })).toContain('Connected');
    expect(render({ providerId: 'cursor-acp' })).not.toContain('status-success');
    expect(render({ providerId: 'cursor-acp', cursorConfigured: true })).toContain('Connected');
  });

  test('OpenAI sign-in required state has no authenticated check mark', () => {
    const markup = render({ providerId: 'openai', connectionState: 'not_connected' });
    expect(markup).toContain('Not connected');
    expect(markup).not.toContain('status-success');
  });

  test('Windows ARM64 availability takes precedence over a saved Cursor credential', () => {
    const markup = render({ providerId: 'cursor-acp', cursorConfigured: true, cursorUnavailable: true });
    expect(markup).toContain('Cursor is unavailable on Windows ARM64.');
    expect(markup).toContain('data-cursor-capability="unsupported"');
    expect(markup).not.toContain('Connected');
    expect(markup).not.toContain('status-success');
    expect(render({ providerId: 'cursor-acp', cursorUnavailable: true, connectionState: 'disconnect_pending' })).toContain('Disconnect pending');
  });
});

test('stock Anthropic API-key preview does not advertise native Claude Code authentication', async () => withDom(async (container) => {
  const { createRoot } = await import('react-dom/client');
  const root = createRoot(container as unknown as Element);
  observeRuntimeCapabilityHealth({ openCode: { generation: 2, runtimeMode: 'standard-preview', ordinaryUserPermissions: true,
    capabilities: { providerApiKey: true, providerOAuth: false },
  } }, beginRuntimeCapabilityRead());
  try {
    await act(async () => { root.render(<I18nProvider><ProviderAuthenticationSummary providerId="anthropic" connectionState="connected" cursorConfigured={false} /></I18nProvider>); });
    expect(container.textContent).toContain('Connected');
    expect(container.textContent).not.toContain('Checking sign-in…');
    expect(container.find((node) => node.hasAttribute('data-claude-auth-state'))).toBeNull();
  } finally { await act(async () => { root.unmount(); }); resetRuntimeCapabilitiesForTests(); }
}));
