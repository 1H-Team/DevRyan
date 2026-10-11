import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  CHATGPT_SIWC_DYNAMIC_CLIENT_ID,
  buildSiwcAuthorizeUrl,
  createPkcePair,
  hasSiwcPlanUsage,
  listSiwcAccountModels,
  readOrCreateSiwcHostId,
} from './chatgpt-siwc.js';

const cleanups = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup(); });

describe('chatgpt siwc helpers', () => {
  it('persists a stable host id and builds a dynamic registration authorize URL', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'siwc-host-'));
    cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
    const first = readOrCreateSiwcHostId(dir);
    const second = readOrCreateSiwcHostId(dir);
    expect(first).toBe(second);
    expect(first).toMatch(/^urn:uuid:/);
    const pkce = createPkcePair();
    const url = new URL(buildSiwcAuthorizeUrl({
      clientId: CHATGPT_SIWC_DYNAMIC_CLIENT_ID,
      redirectUri: 'http://127.0.0.1:54321/auth/callback',
      state: 'state',
      nonce: 'nonce',
      codeChallenge: pkce.challenge,
      hostId: first,
      agentNameHint: 'DevRyan',
    }));
    expect(url.origin).toBe('https://auth.openai.com');
    expect(url.pathname).toBe('/api/accounts/authorize');
    expect(url.searchParams.get('client_id')).toBe(CHATGPT_SIWC_DYNAMIC_CLIENT_ID);
    expect(url.searchParams.get('agent_name_hint')).toBe('DevRyan');
    expect(url.searchParams.get('ext_agent_host_id')).toBe(first);
    expect(hasSiwcPlanUsage(['openid', 'chatgpt.tokens.use.direct'])).toBe(true);
  });

  it('lists models for the retained legacy Bot helpers', async () => {
    const fetchImpl = vi.fn(async () => Response.json({ models: [
      { slug: 'gpt-6.1-sol', visibility: 'list' }, { slug: 'hidden', visibility: 'none' },
    ] }));
    expect(await listSiwcAccountModels('fixture-access', { fetchImpl })).toEqual([
      { slug: 'gpt-6.1-sol', displayName: 'gpt-6.1-sol' },
    ]);
  });
});
