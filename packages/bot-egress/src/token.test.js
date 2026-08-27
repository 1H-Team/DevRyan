import { describe, expect, test } from 'bun:test';
import {
  EgressTokenError,
  createRuntimeToken,
  normalizeBrowserHosts,
  normalizeModelHosts,
  verifyRuntimeToken,
} from './token.js';

const SECRET = 'egress-signing-secret-0123456789abcdef';
const NOW = 1_800_000_000_000;

const issue = (overrides = {}) => createRuntimeToken({
  secret: SECRET,
  deploymentId: 'deployment-01',
  botId: 'bot-01',
  revisionId: 'revision-01',
  hosts: ['https://API.OpenAI.com/v1', 'api.anthropic.com'],
  issuedAt: NOW,
  expiresAt: NOW + 60_000,
  nonce: 'fixed_nonce_0123456789',
  ...overrides,
});

describe('model egress runtime tokens', () => {
  test('normalizes model URLs into exact host and port authorities', () => {
    expect(normalizeModelHosts([
      'https://API.OpenAI.com/v1',
      'api.openai.com',
      'http://models.example.test:8080/base',
    ])).toEqual([
      'api.openai.com:443',
      'models.example.test:8080',
    ]);
  });

  test('verifies signature, deployment, expiry, and active revision', async () => {
    const token = issue();
    const checks = [];
    const claims = await verifyRuntimeToken(token, {
      secret: SECRET,
      deploymentId: 'deployment-01',
      now: NOW + 1,
      isRevisionActive: async (revisionId, botId) => {
        checks.push({ revisionId, botId });
        return revisionId === 'revision-01' && botId === 'bot-01';
      },
    });
    expect(claims.hosts).toEqual(['api.anthropic.com:443', 'api.openai.com:443']);
    expect(checks).toEqual([{ revisionId: 'revision-01', botId: 'bot-01' }]);
  });

  test('rejects tampering, expiry, another deployment, and an inactive revision', async () => {
    const token = issue();
    const base = {
      secret: SECRET,
      deploymentId: 'deployment-01',
      now: NOW + 1,
      isRevisionActive: async () => true,
    };
    await expect(verifyRuntimeToken(`${token}x`, base)).rejects.toBeInstanceOf(EgressTokenError);
    await expect(verifyRuntimeToken(token, { ...base, now: NOW + 60_000 }))
      .rejects.toMatchObject({ code: 'bot_egress_token_expired' });
    await expect(verifyRuntimeToken(token, { ...base, deploymentId: 'deployment-02' }))
      .rejects.toMatchObject({ code: 'bot_egress_token_invalid' });
    await expect(verifyRuntimeToken(token, { ...base, isRevisionActive: async () => false }))
      .rejects.toMatchObject({ code: 'bot_egress_revision_inactive' });
  });

  test('rejects wildcards, credentials, and non-HTTP model destinations', () => {
    for (const hosts of [
      ['*.openai.com'],
      ['https://user:password@api.openai.com'],
      ['file:///tmp/model'],
    ]) {
      expect(() => normalizeModelHosts(hosts)).toThrow(EgressTokenError);
    }
  });

  test('binds browser capabilities to public-only or exact-host policy', async () => {
    const publicOnly = issue({
      purpose: 'browser',
      networkMode: 'public_only',
      hosts: [],
    });
    await expect(verifyRuntimeToken(publicOnly, {
      secret: SECRET,
      deploymentId: 'deployment-01',
      now: NOW + 1,
      isRevisionActive: async () => true,
    })).resolves.toMatchObject({
      purpose: 'browser',
      networkMode: 'public_only',
      hosts: [],
    });

    const allowlist = issue({
      purpose: 'browser',
      networkMode: 'allowlist',
      hosts: ['Example.COM:8443'],
    });
    await expect(verifyRuntimeToken(allowlist, {
      secret: SECRET,
      deploymentId: 'deployment-01',
      now: NOW + 1,
      isRevisionActive: async () => true,
    })).resolves.toMatchObject({
      purpose: 'browser',
      networkMode: 'allowlist',
      hosts: ['example.com:8443'],
    });
    expect(normalizeBrowserHosts(['example.com', 'https://example.com/path']))
      .toEqual(['example.com:443']);
  });

  test('revalidates AG-UI runs while allowing an explicit connection health capability', async () => {
    const checks = [];
    const verify = (token) => verifyRuntimeToken(token, {
      secret: SECRET,
      deploymentId: 'deployment-01',
      now: NOW + 1,
      isRevisionActive: async (revisionId, botId) => {
        checks.push({ revisionId, botId });
        return true;
      },
    });
    await expect(verify(issue({
      purpose: 'agent',
      hosts: ['agent.example.com'],
    }))).resolves.toMatchObject({
      purpose: 'agent',
      activationMode: 'required',
    });
    await expect(verify(issue({
      purpose: 'agent',
      revisionId: 'bot-01',
      activationMode: 'connection_health',
      hosts: ['agent.example.com'],
    }))).resolves.toMatchObject({
      purpose: 'agent',
      activationMode: 'connection_health',
    });
    expect(checks).toEqual([{ revisionId: 'revision-01', botId: 'bot-01' }]);
  });

  test('rejects health capabilities that are not scoped to their Bot identity', () => {
    expect(() => issue({
      purpose: 'agent',
      activationMode: 'connection_health',
      hosts: ['agent.example.com'],
    })).toThrow(EgressTokenError);
  });

  test('rejects ambiguous browser network policy', () => {
    expect(() => issue({
      purpose: 'browser',
      networkMode: 'public_only',
      hosts: ['example.com'],
    })).toThrow(EgressTokenError);
    expect(() => issue({
      purpose: 'browser',
      networkMode: 'allowlist',
      hosts: [],
    })).toThrow(EgressTokenError);
  });
});
