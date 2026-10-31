import {expect,it} from 'vitest';
import {NATIVE_DEADLINE_EXEMPT_PROVIDERS,NATIVE_PROVIDER_DEADLINES,nativeProviderDeadlines,nativeRequestHeaderDeadline,withNativeProviderDeadlines} from './native-provider-deadlines.js';

it('merges stanza deadlines under saved settings and leaves the exempt claude-agent route alone', () => {
 expect(NATIVE_DEADLINE_EXEMPT_PROVIDERS).toEqual(['claude-agent']);
 expect(nativeProviderDeadlines('opencode',undefined)).toEqual({headerTimeout:45_000,chunkTimeout:300_000});
 expect(nativeProviderDeadlines('openai',{baseURL:'x'})).toEqual({headerTimeout:45_000,chunkTimeout:300_000,baseURL:'x'});
 expect(nativeProviderDeadlines('openai',{chunkTimeout:false})).toEqual({headerTimeout:45_000,chunkTimeout:false});
 expect(nativeProviderDeadlines('claude-agent',undefined)).toBeUndefined();
 const saved={timeout:600_000};
 expect(nativeProviderDeadlines('claude-agent',saved)).toBe(saved);
 // The retired Meridian `anthropic` route is an ordinary provider now and gets the deadlines.
 expect(nativeProviderDeadlines('anthropic',undefined)).toEqual({headerTimeout:45_000,chunkTimeout:300_000});
});

it('returns the same stanza only when an exempt provider has no settings', () => {
 const claude={name:'Claude'};
 expect(withNativeProviderDeadlines('claude-agent',claude)).toBe(claude);
 const saved={settings:{timeout:600_000}};
 expect(withNativeProviderDeadlines('claude-agent',saved)).toEqual(saved);
 const zen={name:'Zen'};
 expect(withNativeProviderDeadlines('opencode',zen)).toEqual({name:'Zen',settings:{...NATIVE_PROVIDER_DEADLINES}});
 expect(zen).toEqual({name:'Zen'});
 expect(withNativeProviderDeadlines('anthropic',{name:'Anthropic'})).toEqual({name:'Anthropic',settings:{...NATIVE_PROVIDER_DEADLINES}});
});

it('bounds a request header wait only when it was left on the core default', () => {
 expect(nativeRequestHeaderDeadline('opencode',undefined,300_000)).toBe(45_000);
 expect(nativeRequestHeaderDeadline('opencode',300_000,300_000)).toBe(45_000);
 expect(nativeRequestHeaderDeadline('opencode',60_000,300_000)).toBeUndefined();
 expect(nativeRequestHeaderDeadline('opencode',false,300_000)).toBeUndefined();
 expect(nativeRequestHeaderDeadline('claude-agent',undefined,300_000)).toBeUndefined();
 expect(nativeRequestHeaderDeadline('anthropic',undefined,300_000)).toBe(45_000);
});
