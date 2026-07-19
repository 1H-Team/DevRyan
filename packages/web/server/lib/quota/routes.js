import express from 'express';

import { importCursorManagedCredential } from './credentials/cursor-import.js';
import {
  assertManagedQuotaCredential,
  deleteManagedQuotaCredential,
  getManagedQuotaCredentialStatus,
  readManagedQuotaCredential,
  writeManagedQuotaCredential,
} from './credentials/providers.js';
import {
  MAX_QUOTA_CREDENTIAL_PAYLOAD_BYTES,
  QuotaCredentialError,
  canonicalizeManagedQuotaProviderId,
} from './credentials/store.js';
import {
  fetchOpenCodeGoUsage,
  resolveOpenCodeGoCredentials,
} from './providers/opencode-go.js';
import {
  fetchOllamaCloudUsage,
  resolveOllamaCloudCredential,
} from './providers/ollama-cloud.js';
import {
  resolveCursorQuotaCredential,
  validateCursorQuotaCredential,
} from './providers/cursor-acp.js';

const jsonParser = express.json({ limit: MAX_QUOTA_CREDENTIAL_PAYLOAD_BYTES });

const sendCredentialError = (res, code, status) => res.status(status).json({
  code,
  error: {
    UNSUPPORTED_PROVIDER: 'Unsupported credential provider',
    INVALID_CREDENTIAL: 'Credential validation failed',
    NOT_CONFIGURED: 'Managed credential is not configured',
    IMPORT_UNAVAILABLE: 'Credential import is unavailable',
    PAYLOAD_TOO_LARGE: 'Credential payload is too large',
  }[code],
});

const parseCredentialBody = (req, res, next) => {
  const declaredLength = Number.parseInt(req.get('content-length') ?? '0', 10);
  if (Number.isFinite(declaredLength) && declaredLength > MAX_QUOTA_CREDENTIAL_PAYLOAD_BYTES) {
    sendCredentialError(res, 'PAYLOAD_TOO_LARGE', 413);
    return;
  }

  if (req.body !== undefined) {
    try {
      if (Buffer.byteLength(JSON.stringify(req.body), 'utf8') > MAX_QUOTA_CREDENTIAL_PAYLOAD_BYTES) {
        sendCredentialError(res, 'PAYLOAD_TOO_LARGE', 413);
        return;
      }
      next();
    } catch {
      sendCredentialError(res, 'INVALID_CREDENTIAL', 400);
    }
    return;
  }

  jsonParser(req, res, (error) => {
    if (!error) {
      next();
      return;
    }
    if (error.type === 'entity.too.large' || error.status === 413) {
      sendCredentialError(res, 'PAYLOAD_TOO_LARGE', 413);
      return;
    }
    sendCredentialError(res, 'INVALID_CREDENTIAL', 400);
  });
};

const defaultCredentialRuntime = {
  assertCredential: assertManagedQuotaCredential,
  deleteCredential: deleteManagedQuotaCredential,
  getStatus: getManagedQuotaCredentialStatus,
  importCursorCredential: importCursorManagedCredential,
  readCredential: readManagedQuotaCredential,
  writeCredential: writeManagedQuotaCredential,
  validate: async (providerId, credential) => {
    if (providerId === 'opencode-go') {
      await fetchOpenCodeGoUsage(credential);
      return credential;
    }
    if (providerId === 'ollama-cloud') {
      await fetchOllamaCloudUsage(credential);
      return credential;
    }
    return validateCursorQuotaCredential(credential);
  },
  getEffectiveSource: (providerId) => {
    if (providerId === 'opencode-go') return resolveOpenCodeGoCredentials().source;
    if (providerId === 'ollama-cloud') return resolveOllamaCloudCredential().source;
    return resolveCursorQuotaCredential().source;
  },
};

const resolveCredentialProvider = (req, res) => {
  try {
    return canonicalizeManagedQuotaProviderId(req.params.providerId);
  } catch {
    sendCredentialError(res, 'UNSUPPORTED_PROVIDER', 404);
    return null;
  }
};

const credentialStatus = (providerId, runtime) => ({
  ...runtime.getStatus(providerId),
  effectiveSource: runtime.getEffectiveSource(providerId) ?? null,
});

