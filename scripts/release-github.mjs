// GitHub REST client for the release scripts.
//
// Every request has a timeout. Idempotent requests (GET, PATCH, PUT, DELETE)
// retry 5xx, 429, rate-limited 403 and network failures with backoff; POST is
// never blindly repeated. Every write passes assertReleaseWritesAllowed for the
// repository in its URL, so a dry run cannot reach the canonical repository
// whatever token it holds. Asset uploads stream the file and reconcile by
// digest between attempts instead of duplicating or trusting a partial upload.
import fs from 'node:fs';
import { Readable } from 'node:stream';
import { RELEASE_REPOSITORY } from '../packages/electron/release-assets.mjs';
import { assertReleaseWritesAllowed } from './release-artifacts.mjs';

const IDEMPOTENT = new Set(['GET', 'HEAD', 'PATCH', 'PUT', 'DELETE']);
const PAGE_SIZE = 100;

export class GitHubRequestError extends Error {
  constructor(method, target, response, text) {
    super(`GitHub ${method} ${target} failed (${response.status}): ${text.slice(0, 2000)}`);
    this.name = 'GitHubRequestError';
    this.status = response.status;
    this.body = text;
    this.retryable = retryableResponse(response);
    this.retryDelayMs = rateLimitDelayMs(response);
  }
}

/** Repository named by an api.github.com or uploads.github.com /repos/<owner>/<name>/ URL. */
export function repositoryOfUrl(url) {
  const { hostname, pathname } = new URL(url);
  const match = /^\/repos\/([^/]+\/[^/]+)(?:\/|$)/.exec(pathname);
  if (!['api.github.com', 'uploads.github.com'].includes(hostname) || !match) throw new Error(`Release writes need a repository URL, got ${url}`);
  return decodeURIComponent(match[1]);
}

/** The delay GitHub asks for, or null when the response is not a rate limit. */
function rateLimitDelayMs(response) {
  const retryAfter = response.headers.get('retry-after');
  if (retryAfter !== null && /^\d+$/.test(retryAfter.trim())) return Number(retryAfter) * 1000;
  if (response.headers.get('x-ratelimit-remaining') === '0') {
    const reset = Number(response.headers.get('x-ratelimit-reset'));
    if (Number.isFinite(reset)) return Math.max(0, reset * 1000 - Date.now());
  }
  return null;
}

/** 5xx and 429 always; 403 only when GitHub marks it as a (secondary) rate limit. */
export function retryableResponse(response) {
  return response.status >= 500 || response.status === 429 || (response.status === 403 && rateLimitDelayMs(response) !== null);
}

