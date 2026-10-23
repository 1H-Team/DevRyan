import {expect,it} from 'vitest';
import {NATIVE_PROVIDER_DEADLINES,nativeProviderDeadlines,nativeRequestHeaderDeadline,withNativeProviderDeadlines} from './native-provider-deadlines.js';

it('merges stanza deadlines under saved settings and leaves the exempt Meridian route alone', () => {
 expect(nativeProviderDeadlines('opencode',undefined)).toEqual({headerTimeout:45_000,chunkTimeout:120_000});
 expect(nativeProviderDeadlines('openai',{baseURL:'x'})).toEqual({headerTimeout:45_000,chunkTimeout:300_000,baseURL:'x'});
 expect(nativeProviderDeadlines('openai',{chunkTimeout:false})).toEqual({headerTimeout:45_000,chunkTimeout:false});
 expect(nativeProviderDeadlines('anthropic',undefined)).toBeUndefined();
 const saved={baseURL:'http://127.0.0.1:3456'};
 expect(nativeProviderDeadlines('anthropic',saved)).toBe(saved);
});

it('returns the same stanza only when an exempt provider has no settings', () => {
 const meridian={name:'Anthropic'};
 expect(withNativeProviderDeadlines('anthropic',meridian)).toBe(meridian);
 const saved={settings:{baseURL:'http://127.0.0.1:3456'}};
 expect(withNativeProviderDeadlines('anthropic',saved)).toEqual(saved);
 const zen={name:'Zen'};
 expect(withNativeProviderDeadlines('opencode',zen)).toEqual({name:'Zen',settings:{...NATIVE_PROVIDER_DEADLINES}});
 expect(zen).toEqual({name:'Zen'});
});

it('bounds a request header wait only when it was left on the core default', () => {
 expect(nativeRequestHeaderDeadline('opencode',undefined,300_000)).toBe(45_000);
 expect(nativeRequestHeaderDeadline('opencode',300_000,300_000)).toBe(45_000);
 expect(nativeRequestHeaderDeadline('opencode',60_000,300_000)).toBeUndefined();
 expect(nativeRequestHeaderDeadline('opencode',false,300_000)).toBeUndefined();
 expect(nativeRequestHeaderDeadline('anthropic',undefined,300_000)).toBeUndefined();
});
