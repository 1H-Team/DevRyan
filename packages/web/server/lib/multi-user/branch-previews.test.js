import { describe, expect, it, vi } from 'vitest';

import {
  createBranchPreviewService,
  normalizeBranchPreviewUrl,
  publicBranchPreview,
} from './branch-previews.js';

const keyFor = (row) => `${row.user_id}:${row.project_id}:${row.branch_name}`;

const createHarness = ({ fetchImpl = vi.fn(async () => new Response('', { status: 200 })) } = {}) => {
  const grants = new Map();
  const previews = new Map();
  const credentials = new Map();
  grants.set('user-1:project-1:dev', {
    user_id: 'user-1', project_id: 'project-1', branch_name: 'dev', is_default: true,
  });

  const valuesFromQuery = (query) => ({
    user_id: String(query?.user_id || '').replace(/^eq\./, ''),
    project_id: String(query?.project_id || '').replace(/^eq\./, ''),
    branch_name: String(query?.branch_name || '').replace(/^eq\./, ''),
  });
  const matchingRows = (source, query) => [...source.values()].filter((row) => (
    (!query?.user_id || row.user_id === valuesFromQuery(query).user_id)
    && (!query?.project_id || row.project_id === valuesFromQuery(query).project_id)
    && (!query?.branch_name || row.branch_name === valuesFromQuery(query).branch_name)
  ));
  const supabase = {
    rest: vi.fn(async (table, options = {}) => {
      const source = table === 'user_project_branches' ? grants : previews;
      if (options.method === 'POST') {
        const row = {
          ...options.body,
          created_at: previews.get(keyFor(options.body))?.created_at || '2026-08-28T00:00:00.000Z',
          updated_at: '2026-08-28T00:00:01.000Z',
        };
        previews.set(keyFor(row), row);
        return row;
      }
      if (options.method === 'DELETE') {
        for (const row of matchingRows(source, options.query)) source.delete(keyFor(row));
        return null;
      }
      const rows = matchingRows(source, options.query);
      return options.maybeSingle ? rows[0] || null : rows;
    }),
  };
  const vault = {
    get: vi.fn((reference) => credentials.get(reference) || null),
    set: vi.fn(async (reference, value) => { credentials.set(reference, structuredClone(value)); }),
    delete: vi.fn(async (reference) => { credentials.delete(reference); }),
  };
  return {
    service: createBranchPreviewService({ supabase, vault, fetchImpl }),
    supabase,
    vault,
    previews,
    credentials,
    fetchImpl,
  };
};

