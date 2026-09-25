import { describe, expect, it } from 'vitest';

import {
  getAntigravityPluginGoogleModelKeyPaths,
  isAntigravityPluginGoogleModel,
} from './antigravity-retirement.js';

describe('Antigravity retirement', () => {
  it('matches only models branded by the Antigravity plugin', () => {
    expect(isAntigravityPluginGoogleModel('antigravity-gemini-3-pro', {})).toBe(true);
    expect(isAntigravityPluginGoogleModel('gemini-2.5-pro', { name: 'Gemini 2.5 Pro (Gemini CLI)' })).toBe(true);
    expect(isAntigravityPluginGoogleModel('claude', { name: 'Claude Opus (Antigravity)' })).toBe(true);
    expect(isAntigravityPluginGoogleModel('gemini-2.5-pro', { name: 'Gemini 2.5 Pro' })).toBe(false);
    expect(isAntigravityPluginGoogleModel('gemini-2.5-pro', undefined)).toBe(false);
  });

  it('keeps user Google models and options while removing plugin models', () => {
    expect(getAntigravityPluginGoogleModelKeyPaths({
      provider: {
        google: {
          options: {},
          models: {
            'antigravity-gemini-3-pro': {},
            'my-gemini': { name: 'Mine' },
          },
        },
      },
    })).toEqual([['provider', 'google', 'models', 'antigravity-gemini-3-pro']]);
  });

  it('collapses the Google block and provider container when only plugin models remain', () => {
    expect(getAntigravityPluginGoogleModelKeyPaths({
      theme: 'keep',
      provider: { google: { models: { 'gemini-3-pro-preview': { name: 'Gemini 3 Pro Preview (Gemini CLI)' } } } },
      providers: { google: { models: { 'antigravity-x': {} } }, openai: {} },
    })).toEqual([['provider'], ['providers', 'google']]);
    expect(getAntigravityPluginGoogleModelKeyPaths({ provider: { openai: {} } })).toEqual([]);
    expect(getAntigravityPluginGoogleModelKeyPaths(null)).toEqual([]);
  });
});
