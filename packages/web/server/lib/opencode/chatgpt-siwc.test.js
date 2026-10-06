import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  CHATGPT_SIWC_DYNAMIC_CLIENT_ID,
  CHATGPT_SIWC_METHOD_ID,
  buildSiwcAuthorizeUrl,
  createPkcePair,
  hasSiwcPlanUsage,
  listSiwcAccountModels,
  readOrCreateSiwcHostId,
} from './chatgpt-siwc.js';
import { createChatgptSiwcEnrollmentOwner } from './chatgpt-siwc-enrollment.js';
import { annotateOpenAIModelAvailability } from './openai-model-availability.js';
import { clearSiwcAccountModelCache, resolveSiwcAccountModels } from './openai-siwc-model-catalog.js';

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

  it('lists SIWC account models and annotates unavailable catalog rows', async () => {
    clearSiwcAccountModelCache();
    const fetchImpl = vi.fn(async () => Response.json({
      models: [
        { slug: 'gpt-6.1-sol', visibility: 'list' },
        { slug: 'hidden', visibility: 'none' },
      ],
    }));
    expect(await listSiwcAccountModels('access-token', { fetchImpl })).toEqual([{ slug: 'gpt-6.1-sol', displayName: 'gpt-6.1-sol' }]);
    const auth = {
      type: 'oauth',
      methodID: CHATGPT_SIWC_METHOD_ID,
      access: 'access-token',
      refresh: 'refresh-token',
      clientId: 'oaiapp_issued',
      scopes: ['openid', 'chatgpt.tokens.use.direct'],
      accountId: 'account-a',
    };
    const slugs = await resolveSiwcAccountModels(auth, { fetchImpl });
    expect([...slugs]).toEqual([{ slug: 'gpt-6.1-sol', displayName: 'gpt-6.1-sol' }]);
    const annotated = annotateOpenAIModelAvailability({
      providers: [{
        id: 'openai',
        models: {
          'gpt-6.1-sol': { id: 'gpt-6.1-sol' },
          'gpt-5.6': { id: 'gpt-5.6' },
        },
      }],
    }, auth, { accountModels: slugs });
    expect(annotated.providers[0].authType).toBe('oauth');
    expect(annotated.providers[0].models['gpt-6.1-sol'].available).not.toBe(false);
    expect(annotated.providers[0].models['gpt-5.6']).toMatchObject({
      available: false,
      unavailableReason: 'auth_type_unsupported',
      requiredAuthType: 'api',
    });
    expect(annotateOpenAIModelAvailability({
      providers: [{ id: 'openai', models: { 'gpt-5.6': { id: 'gpt-5.6' } } }],
    }, { type: 'oauth', methodID: 'chatgpt-browser', access: 'x', refresh: 'y' }).providers[0].models['gpt-5.6']).toMatchObject({ available: false, unavailableReason: 'reauthorization_required' });
  });
});

describe('chatgpt siwc enrollment owner', () => {
  it('rejects provider denial on loopback without persisting a credential', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'siwc-enroll-'));
    cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
    const persisted = [];
    const fetchImpl = vi.fn(async (url, init) => {
      assert.equal(String(url), 'https://auth.openai.com/api/accounts/oauth/token');
      const body = new URLSearchParams(init.body);
      expect(body.get('client_id')).toBe('oaiapp_issued');
      expect(body.get('code')).toBe('fixture-code');
      return Response.json({
        access_token: 'access-token',
        refresh_token: 'refresh-token',
        id_token: 'id-token',
        expires_in: 3600,
        scope: 'openid profile email offline_access resource.invoke chatgpt.tokens.use.direct',
      });
    });
    const owner = createChatgptSiwcEnrollmentOwner({
      dataDirectory: dir,
      persistCredential: async (input) => { persisted.push(input); },
      fetchImpl,
      createServer: (handler) => http.createServer(handler),
    });
    cleanups.push(() => owner.close());

    const begin = await owner.begin({ directory: '/fixture/project' });
    expect(begin.status).toBe('pending');
    expect(begin.methodID).toBe(CHATGPT_SIWC_METHOD_ID);
    const authorize = new URL(begin.url);
    const redirectUri = authorize.searchParams.get('redirect_uri');
    const state = authorize.searchParams.get('state');
    expect(redirectUri).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/auth\/callback$/);

    const denied = await fetch(`${redirectUri}?error=access_denied&state=${state}`);
    expect(denied.status).toBe(400);
    await expect(owner.complete(begin.enrollmentID, {}, { directory: '/fixture/project' }))
      .rejects.toMatchObject({ code: 'native_chatgpt_siwc_access_denied' });
    expect(persisted).toEqual([]);
  });
});
