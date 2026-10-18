import { LRUCache } from 'lru-cache';
import { requireReviewedWebfetchOwner } from '../../devryan/owners';
import type { FetchResult } from './types';

type CacheOptions = {
  /** llms.txt uses its own Accept header, so its cache entry omits format. */
  format?: 'text' | 'markdown' | 'html';
  extract_main: boolean;
  prefer_llms_txt: 'auto' | 'always' | 'never';
  save_binary: boolean;
};

export function calculateCacheSize(value: FetchResult): number {
  if ('binary' in value) return value.data?.byteLength ?? 1024;
  // llms.txt and plain-text pages point all four fields at the same
  // content, so charge bytes once per distinct string value.
  const refs = [value.rawContent, value.html, value.markdown, value.text];
  const seen = new Set<string>();
  let total = 0;
  for (const ref of refs) {
    if (typeof ref !== 'string' || seen.has(ref)) continue;
    seen.add(ref);
    total += Buffer.byteLength(ref);
  }
  return total;
}

// DevRyan: the cache is owned by the host per grant scope (createReviewed
// WebfetchCache) and reached through the invocation owner, never a global.
export type ReviewedFetchCache = LRUCache<string, FetchResult>;

export function createReviewedWebfetchCache(): ReviewedFetchCache {
  return new LRUCache<string, FetchResult>({
    maxSize: 50 * 1024 * 1024,
    ttl: 15 * 60 * 1000,
    sizeCalculation: calculateCacheSize,
  });
}

export function ownedCache(): ReviewedFetchCache {
  const cache = requireReviewedWebfetchOwner().cache;
  if (!(cache instanceof LRUCache)) throw new Error('reviewed_webfetch_cache_invalid');
  return cache;
}

export function lookup(key: string) {
  const status: LRUCache.Status<string, FetchResult> = {};
  const entry = ownedCache().get(key, {
    allowStale: true,
    noDeleteOnStaleGet: true,
    status,
  });
  return { entry, fresh: status.get === 'hit' };
}

export function conditionalHeaders(entry: FetchResult): Record<string, string> {
  return {
    ...(entry.etag ? { 'If-None-Match': entry.etag } : {}),
    ...(entry.lastModified ? { 'If-Modified-Since': entry.lastModified } : {}),
  };
}

export function buildCacheKey(url: string, options: CacheOptions) {
  const parsed = new URL(url);
  // Fragments never reach the server (RFC 3986 §3.5); #sec1 and #sec2 are
  // the same document, so they must share one cache entry.
  parsed.hash = '';
  return JSON.stringify({
    url: parsed.toString(),
    format: options.format,
    extractMain: options.extract_main,
    preferLlmsTxt: options.prefer_llms_txt,
    saveBinary: options.save_binary,
  });
}