export function registerQuotaRoutes(app, {
  getQuotaProviders,
  resolveProjectDirectory,
  credentialRuntime: credentialRuntimeOverrides,
}) {
  const credentialRuntime = {
    ...defaultCredentialRuntime,
    ...credentialRuntimeOverrides,
  };

  const resolveQuotaDirectory = async (req) => {
    const headerDirectory = typeof req.get === 'function' ? req.get('x-opencode-directory') : null;
    const queryDirectory = Array.isArray(req.query?.directory)
      ? req.query.directory[0]
      : req.query?.directory;
    const requestedDirectory = headerDirectory || queryDirectory || null;

    if (!requestedDirectory) return null;
    if (typeof resolveProjectDirectory !== 'function') return requestedDirectory;

    const resolved = await resolveProjectDirectory(req);
    if (!resolved.directory) {
      const error = new Error(resolved.error || 'Invalid working directory');
      error.statusCode = 400;
      throw error;
    }
    return resolved.directory;
  };

  app.get('/api/quota/providers', async (req, res) => {
    try {
      const { listConfiguredQuotaProviders } = await getQuotaProviders();
      const workingDirectory = await resolveQuotaDirectory(req);
      res.json({ providers: listConfiguredQuotaProviders({ workingDirectory }) });
    } catch (error) {
      console.error('Failed to list quota providers:', error);
      res.status(error.statusCode || 500).json({ error: error.message || 'Failed to list quota providers' });
    }
  });

  app.get('/api/quota/credentials/:providerId', (req, res) => {
    const providerId = resolveCredentialProvider(req, res);
    if (providerId) res.json(credentialStatus(providerId, credentialRuntime));
  });

  app.put('/api/quota/credentials/:providerId', parseCredentialBody, async (req, res) => {
    const providerId = resolveCredentialProvider(req, res);
    if (!providerId) return;
    try {
      const { credential } = credentialRuntime.assertCredential(providerId, req.body);
      const validatedCredential = await credentialRuntime.validate(providerId, credential);
      credentialRuntime.writeCredential(providerId, validatedCredential ?? credential);
      res.json(credentialStatus(providerId, credentialRuntime));
    } catch (error) {
      if (error instanceof QuotaCredentialError && error.code === 'UNSUPPORTED_PROVIDER') {
        sendCredentialError(res, 'UNSUPPORTED_PROVIDER', 404);
        return;
      }
      sendCredentialError(res, 'INVALID_CREDENTIAL', 400);
    }
  });

  app.post('/api/quota/credentials/:providerId/validate', parseCredentialBody, async (req, res) => {
    const providerId = resolveCredentialProvider(req, res);
    if (!providerId) return;
    try {
      const hasBody = req.body && typeof req.body === 'object' && Object.keys(req.body).length > 0;
      const credential = hasBody
        ? credentialRuntime.assertCredential(providerId, req.body).credential
        : credentialRuntime.readCredential(providerId);
      if (!credential) {
        sendCredentialError(res, 'NOT_CONFIGURED', 404);
        return;
      }
      await credentialRuntime.validate(providerId, credential);
      res.json({ valid: true });
    } catch {
      sendCredentialError(res, 'INVALID_CREDENTIAL', 400);
    }
  });

  app.post('/api/quota/credentials/:providerId/import', parseCredentialBody, async (req, res) => {
    const providerId = resolveCredentialProvider(req, res);
    if (!providerId) return;
    if (providerId !== 'cursor-acp') {
      sendCredentialError(res, 'IMPORT_UNAVAILABLE', 404);
      return;
    }
    try {
      const imported = credentialRuntime.importCursorCredential();
      const validated = await credentialRuntime.validate(providerId, imported);
      credentialRuntime.writeCredential(providerId, validated ?? imported);
      res.json(credentialStatus(providerId, credentialRuntime));
    } catch {
      sendCredentialError(res, 'IMPORT_UNAVAILABLE', 400);
    }
  });

  app.delete('/api/quota/credentials/:providerId', (req, res) => {
    const providerId = resolveCredentialProvider(req, res);
    if (!providerId) return;
    credentialRuntime.deleteCredential(providerId);
    res.json(credentialStatus(providerId, credentialRuntime));
  });

  app.get('/api/quota/:providerId', async (req, res) => {
    try {
      const { providerId } = req.params;
      if (!providerId) return res.status(400).json({ error: 'Provider ID is required' });
      const { fetchQuotaForProvider } = await getQuotaProviders();
      const forceRefresh = req.query.refresh === 'true';
      const workingDirectory = await resolveQuotaDirectory(req);
      res.json(await fetchQuotaForProvider(providerId, { forceRefresh, workingDirectory }));
    } catch (error) {
      console.error('Failed to fetch quota:', error);
      res.status(error.statusCode || 500).json({ error: error.message || 'Failed to fetch quota' });
    }
  });
}
