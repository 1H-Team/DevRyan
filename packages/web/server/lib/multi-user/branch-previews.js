import crypto from 'node:crypto';

const MAX_PREVIEW_URL_LENGTH = 4_096;
const MAX_CLIENT_ID_LENGTH = 512;
const MAX_CLIENT_SECRET_LENGTH = 2_048;
const CONNECTION_TIMEOUT_MS = 10_000;
const MAX_REDIRECTS = 4;
const ACCESS_AUTH_FAILED_MESSAGE = 'Cloudflare Access rejected the branch preview service token. Verify that the token is enabled, unexpired, and included in a Service Auth policy for this preview.';

const escapeFilterValue = (value) => String(value).replace(/[(),]/g, '');

const branchPreviewError = (code, message, statusCode = 400) => Object.assign(new Error(message), {
  code,
  statusCode,
});

export const normalizeBranchPreviewUrl = (value) => {
  const input = typeof value === 'string' ? value.trim() : '';
  if (!input || input.length > MAX_PREVIEW_URL_LENGTH) {
    throw branchPreviewError('branch_preview_url_invalid', 'A preview URL is required');
  }
  let parsed;
  try {
    parsed = new URL(input);
  } catch {
    throw branchPreviewError('branch_preview_url_invalid', 'Preview URL must be a valid HTTPS URL');
  }
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password) {
    throw branchPreviewError('branch_preview_url_invalid', 'Preview URL must use HTTPS and cannot contain credentials');
  }
  return parsed.toString();
};

const normalizeServiceToken = (value) => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw branchPreviewError('branch_preview_service_token_invalid', 'Both Client ID and Client Secret are required');
  }
  const clientId = typeof value.clientId === 'string' ? value.clientId.trim() : '';
  const clientSecret = typeof value.clientSecret === 'string' ? value.clientSecret.trim() : '';
  if (
    !clientId
    || !clientSecret
    || clientId.length > MAX_CLIENT_ID_LENGTH
    || clientSecret.length > MAX_CLIENT_SECRET_LENGTH
    || clientId.includes('\u0000')
    || clientSecret.includes('\u0000')
  ) {
    throw branchPreviewError('branch_preview_service_token_invalid', 'Both Client ID and Client Secret are required');
  }
  return Object.freeze({ clientId, clientSecret });
};

export const publicBranchPreview = (row) => {
  if (!row) return null;
  return {
    previewUrl: row.preview_url,
    serviceTokenConfigured: Boolean(row.service_token_vault_ref),
    createdAt: row.created_at || null,
    updatedAt: row.updated_at || null,
  };
};

const isAccessLoginUrl = (value) => {
  try {
    return new URL(value).pathname.startsWith('/cdn-cgi/access/login');
  } catch {
    return false;
  }
};

const requestHeaders = (credential, origin, targetUrl) => {
  const target = new URL(targetUrl);
  if (!credential || target.origin !== origin) return { Accept: 'text/html,*/*;q=0.8' };
  return {
    Accept: 'text/html,*/*;q=0.8',
    'CF-Access-Client-Id': credential.clientId,
    'CF-Access-Client-Secret': credential.clientSecret,
  };
};

const probePreview = async ({ previewUrl, credential, fetchImpl }) => {
  const origin = new URL(previewUrl).origin;
  let currentUrl = previewUrl;
  let method = 'HEAD';
  for (let redirectCount = 0; redirectCount <= MAX_REDIRECTS; redirectCount += 1) {
    let response;
    try {
      response = await fetchImpl(currentUrl, {
        method,
        redirect: 'manual',
        signal: AbortSignal.timeout(CONNECTION_TIMEOUT_MS),
        headers: {
          ...requestHeaders(credential, origin, currentUrl),
          ...(method === 'GET' ? { Range: 'bytes=0-0' } : {}),
        },
      });
    } catch (error) {
      throw branchPreviewError(
        'branch_preview_unavailable',
        error?.name === 'TimeoutError'
          ? 'Branch preview connection timed out'
          : 'Branch preview could not be reached',
        502,
      );
    }
    if ((response.status === 405 || response.status === 501) && method === 'HEAD') {
      method = 'GET';
      redirectCount -= 1;
      continue;
    }
    const location = response.headers.get('location');
    if (response.status >= 300 && response.status < 400 && location) {
      const nextUrl = new URL(location, currentUrl).toString();
      if (isAccessLoginUrl(nextUrl)) {
        throw branchPreviewError(
          'branch_preview_auth_failed',
          ACCESS_AUTH_FAILED_MESSAGE,
          401,
        );
      }
      currentUrl = nextUrl;
      continue;
    }
    const accessChallenge = response.headers.get('cf-mitigated') === 'challenge';
    if (response.status === 401 || response.status === 403 || accessChallenge) {
      throw branchPreviewError(
        'branch_preview_auth_failed',
        ACCESS_AUTH_FAILED_MESSAGE,
        401,
      );
    }
    if (!response.ok && response.status !== 206) {
      throw branchPreviewError(
        'branch_preview_unavailable',
        `Branch preview returned HTTP ${response.status}`,
        502,
      );
    }
    return { ok: true, status: response.status, finalUrl: currentUrl, origin };
  }
  throw branchPreviewError('branch_preview_unavailable', 'Branch preview redirected too many times', 502);
};

