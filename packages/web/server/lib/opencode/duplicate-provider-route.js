import { readProviderAuthRecord } from './auth.js';

// Host-attested provider transports for duplicate-output qualification. A
// release profile's `transport` must equal the route named here. A route is
// named only when the host can establish the credential kind OpenCode uses,
// from the same OpenCode auth record OpenCode reads; only the record's `type`
// is inspected and no credential value leaves this module. API-key and other
// credentials are different transports and stay unqualified (null). Endpoint
// overrides are covered by the profile's selected-route provider hash.
export const DUPLICATE_PROVIDER_ROUTES = Object.freeze({
  // Managed ChatGPT OAuth Responses, owned by the host OpenAI OAuth coordinator.
  openai: 'openai-chatgpt-managed-responses-v1',
  // OpenCode's xAI auth plugin sends OAuth bearer requests to xAI Responses.
  xai: 'xai-oauth-responses-v1',
});

export const createDuplicateProviderRouteResolver = ({
  openAiUsesOAuth,
  readAuthRecord = (providerID) => readProviderAuthRecord(providerID),
} = {}) => (providerID) => {
  try {
    if (providerID === 'openai') return openAiUsesOAuth?.() === true ? DUPLICATE_PROVIDER_ROUTES.openai : null;
    if (providerID === 'xai') return readAuthRecord('xai')?.type === 'oauth' ? DUPLICATE_PROVIDER_ROUTES.xai : null;
  } catch {
    // An unreadable auth record cannot attest a route.
  }
  return null;
};
