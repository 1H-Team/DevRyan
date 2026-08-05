const DEFAULT_PUBLIC_VERIFICATION_TIMEOUT_MS = 15000;
const DEFAULT_PUBLIC_VERIFICATION_INTERVAL_MS = 500;
const DEFAULT_PUBLIC_REQUEST_TIMEOUT_MS = 2500;
const CLOUDFLARE_ERROR_STATUSES = new Set([502, 530, 1033]);

const delay = (durationMs) => new Promise((resolve) => setTimeout(resolve, durationMs));

export class ManagedRemotePublicReachabilityError extends Error {
  constructor(message, details = null) {
    super(message);
    this.name = 'ManagedRemotePublicReachabilityError';
    this.code = 'managed_remote_public_unreachable';
    this.details = details;
  }
}

const normalizeFetchErrorReason = (error) => {
  if (error?.name === 'AbortError') {
    return 'request_timeout';
  }
  const causeCode = typeof error?.cause?.code === 'string' ? error.cause.code : '';
  if (causeCode === 'ENOTFOUND' || causeCode === 'EAI_AGAIN') {
    return 'dns_failure';
  }
  return 'network_failure';
};

export async function verifyManagedRemotePublicReachability({
  publicUrl,
  expectedInstanceId,
  cloudflareOriginUrl,
  activeOriginUrl,
  fetchImpl = globalThis.fetch,
  timeoutMs = DEFAULT_PUBLIC_VERIFICATION_TIMEOUT_MS,
  intervalMs = DEFAULT_PUBLIC_VERIFICATION_INTERVAL_MS,
  requestTimeoutMs = DEFAULT_PUBLIC_REQUEST_TIMEOUT_MS,
  maxAttempts = Number.POSITIVE_INFINITY,
  now = Date.now,
  wait = delay,
}) {
  if (typeof fetchImpl !== 'function') {
    throw new ManagedRemotePublicReachabilityError(
      'The managed remote tunnel could not be verified because Fetch is unavailable.',
      { cloudflareOriginUrl, activeOriginUrl, reason: 'fetch_unavailable', lastStatus: null }
    );
  }

  const deadline = now() + timeoutMs;
  let attempt = 0;
  let lastStatus = null;
  let lastReason = 'verification_timeout';

  do {
    attempt += 1;
    const controller = new AbortController();
    const requestTimer = setTimeout(() => controller.abort(), requestTimeoutMs);
    try {
      const probeUrl = new URL('/health', publicUrl);
      probeUrl.searchParams.set('devryan_tunnel_probe', `${now()}-${attempt}`);
      const response = await fetchImpl(probeUrl, {
        method: 'GET',
        redirect: 'manual',
        cache: 'no-store',
        headers: { 'Cache-Control': 'no-cache' },
        signal: controller.signal,
      });
      lastStatus = response.status;
      const instanceId = response.headers?.get?.('x-devryan-instance-id') || '';
      if (response.ok && instanceId === expectedInstanceId) {
        return {
          verified: true,
          status: response.status,
          attempts: attempt,
        };
      }
      if (CLOUDFLARE_ERROR_STATUSES.has(response.status)) {
        lastReason = 'cloudflare_error';
      } else if (response.ok) {
        lastReason = 'instance_mismatch';
      } else {
        lastReason = 'unexpected_status';
      }
    } catch (error) {
      lastStatus = null;
      lastReason = normalizeFetchErrorReason(error);
    } finally {
      clearTimeout(requestTimer);
    }

    if (attempt >= maxAttempts) {
      break;
    }

    const remainingMs = deadline - now();
    if (remainingMs > 0) {
      await wait(Math.min(intervalMs, remainingMs));
    }
  } while (now() < deadline);

  throw new ManagedRemotePublicReachabilityError(
    'Cloudflare connected, but the public hostname did not reach this DevRyan instance.',
    {
      cloudflareOriginUrl,
      activeOriginUrl,
      reason: lastReason,
      lastStatus,
    }
  );
}