export function githubClient({ token, fetchImpl = fetch, repository = RELEASE_REPOSITORY, environment = process.env,
  wait = ms => new Promise(resolve => setTimeout(resolve, ms)), now = Date.now, random = Math.random,
  timeoutMs = 30_000, attempts = 4, maxDelayMs = 60_000, log = () => {} }) {
  if (!token) throw new Error('GITHUB_TOKEN is required (RELEASE_STAGING_TOKEN for a staging dry run)');
  const headers = { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' };
  const resolve = url => url.startsWith('https://') ? url : `https://api.github.com/repos/${repository}${url}`;
  // 1, 2, 4, 8 seconds plus up to 250 ms of jitter; GitHub's own delay wins when it sends one.
  const backoff = (attempt, askedMs = null) => Math.min(maxDelayMs, askedMs ?? 1000 * 2 ** (attempt - 1) + Math.floor(random() * 250));

  const request = async (method, url, { body, contentType, accept, allowNotFound = false, signal, timeoutMs: limit = timeoutMs,
    attempts: budget = IDEMPOTENT.has(method) ? attempts : 1, headers: extra = {} } = {}) => {
    const target = resolve(url);
    if (method !== 'GET' && method !== 'HEAD') assertReleaseWritesAllowed(environment, { repository: repositoryOfUrl(target) });
    let lastError;
    for (let attempt = 1; attempt <= budget; attempt++) {
      const payload = typeof body === 'function' ? body() : body;
      const streamed = payload instanceof ReadableStream;
      let response;
      try {
        response = await fetchImpl(target, {
          method,
          signal: AbortSignal.any([AbortSignal.timeout(limit), ...(signal ? [signal] : [])]),
          headers: { ...headers, ...(accept ? { Accept: accept } : {}), ...extra, ...(payload !== undefined ? { 'Content-Type': contentType ?? 'application/json' } : {}) },
          body: payload === undefined || streamed || Buffer.isBuffer(payload) ? payload : JSON.stringify(payload),
          ...(streamed ? { duplex: 'half' } : {}),
        });
      } catch (error) {
        // The caller's own deadline is final; a request timeout or socket failure is retried.
        if (signal?.aborted) throw error;
        lastError = error;
        if (attempt >= budget) break;
        log(`[github] ${method} ${target} attempt ${attempt} failed (${error.cause?.code ?? error.name}); retrying`);
        await wait(backoff(attempt));
        continue;
      }
      if (allowNotFound && response.status === 404) return null;
      // A repeated DELETE whose first attempt landed sees 404: the resource is gone either way.
      if (method === 'DELETE' && response.status === 404 && attempt > 1) return null;
      if (response.ok) return response.status === 204 || response.status === 205 ? null : response.json();
      lastError = new GitHubRequestError(method, target, response, await response.text());
      if (!lastError.retryable || attempt >= budget) throw lastError;
      log(`[github] ${method} ${target} attempt ${attempt} returned ${response.status}; retrying`);
      await wait(backoff(attempt, lastError.retryDelayMs));
    }
    throw Object.assign(new Error(`GitHub ${method} ${target} failed after ${budget} attempt(s): ${lastError?.message ?? 'unknown error'}`, { cause: lastError }),
      { retryable: true });
  };

  /** Every row of a page-numbered list endpoint. `key` selects the array in object responses. */
  const paginate = async (url, { key, maxPages = 50 } = {}) => {
    const rows = [];
    for (let page = 1; ; page++) {
      if (page > maxPages) throw new Error(`GitHub listing ${url} exceeded ${maxPages} pages`);
      const body = await request('GET', `${url}${url.includes('?') ? '&' : '?'}per_page=${PAGE_SIZE}&page=${page}`);
      const values = key ? body?.[key] : body;
      if (!Array.isArray(values)) throw new Error(`GitHub listing ${url} did not return an array`);
      rows.push(...values);
      if (values.length < PAGE_SIZE) return rows;
    }
  };

  /**
   * Asset rows named `name`, waiting up to `timeoutMs` for GitHub to compute
   * the digest of an uploaded asset (it can appear after the upload returns).
   */
  const settledAssets = async (releaseId, name, { timeoutMs: limit = 30_000, pollMs = 2_000 } = {}) => {
    const deadline = now() + limit;
    for (;;) {
      const rows = (await paginate(`/releases/${releaseId}/assets`)).filter(asset => asset.name === name);
      if (!rows.some(asset => asset.state === 'uploaded' && !asset.digest) || now() >= deadline) return rows;
      await wait(Math.min(pollMs, Math.max(0, deadline - now())));
    }
  };

  /**
   * Upload `file` as `name` to the release unless an identical asset is already
   * there. Before each attempt the asset list is reconciled: an uploaded asset
   * with the expected digest and size is accepted, any other row with this name
   * (partial `starter` upload, different bytes) is deleted. 422 already_exists,
   * 5xx, rate limits, timeouts and resets lead to another reconcile pass.
   */
  const uploadAsset = async (releaseId, { name, file, size, sha256 }, { attempts: budget = 3, timeoutMs: limit = 600_000, digestTimeoutMs = 30_000 } = {}) => {
    const digest = `sha256:${sha256}`;
    let lastError = null, posted = false;
    for (let attempt = 1; ; attempt++) {
      const rows = await settledAssets(releaseId, name, { timeoutMs: digestTimeoutMs });
      const match = rows.find(asset => asset.state === 'uploaded' && asset.digest === digest && asset.size === size);
      if (match) return { asset: match, uploaded: posted };
      if (attempt > budget) {
        throw new Error(`Upload of ${name} did not produce ${digest} after ${budget} attempt(s): ${lastError?.message ?? `found ${rows.map(row => `${row.state}/${row.digest ?? 'no digest'}`).join(', ') || 'no asset'}`}`, { cause: lastError });
      }
      for (const stale of rows) {
        log(`[github] deleting ${name} asset ${stale.id} (${stale.state}, ${stale.digest ?? 'no digest'}) before upload`);
        await request('DELETE', `/releases/assets/${stale.id}`);
      }
      posted = true;
      try {
        await request('POST', `https://uploads.github.com/repos/${repository}/releases/${releaseId}/assets?name=${encodeURIComponent(name)}`, {
          body: () => Readable.toWeb(fs.createReadStream(file)), contentType: 'application/octet-stream',
          headers: { 'Content-Length': String(size) }, timeoutMs: limit, attempts: 1 });
      } catch (error) {
        lastError = error;
        const exists = error.status === 422 && /already_exists/.test(error.body ?? '');
        if (!exists && !error.retryable) throw error;
        log(`[github] upload attempt ${attempt} of ${name} failed (${error.status ?? error.cause?.code ?? error.name}); reconciling`);
        if (!exists) await wait(backoff(attempt, error.retryDelayMs));
      }
    }
  };

  return { repository, request, paginate, settledAssets, uploadAsset };
}
