const desktop = Object.freeze({ width: 1280, height: 800 });
const narrow = Object.freeze({ width: 390, height: 844 });

const visualCase = (id, scene, state, options = {}) => Object.freeze({
  id,
  scene,
  state,
  theme: options.theme || 'light',
  role: options.role || 'admin',
  rail: options.rail || 280,
  viewport: options.viewport || desktop,
  interaction: options.interaction || null,
  drawer: options.drawer || ((options.viewport || desktop).width <= 720 ? 'closed' : 'open'),
});

export const PRODUCTION_BOTS_VISUAL_MATRIX = Object.freeze([
  visualCase('agent-opencode-light-r220', 'agent', 'opencode', { rail: 220 }),
  visualCase('agent-agui-healthy-dark-r280', 'agent', 'healthy', { theme: 'dark' }),
  visualCase('agent-testing-light-r500', 'agent', 'testing', { rail: 500 }),
  visualCase('agent-failed-dark-r280', 'agent', 'failed', { theme: 'dark' }),
  visualCase('agent-revoked-light-r220', 'agent', 'revoked', { rail: 220 }),
  visualCase('agent-privacy-warning-dark-narrow', 'agent', 'privacy_warning', { theme: 'dark', viewport: narrow }),

  visualCase('spec-trusted-light-r500', 'spec', 'trusted', { rail: 500 }),
  visualCase('spec-untrusted-dark-r280', 'spec', 'untrusted', { theme: 'dark' }),
  visualCase('spec-tampered-light-r220', 'spec', 'tampered', { rail: 220 }),
  visualCase('spec-binding-failed-dark-narrow', 'spec', 'binding_failed', { theme: 'dark', viewport: narrow }),
  visualCase('spec-portable-diff-light-r500', 'spec', 'diff', { rail: 500 }),

  visualCase('policy-structured-light-r500', 'policy', 'healthy', { rail: 500 }),
  visualCase('policy-validation-error-dark-r280', 'policy', 'validation_error', { theme: 'dark' }),
  visualCase('policy-quota-exhausted-light-narrow', 'policy', 'quota_exhausted', { viewport: narrow }),

  visualCase('network-public-only-light-r220', 'network', 'public_only', { rail: 220 }),
  visualCase('network-allowlist-dark-r500', 'network', 'allowlist', { theme: 'dark', rail: 500 }),
  visualCase('network-private-denial-light-r280', 'network', 'private_denial'),
  visualCase('network-proxy-failure-dark-narrow', 'network', 'proxy_failure', { theme: 'dark', viewport: narrow }),
  visualCase('network-standard-light-r280', 'network', 'standard'),
  visualCase('network-runsc-dark-r500', 'network', 'runsc', { theme: 'dark', rail: 500 }),
  visualCase('network-runsc-unavailable-light-r220', 'network', 'runsc_unavailable', { rail: 220 }),

  visualCase('runtime-consent-light-r280', 'runtime', 'consent'),
  visualCase('runtime-legacy-consent-dialog-light-r500', 'runtime', 'legacy_consent', { rail: 500, interaction: 'legacy_dialog' }),
  visualCase('runtime-starting-dark-r220', 'runtime', 'starting', { theme: 'dark', rail: 220 }),
  visualCase('runtime-connected-light-r500', 'runtime', 'connected', { rail: 500 }),
  visualCase('runtime-degraded-dark-r280', 'runtime', 'degraded', { theme: 'dark' }),
  visualCase('runtime-updating-light-narrow', 'runtime', 'updating', { viewport: narrow }),
  visualCase('runtime-disabled-dark-r280', 'runtime', 'disabled', { theme: 'dark' }),
  visualCase('runtime-desktop-unavailable-light-r500', 'runtime', 'desktop_unavailable', { rail: 500 }),

  visualCase('transcript-empty-light-r220', 'transcript', 'empty', { rail: 220 }),
  visualCase('transcript-loading-dark-r280', 'transcript', 'loading', { theme: 'dark' }),
  visualCase('transcript-pending-light-r280', 'transcript', 'pending', { interaction: 'activity_hidden' }),
  visualCase('transcript-pending-developer-dark-r220', 'transcript', 'pending', { theme: 'dark', role: 'developer', rail: 220 }),
  visualCase('transcript-settled-light-r500', 'transcript', 'settled', { rail: 500 }),
  visualCase('transcript-reconciliation-dark-r500', 'transcript', 'reconciliation', { theme: 'dark', rail: 500 }),
  visualCase('transcript-partial-failure-light-narrow', 'transcript', 'partial_failure', { viewport: narrow, drawer: 'open' }),
  visualCase('transcript-paused-dark-r280', 'transcript', 'paused', { theme: 'dark' }),
  visualCase('transcript-retired-light-r500', 'transcript', 'retired', { rail: 500 }),
]);

export const productionBotsVisualUrl = (baseUrl, entry) => {
  const url = new URL(baseUrl);
  url.search = new URLSearchParams({
    scene: entry.scene,
    state: entry.state,
    theme: entry.theme,
    role: entry.role,
    rail: String(entry.rail),
    drawer: entry.drawer,
  }).toString();
  return url.href;
};
