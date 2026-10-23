// Native provider HTTP deadline policy: which providers, which keys, and where
// they are applied (provider stanza or prepared request). Plain JavaScript with
// no imports, because both the configuration translation and the native
// controller bundle (`native-observation.ts`) load it.
//
// Core waits 300 s for response headers and 900 s between stream chunks. Live
// QA saw byte-less 75-90 s hangs end in ECONNRESET, so every native provider
// stanza gets tighter deadlines; core retries the resulting Transport/Timeout.
// The header timer starts at send, so it also bounds connect. OpenAI reasoning
// can stream nothing for minutes before its first output item. Saved values win.
export const NATIVE_PROVIDER_DEADLINES = Object.freeze({ headerTimeout: 45_000, chunkTimeout: 120_000 });
const PROVIDER_DEADLINES = Object.freeze({ openai: Object.freeze({ chunkTimeout: 300_000 }) });
// `anthropic` is the local Meridian passthrough to the Claude Agent SDK, which
// can withhold headers through long silent reasoning and enforces its own
// upstream idle guard (90/180 s); a tighter HTTP deadline here would abort and
// replay a live Claude step.
export const NATIVE_DEADLINE_EXEMPT_PROVIDERS = Object.freeze(['anthropic']);
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
