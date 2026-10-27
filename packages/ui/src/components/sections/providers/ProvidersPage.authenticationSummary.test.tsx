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
    expect(markup).toContain('Status unavailable');
    expect(markup).toContain('Selected Claude account is unavailable.');
    expect(markup).not.toContain('Connected');
    expect(markup).not.toContain('status-success');
    expect(markup).not.toContain('<button');
  });

  test('shows checking while the existing status request is pending or not loaded', () => {
    for (const props of [{}, { claudeStatus: authenticated, claudeLoading: true }]) {
      const markup = render(props);
      expect(markup).toContain('Checking sign-in…');
      expect(markup).not.toContain('status-success');
    }
  });

  test('requires both authenticated status and loggedIn for a successful check mark', () => {
    const markup = render({ claudeStatus: authenticated });
    expect(markup).toContain('Signed in');
    expect(markup).not.toContain('typography-meta');
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
    expect(markup).toContain('Status unavailable');
    expect(markup).toContain('Status unavailable.');
    expect(markup).not.toContain('status-success');
  });

  test('disconnect-pending and disconnected configuration win over a cached authenticated account', () => {
    for (const connectionState of ['disconnect_pending', 'not_connected'] as const) {
      const markup = render({ connectionState, claudeStatus: authenticated });
      expect(markup).not.toContain('Signed in');
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
    await act(async () => { root.render(<I18nProvider><ProviderAuthenticationSummary providerId="anthropic" connectionState="connected" cursorConfigured={false} claudeStatus={null} claudeLoading={false} /></I18nProvider>); });
    expect(container.textContent).toContain('Connected');
    expect(container.textContent).not.toContain('Checking sign-in…');
    expect(container.find((node) => node.hasAttribute('data-claude-auth-state'))).toBeNull();
  } finally { await act(async () => { root.unmount(); }); resetRuntimeCapabilitiesForTests(); }
}));

test('saved sign-in stays signed in while finite launch diagnostics report a separate failure', () => {
  const markup = render({ claudeStatus: { ...authenticated, lastSuccessfulInferenceAt: 1000,
    lastLaunchFailure: { at: 2000, code: 'claude_process_permission' } } });
  expect(markup).toContain('Signed in');
  expect(markup).toContain('status-success');
  expect(markup).toContain('Last successful inference:');
  expect(markup).toContain('Last launch failed: Process permission denied');
  expect(markup).not.toContain('Sign in again');
  const older = render({ claudeStatus: authenticated });
  expect(older).not.toContain('Last successful inference');
  expect(older).not.toContain('Last launch failed');
  const untrusted = render({ claudeStatus: { ...authenticated, lastSuccessfulInferenceAt: NaN,
    lastLaunchFailure: { at: 2000, code: 'RAW_PRIVATE_DIAGNOSTIC' } } });
  expect(untrusted).not.toContain('RAW_PRIVATE_DIAGNOSTIC');
  expect(untrusted).not.toContain('Last launch failed');
});
