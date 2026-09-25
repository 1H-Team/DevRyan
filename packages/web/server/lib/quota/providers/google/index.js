/**
 * Google Provider
 *
 * Google quota provider implementation.
 * @module quota/providers/google
 */

export {
  resolveGoogleOAuthClient,
  resolveGeminiCliAuth,
  resolveGoogleAuthSources,
  DEFAULT_PROJECT_ID
} from './auth.js';

export {
  resolveGoogleWindow,
  transformQuotaBucket,
  transformModelData
} from './transforms.js';

export {
  refreshGoogleAccessToken,
  fetchGoogleQuotaBuckets,
  fetchGoogleModels
} from './api.js';

import { buildResult } from '../../utils/index.js';
import {
  resolveGoogleAuthSources,
  resolveGoogleOAuthClient,
  DEFAULT_PROJECT_ID
} from './auth.js';
import { transformQuotaBucket, transformModelData } from './transforms.js';
import {
  refreshGoogleAccessToken,
  fetchGoogleQuotaBuckets,
  fetchGoogleModels
} from './api.js';

const fetchGoogleQuotaForSource = async ({
  sourceId,
  providerId,
  providerName,
  authSources = resolveGoogleAuthSources(),
  refreshAccessToken = refreshGoogleAccessToken,
  fetchQuotaBuckets = fetchGoogleQuotaBuckets,
  fetchModels = fetchGoogleModels
} = {}) => {
  const matchingSources = authSources.filter((source) => source.sourceId === sourceId);
  if (!matchingSources.length) {
    return buildResult({
      providerId,
      providerName,
      ok: false,
      configured: false,
      error: 'Not configured'
    });
  }

  const models = {};
  const sourceErrors = [];

  for (const source of matchingSources) {
    const now = Date.now();
    let accessToken = source.accessToken;

    if (!accessToken || (typeof source.expires === 'number' && source.expires <= now)) {
      if (!source.refreshToken) {
        sourceErrors.push(`${source.sourceLabel}: Missing refresh token`);
        continue;
      }
      const { clientId, clientSecret } = resolveGoogleOAuthClient();
      accessToken = await refreshAccessToken(source.refreshToken, clientId, clientSecret, source.sourceId);
    }

    if (!accessToken) {
      sourceErrors.push(`${source.sourceLabel}: Failed to refresh OAuth token`);
      continue;
    }

    const projectId = source.projectId ?? DEFAULT_PROJECT_ID;
    let mergedAnyModel = false;

    if (source.sourceId === 'gemini') {
      const quotaPayload = await fetchQuotaBuckets(accessToken, projectId, source.sourceId);
      const buckets = Array.isArray(quotaPayload?.buckets) ? quotaPayload.buckets : [];

      for (const bucket of buckets) {
        const transformed = transformQuotaBucket(bucket, source.sourceId);
        if (transformed) {
          Object.assign(models, transformed);
          mergedAnyModel = true;
        }
      }
    }

    const payload = await fetchModels(accessToken, projectId, source.sourceId);
    if (payload) {
      for (const [modelName, modelData] of Object.entries(payload.models ?? {})) {
        const transformed = transformModelData(modelName, modelData, source.sourceId);
        Object.assign(models, transformed);
        mergedAnyModel = true;
      }
    }

    if (!mergedAnyModel) {
      sourceErrors.push(`${source.sourceLabel}: Failed to fetch models`);
    }
  }

  if (!Object.keys(models).length) {
    return buildResult({
      providerId,
      providerName,
      ok: false,
      configured: true,
      error: sourceErrors[0] ?? 'Failed to fetch models'
    });
  }

  return buildResult({
    providerId,
    providerName,
    ok: true,
    configured: true,
    usage: {
      windows: {},
      models: Object.keys(models).length ? models : undefined
    }
  });
};

export const fetchGoogleQuota = async (options = {}) => fetchGoogleQuotaForSource({
  ...options,
  sourceId: 'gemini',
  providerId: 'google',
  providerName: 'Google'
});
