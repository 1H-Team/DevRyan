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
export const nativeProviderDeadlines = (id, settings) => NATIVE_DEADLINE_EXEMPT_PROVIDERS.includes(id)
  ? settings : ({ ...NATIVE_PROVIDER_DEADLINES, ...PROVIDER_DEADLINES[id], ...settings });
