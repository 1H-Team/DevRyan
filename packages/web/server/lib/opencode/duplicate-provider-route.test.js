import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { readProviderAuthRecord } from './auth.js';
import { createDuplicateProviderRouteResolver, DUPLICATE_PROVIDER_ROUTES } from './duplicate-provider-route.js';

const roots = [];
afterEach(async () => { for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true }); });
// A disposable auth file with synthetic values only; never the user's.
const authFile = async (records) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'duplicate-provider-route-')); roots.push(root);
  const file = path.join(root, 'auth.json');
  await fs.writeFile(file, JSON.stringify(records));
  return file;
};

describe('duplicate-output provider route attestation', () => {
  it('keeps the OpenAI managed ChatGPT OAuth route unchanged', () => {
    let oauth = true;
    const resolve = createDuplicateProviderRouteResolver({ openAiUsesOAuth: () => oauth,
      readAuthRecord: () => { throw new Error('OpenAI must not read the generic auth record'); } });
    expect(resolve('openai')).toBe('openai-chatgpt-managed-responses-v1');
    oauth = false;
    expect(resolve('openai')).toBeNull();
    expect(createDuplicateProviderRouteResolver({ openAiUsesOAuth: () => { throw new Error('unreadable'); } })('openai')).toBeNull();
    expect(createDuplicateProviderRouteResolver({})('openai')).toBeNull();
  });

  it('attests xAI only for an OAuth auth record read from OpenCode auth', async () => {
    const reads = [];
    const file = await authFile({
      xai: { type: 'oauth', access: 'synthetic-access-value', refresh: '', expires: 1 },
      openai: { type: 'api', key: 'synthetic-openai-value' },
    });
    const resolve = createDuplicateProviderRouteResolver({ openAiUsesOAuth: () => false,
      readAuthRecord: (providerID) => { reads.push(providerID); return readProviderAuthRecord(providerID, { authFile: file }); } });
    const route = resolve('xai');
    expect(route).toBe('xai-oauth-responses-v1');
    expect(JSON.stringify(route)).not.toContain('synthetic');
    expect(reads).toEqual(['xai']);

    // API-key xAI is a different transport and is never qualified.
    const apiKey = await authFile({ xai: { type: 'api', key: 'synthetic-xai-value' } });
    expect(createDuplicateProviderRouteResolver({ readAuthRecord: (id) => readProviderAuthRecord(id, { authFile: apiKey }) })('xai')).toBeNull();
    const missing = await authFile({});
    expect(createDuplicateProviderRouteResolver({ readAuthRecord: (id) => readProviderAuthRecord(id, { authFile: missing }) })('xai')).toBeNull();
    const absent = path.join(path.dirname(missing), 'absent.json');
    expect(createDuplicateProviderRouteResolver({ readAuthRecord: (id) => readProviderAuthRecord(id, { authFile: absent }) })('xai')).toBeNull();
    const corrupt = path.join(path.dirname(missing), 'corrupt.json'); await fs.writeFile(corrupt, '{');
    expect(createDuplicateProviderRouteResolver({ readAuthRecord: (id) => readProviderAuthRecord(id, { authFile: corrupt }) })('xai')).toBeNull();
    // Only the exact OpenCode provider key counts; quota aliases are not OpenCode routes.
    const alias = await authFile({ grok: { type: 'oauth', access: 'synthetic', refresh: '', expires: 1 } });
    expect(createDuplicateProviderRouteResolver({ readAuthRecord: (id) => readProviderAuthRecord(id, { authFile: alias }) })('xai')).toBeNull();
  });

  it('names no route for other providers, including Claude through Meridian', () => {
    const reads = [];
    const resolve = createDuplicateProviderRouteResolver({ openAiUsesOAuth: () => true,
      readAuthRecord: (providerID) => { reads.push(providerID); return { type: 'oauth' }; } });
    for (const providerID of ['anthropic', 'grok', 'opencode', 'xai-oauth', '', undefined, null, { toString: () => 'xai' }]) {
      expect(resolve(providerID)).toBeNull();
    }
    expect(reads).toEqual([]);
    expect(Object.isFrozen(DUPLICATE_PROVIDER_ROUTES)).toBe(true);
    expect(DUPLICATE_PROVIDER_ROUTES).toEqual({ openai: 'openai-chatgpt-managed-responses-v1', xai: 'xai-oauth-responses-v1' });
  });
});
