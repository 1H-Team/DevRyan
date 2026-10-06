import { describe, expect, it } from 'vitest';
import { buildSiwcCredentialValue } from './chatgpt-siwc.js';
import { projectNativeSetupCredentials } from './runtime-host/native-setup-credential-data.js';
import { annotateOpenAIModelAvailability } from './openai-model-availability.js';
const metadata = { accountID: 'workspace-a', subject: 'subject-a', clientId: 'issued-a', idToken: 'fixture-id-token', scopes: ['openid'], extAgentHostId: 'fixture-host', planUsage: false };
describe('SIWC native owner contracts', () => {
  it('retains verified sign-in without inference scope', () => {
    expect(buildSiwcCredentialValue({ access: 'fixture-access', refresh: 'fixture-refresh', expires: 120000, clientId: 'issued-a', idToken: 'fixture-id-token', scopes: ['openid'], subject: 'subject-a', hostId: 'fixture-host' }).metadata.planUsage).toBe(false);
  });
  it('preserves SIWC metadata in strict Bots projection and restart import', () => {
    const auth = { openai: { type: 'oauth', methodID: 'chatgpt-siwc', access: 'fixture-access', refresh: 'fixture-refresh', expires: 120000, metadata } };
    expect(projectNativeSetupCredentials(auth).credentials[0].value.metadata).toEqual(metadata);
    expect(projectNativeSetupCredentials(auth, { onSkip: () => {} }).credentials[0].value.metadata).toEqual(metadata);
  });
  it('does not relabel legacy OpenAI credentials as SIWC', () => {
    expect(projectNativeSetupCredentials({ openai: { type: 'oauth', access: 'fixture-access', refresh: 'fixture-refresh', expires: 120000 } }).credentials[0].value.methodID).toBe('chatgpt-browser');
  });
  it('makes unavailable account catalog explicit', () => {
    const auth = { type: 'oauth', methodID: 'chatgpt-siwc', access: 'fixture-access', metadata: { ...metadata, scopes: ['chatgpt.tokens.use.direct'] } };
    const provider = annotateOpenAIModelAvailability({ providers: [{ id: 'openai', models: { model: { id: 'model' } } }] }, auth, { accountModels: null }).providers[0];
    expect(provider.models.model).toMatchObject({ available: false, unavailableReason: 'account_models_unavailable' });
  });
});
