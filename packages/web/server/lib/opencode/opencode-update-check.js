/**
 * Read-only lookup of the latest stable upstream OpenCode 2.x release.
 *
 * It requests one fixed public npm registry document (the `@opencode/cli`
 * `latest` dist-tag), sends no credentials or user data, and never installs
 * anything. Bundled runtime updates still arrive only through DevRyan updates.
 */

export const OPENCODE_UPDATE_REGISTRY_URL = 'https://registry.npmjs.org/@opencode%2Fcli/latest';
export const OPENCODE_UPDATE_TIMEOUT_MS = 10_000;
export const OPENCODE_UPDATE_MAX_BODY_BYTES = 256 * 1024;

const STABLE_V2_VERSION = /^2\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

export const OPENCODE_UPDATE_CHECK_CODES = Object.freeze({
  registryUnavailable: 'opencode_update_registry_unavailable',
  registryTimeout: 'opencode_update_registry_timeout',
  metadataInvalid: 'opencode_update_metadata_invalid',
  versionUnsupported: 'opencode_update_version_unsupported',
});

const KNOWN_CODES = new Set(Object.values(OPENCODE_UPDATE_CHECK_CODES));

export class OpenCodeUpdateCheckError extends Error {
  constructor(code) {
    super(code);
    this.name = 'OpenCodeUpdateCheckError';
    this.code = code;
  }
}

const fail = (code) => new OpenCodeUpdateCheckError(code);

export const isStableOpenCodeV2Version = (value) => typeof value === 'string' && STABLE_V2_VERSION.test(value);

const readBoundedText = async (response, maxBytes) => {
  const declared = Number(response.headers?.get?.('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) throw fail(OPENCODE_UPDATE_CHECK_CODES.metadataInvalid);
  const reader = response.body?.getReader?.();
  if (!reader) {
    const text = await response.text();
    if (Buffer.byteLength(text, 'utf8') > maxBytes) throw fail(OPENCODE_UPDATE_CHECK_CODES.metadataInvalid);
    return text;
  }
  const chunks = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => {});
      throw fail(OPENCODE_UPDATE_CHECK_CODES.metadataInvalid);
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength))).toString('utf8');
};

/**
 * Returns `{ latestVersion }` or throws an OpenCodeUpdateCheckError whose
 * `code` is one of OPENCODE_UPDATE_CHECK_CODES. Upstream error text is never
 * propagated.
 */
export const checkLatestOpenCodeRelease = async ({
  fetchImpl = globalThis.fetch,
  signal,
  timeoutMs = OPENCODE_UPDATE_TIMEOUT_MS,
  maxBodyBytes = OPENCODE_UPDATE_MAX_BODY_BYTES,
} = {}) => {
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; controller.abort(); }, timeoutMs);
  const abortFromCaller = () => controller.abort();
  if (signal?.aborted) controller.abort();
  else signal?.addEventListener?.('abort', abortFromCaller, { once: true });
  try {
    let text;
    try {
      const response = await fetchImpl(OPENCODE_UPDATE_REGISTRY_URL, {
        method: 'GET',
        headers: { Accept: 'application/json' },
        credentials: 'omit',
        redirect: 'error',
        signal: controller.signal,
      });
      if (!response?.ok) throw fail(OPENCODE_UPDATE_CHECK_CODES.registryUnavailable);
      text = await readBoundedText(response, maxBodyBytes);
    } catch (error) {
      if (timedOut) throw fail(OPENCODE_UPDATE_CHECK_CODES.registryTimeout);
      if (error instanceof OpenCodeUpdateCheckError) throw error;
      throw fail(OPENCODE_UPDATE_CHECK_CODES.registryUnavailable);
    }
    let metadata;
    try { metadata = JSON.parse(text); } catch { throw fail(OPENCODE_UPDATE_CHECK_CODES.metadataInvalid); }
    if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata) || typeof metadata.version !== 'string') {
      throw fail(OPENCODE_UPDATE_CHECK_CODES.metadataInvalid);
    }
    if (!isStableOpenCodeV2Version(metadata.version)) throw fail(OPENCODE_UPDATE_CHECK_CODES.versionUnsupported);
    return { latestVersion: metadata.version };
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener?.('abort', abortFromCaller);
  }
};

export const openCodeUpdateCheckFailureBody = (error) => ({
  error: 'opencode_update_check_failed',
  code: KNOWN_CODES.has(error?.code) ? error.code : OPENCODE_UPDATE_CHECK_CODES.registryUnavailable,
});

/** Express handler for `GET /api/config/opencode-update-check`. */
export const createOpenCodeUpdateCheckHandler = ({ fetchImpl, timeoutMs } = {}) => async (_req, res) => {
  const clientGone = new AbortController();
  const onClose = () => { if (!res.writableEnded) clientGone.abort(); };
  res.on('close', onClose);
  try {
    const result = await checkLatestOpenCodeRelease({ fetchImpl, timeoutMs, signal: clientGone.signal });
    if (clientGone.signal.aborted || res.writableEnded) return;
    res.setHeader('Cache-Control', 'no-store');
    res.status(200).json(result);
  } catch (error) {
    if (clientGone.signal.aborted || res.writableEnded) return;
    res.setHeader('Cache-Control', 'no-store');
    res.status(503).json(openCodeUpdateCheckFailureBody(error));
  } finally {
    res.off('close', onClose);
  }
};