describe('branch preview configuration', () => {
  it('normalizes HTTPS URLs and rejects embedded credentials or HTTP', () => {
    expect(normalizeBranchPreviewUrl(' https://dev1.1health.ae ')).toBe('https://dev1.1health.ae/');
    expect(() => normalizeBranchPreviewUrl('http://dev1.1health.ae')).toThrow(/HTTPS/);
    expect(() => normalizeBranchPreviewUrl('https://user:pass@dev1.1health.ae')).toThrow(/credentials/);
  });

  it('creates, preserves, rotates, redacts, and removes the service token', async () => {
    const harness = createHarness();
    const created = await harness.service.upsert({
      userId: 'user-1', projectId: 'project-1', branchName: 'dev',
      previewUrl: 'https://dev1.1health.ae',
      serviceToken: { clientId: 'first.access', clientSecret: 'first-secret' },
    });
    expect(created).toMatchObject({
      previewUrl: 'https://dev1.1health.ae/',
      serviceTokenConfigured: true,
    });
    expect(JSON.stringify(created)).not.toContain('first-secret');
    const firstRow = [...harness.previews.values()][0];
    const firstReference = firstRow.service_token_vault_ref;
    expect(firstRow).not.toHaveProperty('client_secret');

    await harness.service.upsert({
      userId: 'user-1', projectId: 'project-1', branchName: 'dev',
      previewUrl: 'https://dev1.1health.ae/app',
    });
    expect([...harness.previews.values()][0].service_token_vault_ref).toBe(firstReference);
    expect(harness.credentials.get(firstReference)?.clientSecret).toBe('first-secret');

    await harness.service.upsert({
      userId: 'user-1', projectId: 'project-1', branchName: 'dev',
      previewUrl: 'https://dev1.1health.ae/app',
      serviceToken: { clientId: 'second.access', clientSecret: 'second-secret' },
    });
    const rotatedReference = [...harness.previews.values()][0].service_token_vault_ref;
    expect(rotatedReference).not.toBe(firstReference);
    expect(harness.credentials.has(firstReference)).toBe(false);
    expect(harness.credentials.get(rotatedReference)?.clientSecret).toBe('second-secret');

    expect(await harness.service.remove({
      userId: 'user-1', projectId: 'project-1', branchName: 'dev',
    })).toBe(true);
    expect(harness.credentials.has(rotatedReference)).toBe(false);
    expect(harness.previews.size).toBe(0);
  });

  it('validates saves and first-use probes with Cloudflare headers without returning them', async () => {
    const fetchImpl = vi.fn(async () => new Response('', { status: 200 }));
    const harness = createHarness({ fetchImpl });
    await harness.service.upsert({
      userId: 'user-1', projectId: 'project-1', branchName: 'dev',
      previewUrl: 'https://dev1.1health.ae',
      serviceToken: { clientId: 'client.access', clientSecret: 'secret' },
    });
    const resolved = await harness.service.resolveLeaseContext({
      userId: 'user-1', projectId: 'project-1', branchName: 'dev',
    });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(fetchImpl.mock.calls[0][1].method).toBe('HEAD');
    expect(fetchImpl.mock.calls[0][1].headers['CF-Access-Client-Id']).toBe('client.access');
    expect(fetchImpl.mock.calls[1][1].headers['CF-Access-Client-Secret']).toBe('secret');
    expect(resolved.metadata).toEqual(expect.objectContaining({
      previewUrl: 'https://dev1.1health.ae/',
      serviceTokenConfigured: true,
    }));
    expect(JSON.stringify(resolved.metadata)).not.toContain('secret');
  });

  it('preserves the previous row and credential when replacement validation fails', async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(new Response('', { status: 200 }))
      .mockResolvedValueOnce(new Response('', {
        status: 302,
        headers: { Location: 'https://dev1.1health.ae/cdn-cgi/access/login/dev1' },
      }));
    const harness = createHarness({ fetchImpl });
    await harness.service.upsert({
      userId: 'user-1', projectId: 'project-1', branchName: 'dev',
      previewUrl: 'https://dev1.1health.ae',
      serviceToken: { clientId: 'first.access', clientSecret: 'first-secret' },
    });
    const previousRow = structuredClone([...harness.previews.values()][0]);
    const previousReference = previousRow.service_token_vault_ref;

    await expect(harness.service.upsert({
      userId: 'user-1', projectId: 'project-1', branchName: 'dev',
      previewUrl: 'https://dev1.1health.ae/app',
      serviceToken: { clientId: 'invalid.access', clientSecret: 'invalid-secret' },
    })).rejects.toMatchObject({
      code: 'branch_preview_auth_failed',
      statusCode: 401,
      message: expect.stringContaining('Service Auth'),
    });

    expect([...harness.previews.values()][0]).toEqual(previousRow);
    expect(harness.credentials.size).toBe(1);
    expect(harness.credentials.get(previousReference)).toEqual({
      clientId: 'first.access',
      clientSecret: 'first-secret',
    });
    expect(harness.vault.set).toHaveBeenCalledTimes(1);
  });

  it('does not persist a new preview when Cloudflare rejects its token', async () => {
    const harness = createHarness({
      fetchImpl: vi.fn(async () => new Response('', { status: 403 })),
    });

    await expect(harness.service.upsert({
      userId: 'user-1', projectId: 'project-1', branchName: 'dev',
      previewUrl: 'https://dev1.1health.ae',
      serviceToken: { clientId: 'expired.access', clientSecret: 'expired-secret' },
    })).rejects.toMatchObject({
      code: 'branch_preview_auth_failed',
      statusCode: 401,
      message: expect.stringContaining('enabled, unexpired'),
    });

    expect(harness.previews.size).toBe(0);
    expect(harness.credentials.size).toBe(0);
    expect(harness.vault.set).not.toHaveBeenCalled();
  });

  it('returns a clear auth failure instead of following the Access login loop', async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(new Response('', { status: 200 }))
      .mockResolvedValueOnce(new Response('', {
        status: 302,
        headers: { Location: 'https://dev1.1health.ae/cdn-cgi/access/login/dev1' },
      }));
    const harness = createHarness({ fetchImpl });
    await harness.service.upsert({
      userId: 'user-1', projectId: 'project-1', branchName: 'dev',
      previewUrl: 'https://dev1.1health.ae',
    });
    await expect(harness.service.resolveLeaseContext({
      userId: 'user-1', projectId: 'project-1', branchName: 'dev',
    })).rejects.toMatchObject({ code: 'branch_preview_auth_failed', statusCode: 401 });
  });

  it('projects only non-secret fields', () => {
    expect(publicBranchPreview({
      preview_url: 'https://dev1.1health.ae/',
      service_token_vault_ref: 'branch-preview:secret-ref',
      created_at: 'created',
      updated_at: 'updated',
    })).toEqual({
      previewUrl: 'https://dev1.1health.ae/',
      serviceTokenConfigured: true,
      createdAt: 'created',
      updatedAt: 'updated',
    });
  });
});
