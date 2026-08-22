import { describe, expect, it } from 'vitest';

import {
  createXaiToolCatalogCache,
  deriveXaiDuplicateToolOverrides,
  listXaiModelIds,
} from './xai-tool-catalog.js';

const tool = (id, description = 'Run context search', parameters = { type: 'object', properties: {} }) => ({
  id,
  description,
  parameters,
});

describe('xAI tool catalog reduction', () => {
  it('disables only MCP-prefixed tools with an equivalent canonical schema', () => {
    expect(deriveXaiDuplicateToolOverrides([
      tool('ctx_search'),
      tool('mcp__context_mode__ctx_search'),
      tool('unique_tool', 'Unique', { type: 'object', properties: { value: { type: 'string' } } }),
    ])).toEqual({
      mcp__context_mode__ctx_search: false,
    });
  });

  it('fails open for different descriptions, schemas, or missing canonical tools', () => {
    expect(deriveXaiDuplicateToolOverrides([
      tool('ctx_search'),
      tool('mcp__context_mode__ctx_search', 'Different behavior'),
      tool('ctx_execute'),
      tool('mcp__context_mode__ctx_execute', 'Run context search', {
        type: 'object',
        properties: { code: { type: 'string' } },
      }),
      tool('mcp__context_mode__ctx_stats'),
    ])).toBeNull();
  });

  it('lists every discovered model for xAI aliases only', () => {
    expect(listXaiModelIds({
      providers: [
        { id: 'openai', models: { ignored: { id: 'ignored' } } },
        { id: 'xai', models: { 'grok-4.6': { id: 'grok-4.6' }, fallback: {} } },
        { id: 'grok', models: { 'grok-fast': { id: 'grok-fast' } } },
      ],
    })).toEqual(['grok-4.6', 'fallback', 'grok-fast']);
  });

  it('expires cached evidence and never applies it to another model or provider', () => {
    let currentTime = 1_000;
    const cache = createXaiToolCatalogCache({ now: () => currentTime, maxAgeMs: 100 });
    cache.remember({
      directory: '/repo',
      providerID: 'xai',
      modelID: 'grok-4.6',
      catalog: [tool('ctx_search'), tool('mcp__context_mode__ctx_search')],
    });

    expect(cache.get({ directory: '/repo', providerID: 'xai', modelID: 'grok-4.6' })).toEqual({
      mcp__context_mode__ctx_search: false,
    });
    expect(cache.get({ directory: '/repo', providerID: 'xai', modelID: 'other' })).toBeNull();
    expect(cache.get({ directory: '/repo', providerID: 'openai', modelID: 'grok-4.6' })).toBeNull();

    currentTime += 101;
    expect(cache.get({ directory: '/repo', providerID: 'xai', modelID: 'grok-4.6' })).toBeNull();
  });

  it('keeps fresh no-duplicate evidence distinct from a cache miss', () => {
    const cache = createXaiToolCatalogCache();
    cache.remember({
      directory: '/repo',
      providerID: 'xai',
      modelID: 'grok-4.6',
      catalog: [tool('unique')],
    });

    expect(cache.get({ directory: '/repo', providerID: 'xai', modelID: 'grok-4.6' })).toEqual({});
    expect(cache.get({ directory: '/repo', providerID: 'xai', modelID: 'missing' })).toBeNull();
  });

  it('evicts least-recently-used evidence at the configured entry limit', () => {
    const cache = createXaiToolCatalogCache({ maxEntries: 1 });
    cache.remember({ directory: '/repo', providerID: 'xai', modelID: 'first', catalog: [tool('first')] });
    cache.remember({ directory: '/repo', providerID: 'xai', modelID: 'second', catalog: [tool('second')] });

    expect(cache.get({ directory: '/repo', providerID: 'xai', modelID: 'first' })).toBeNull();
    expect(cache.get({ directory: '/repo', providerID: 'xai', modelID: 'second' })).toEqual({});
  });

  it('fails open instead of retaining an entry above the byte limit', () => {
    const cache = createXaiToolCatalogCache({ maxBytes: 1 });
    cache.remember({ directory: '/repo', providerID: 'xai', modelID: 'large', catalog: [tool('large')] });

    expect(cache.get({ directory: '/repo', providerID: 'xai', modelID: 'large' })).toBeNull();
  });
});