export const createBranchPreviewService = ({ supabase, vault, fetchImpl = fetch } = {}) => {
  if (!supabase?.rest || !vault?.get || !vault?.set || !vault?.delete) {
    throw new Error('Branch preview service dependencies are required');
  }

  const queryFor = (userId, projectId, branchName) => ({
    user_id: `eq.${escapeFilterValue(userId)}`,
    project_id: `eq.${escapeFilterValue(projectId)}`,
    branch_name: `eq.${escapeFilterValue(branchName)}`,
  });

  const getRow = (userId, projectId, branchName) => supabase.rest('user_branch_previews', {
    query: { ...queryFor(userId, projectId, branchName), limit: 1 },
    maybeSingle: true,
  });

  const assertBranchGrant = async (userId, projectId, branchName) => {
    const grant = await supabase.rest('user_project_branches', {
      query: { ...queryFor(userId, projectId, branchName), limit: 1 },
      maybeSingle: true,
    });
    if (!grant) {
      throw branchPreviewError('branch_preview_grant_missing', 'Assigned branch was not found', 404);
    }
    return grant;
  };

  const credentialForRow = (row) => {
    if (!row?.service_token_vault_ref) return null;
    const credential = vault.get(row.service_token_vault_ref);
    if (!credential) {
      throw branchPreviewError(
        'branch_preview_auth_failed',
        'Branch preview service-token credential is unavailable',
        401,
      );
    }
    return normalizeServiceToken(credential);
  };

  const deleteVaultReferences = async (references) => {
    for (const reference of new Set((references || []).filter(Boolean))) {
      await vault.delete(reference);
    }
  };

  return Object.freeze({
    async list(userId, projectId) {
      const rows = await supabase.rest('user_branch_previews', {
        query: {
          user_id: `eq.${escapeFilterValue(userId)}`,
          project_id: `eq.${escapeFilterValue(projectId)}`,
          order: 'created_at.asc',
        },
      });
      return (rows || []).map((row) => ({
        branchName: row.branch_name,
        ...publicBranchPreview(row),
      }));
    },

    async upsert({ userId, projectId, branchName, previewUrl, serviceToken }) {
      await assertBranchGrant(userId, projectId, branchName);
      const normalizedUrl = normalizeBranchPreviewUrl(previewUrl);
      const existing = await getRow(userId, projectId, branchName);
      const replacement = serviceToken === undefined ? null : normalizeServiceToken(serviceToken);
      const credential = replacement || credentialForRow(existing);
      await probePreview({ previewUrl: normalizedUrl, credential, fetchImpl });
      const previousReference = existing?.service_token_vault_ref || null;
      const nextReference = replacement
        ? `branch-preview:${crypto.randomUUID()}`
        : previousReference;
      if (replacement) await vault.set(nextReference, replacement);
      let row;
      try {
        row = await supabase.rest('user_branch_previews', {
          method: 'POST',
          body: {
            user_id: userId,
            project_id: projectId,
            branch_name: branchName,
            preview_url: normalizedUrl,
            service_token_vault_ref: nextReference,
          },
          prefer: 'resolution=merge-duplicates,return=representation',
          maybeSingle: true,
        });
      } catch (error) {
        if (replacement) await vault.delete(nextReference).catch(() => {});
        throw error;
      }
      if (replacement && previousReference && previousReference !== nextReference) {
        await vault.delete(previousReference).catch(() => {});
      }
      return publicBranchPreview(row);
    },

    async remove({ userId, projectId, branchName }) {
      const existing = await getRow(userId, projectId, branchName);
      if (!existing) return false;
      await supabase.rest('user_branch_previews', {
        method: 'DELETE',
        query: queryFor(userId, projectId, branchName),
        prefer: 'return=minimal',
      });
      if (existing.service_token_vault_ref) await vault.delete(existing.service_token_vault_ref);
      return true;
    },

    async collectVaultReferences({ userId, projectId, branchNames = null }) {
      const query = {
        user_id: `eq.${escapeFilterValue(userId)}`,
        project_id: `eq.${escapeFilterValue(projectId)}`,
      };
      if (Array.isArray(branchNames) && branchNames.length > 0) {
        query.branch_name = `in.(${branchNames.map(escapeFilterValue).join(',')})`;
      }
      const rows = await supabase.rest('user_branch_previews', { query });
      return (rows || []).map((row) => row.service_token_vault_ref).filter(Boolean);
    },

    deleteVaultReferences,

    async test({ userId, projectId, branchName, previewUrl, serviceToken }) {
      await assertBranchGrant(userId, projectId, branchName);
      const existing = await getRow(userId, projectId, branchName);
      const normalizedUrl = normalizeBranchPreviewUrl(previewUrl || existing?.preview_url);
      const credential = serviceToken === undefined
        ? credentialForRow(existing)
        : normalizeServiceToken(serviceToken);
      const result = await probePreview({ previewUrl: normalizedUrl, credential, fetchImpl });
      return {
        ok: true,
        status: result.status,
        previewUrl: normalizedUrl,
        serviceTokenConfigured: Boolean(credential),
      };
    },

    async resolveLeaseContext({ userId, projectId, branchName }) {
      await assertBranchGrant(userId, projectId, branchName);
      const row = await getRow(userId, projectId, branchName);
      if (!row) return null;
      const previewUrl = normalizeBranchPreviewUrl(row.preview_url);
      const credential = credentialForRow(row);
      await probePreview({ previewUrl, credential, fetchImpl });
      return {
        metadata: {
          ownerUserId: userId,
          projectId,
          branchName,
          previewUrl,
          previewOrigin: new URL(previewUrl).origin,
          serviceTokenConfigured: Boolean(credential),
        },
        credential: credential
          ? { origin: new URL(previewUrl).origin, ...credential }
          : null,
      };
    },
  });
};
