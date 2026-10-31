// Native provider HTTP deadline policy: which providers, which keys, and where
// they are applied (provider stanza or prepared request). Plain JavaScript with
// no imports, because both the configuration translation and the native
// controller bundle (`native-observation.ts`) load it.
//
// Core waits 300 s for response headers and 900 s between stream chunks. Live
// QA saw byte-less 75-90 s hangs end in ECONNRESET, so every native provider
// stanza gets a tighter header deadline; core retries the resulting
// Transport/Timeout. The header timer starts at send, so it also bounds connect.
// Reasoning models can stream nothing for minutes between output items, and a
// chunk timeout replays the whole prompt, so the chunk wait is 300 s for every
// stanza (it was 120 s for all but OpenAI). Saved values win.
export const NATIVE_PROVIDER_DEADLINES = Object.freeze({ headerTimeout: 45_000, chunkTimeout: 300_000 });
const PROVIDER_DEADLINES = Object.freeze({});
// `claude-agent` runs the user's Claude Code, which owns its API and stream idle
// timeouts; OpenCode would pass a stanza deadline to it as API_TIMEOUT_MS and cut
// off long silent reasoning.
export const NATIVE_DEADLINE_EXEMPT_PROVIDERS = Object.freeze(['claude-agent']);
const exempt = id => NATIVE_DEADLINE_EXEMPT_PROVIDERS.includes(id);

/** Stanza `settings` with the deadlines merged under saved values; exempt providers keep theirs unchanged. */
export const nativeProviderDeadlines = (id, settings) => exempt(id)
  ? settings : ({ ...NATIVE_PROVIDER_DEADLINES, ...PROVIDER_DEADLINES[id], ...settings });

/** The provider stanza with deadline `settings`; the same object when an exempt provider has none. */
export const withNativeProviderDeadlines = (id, provider) => {
  const settings = nativeProviderDeadlines(id, provider.settings);
  return settings === undefined ? provider : { ...provider, settings };
};

// Providers used without a config stanza (Zen, OAuth OpenAI) keep core's 300 s
// header wait, and adding a stanza would change their activation. A request
// whose model left the core default gets DevRyan's header deadline instead;
// chunk waits stay as configured because reasoning models can stream nothing
// for minutes. Core retries the resulting Transport/Timeout.
/**
 * The per-request header deadline for a prepared request, or undefined to keep
 * the request as it is. `configured` is the request's (or its model's) header
 * timeout and `coreDefault` core's own default, which counts as unconfigured.
 */
export const nativeRequestHeaderDeadline = (providerID, configured, coreDefault) => (
  exempt(providerID) || (configured !== undefined && configured !== coreDefault)
    ? undefined : NATIVE_PROVIDER_DEADLINES.headerTimeout
);
