import { normalizeProxyTargetUrl } from './proxy-runtime.js';

export const LOCAL_INSTANCE_MAX_URLS = 32;
export const LOCAL_INSTANCE_PROBE_TIMEOUT_MS = 500;
export const LOCAL_INSTANCE_PROBE_CONCURRENCY = 8;

const stripIpv6Brackets = (hostname) => (
  hostname.startsWith('[') && hostname.endsWith(']')
    ? hostname.slice(1, -1)
    : hostname
);

export const probeTcpEndpoint = ({ net, host, port, timeoutMs = LOCAL_INSTANCE_PROBE_TIMEOUT_MS }) => (
  new Promise((resolve) => {
    let settled = false;
    let socket;

    const finish = (reachable) => {
      if (settled) return;
      settled = true;
      try {
        socket?.destroy();
      } catch {
        // The result is already known; socket cleanup remains best-effort.
      }
      resolve(reachable);
    };

    try {
      socket = net.createConnection({ host, port });
      socket.setTimeout(timeoutMs);
      socket.once('connect', () => finish(true));
      socket.once('timeout', () => finish(false));
      socket.once('error', () => finish(false));
    } catch {
      finish(false);
    }
  })
);

const runBounded = async (items, concurrency, worker) => {
  const results = new Array(items.length);
  let nextIndex = 0;

  const runWorker = async () => {
    while (nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await worker(items[index], index);
    }
  };

  const workerCount = Math.min(Math.max(1, concurrency), items.length);
  await Promise.all(Array.from({ length: workerCount }, () => runWorker()));
  return results;
};

export const createLocalInstanceStatusRuntime = ({
  net,
  URL: URLCtor = URL,
  normalizeTargetUrl = normalizeProxyTargetUrl,
  probeEndpoint = (options) => probeTcpEndpoint({ net, ...options }),
  timeoutMs = LOCAL_INSTANCE_PROBE_TIMEOUT_MS,
  concurrency = LOCAL_INSTANCE_PROBE_CONCURRENCY,
  maxUrls = LOCAL_INSTANCE_MAX_URLS,
} = {}) => {
  const checkUrl = async (rawUrl) => {
    const url = typeof rawUrl === 'string' ? rawUrl.trim() : '';
    if (!url || url.length > 2048) {
      return { url, origin: null, status: 'invalid' };
    }

    const normalized = normalizeTargetUrl(url);
    if (!normalized?.ok || typeof normalized.origin !== 'string') {
      return { url, origin: null, status: 'invalid' };
    }

    let parsed;
    try {
      parsed = new URLCtor(normalized.origin);
    } catch {
      return { url, origin: null, status: 'invalid' };
    }

    const port = parsed.port
      ? Number.parseInt(parsed.port, 10)
      : parsed.protocol === 'https:' ? 443 : 80;
    const host = stripIpv6Brackets(parsed.hostname);
    const reachable = await probeEndpoint({ host, port, timeoutMs });

    return {
      url,
      origin: normalized.origin,
      status: reachable ? 'reachable' : 'unreachable',
    };
  };

  const checkUrls = async (urls) => {
    if (!Array.isArray(urls)) {
      throw new TypeError('urls must be an array');
    }
    if (urls.length > maxUrls) {
      const error = new RangeError(`urls must contain at most ${maxUrls} entries`);
      error.code = 'TOO_MANY_URLS';
      throw error;
    }
    return runBounded(urls, concurrency, checkUrl);
  };

  const attach = (app, {
    express,
    uiAuthController,
    isRequestOriginAllowed,
    classifyRequestScope = () => 'local',
    canUseBrowser = () => true,
  }) => {
    const statusHandler = (requireBrowser) => async (req, res) => {
      try {
        if (uiAuthController?.enabled) {
          const sessionToken = await uiAuthController.ensureSessionToken?.(req, res);
          if (!sessionToken) {
            return res.status(401).json({ error: 'UI authentication required' });
          }
        }

        if (requireBrowser && !canUseBrowser(req.principal)) {
          return res.status(403).json({ error: 'Browser access is disabled' });
        }

        if (classifyRequestScope(req) !== 'local') {
          return res.status(403).json({ error: 'Local instance probing is available only from loopback' });
        }

        const originAllowed = await isRequestOriginAllowed(req);
        if (!originAllowed) {
          return res.status(403).json({ error: 'Invalid origin' });
        }

        if (!Array.isArray(req.body?.urls)) {
          return res.status(400).json({ error: 'urls must be an array' });
        }
        if (req.body.urls.length > maxUrls) {
          return res.status(400).json({ error: `urls must contain at most ${maxUrls} entries` });
        }

        const results = await checkUrls(req.body.urls);
        return res.json({ results });
      } catch (error) {
        if (error?.code === 'TOO_MANY_URLS' || error instanceof TypeError) {
          return res.status(400).json({ error: error.message });
        }
        return res.status(500).json({ error: 'Failed to check local instances' });
      }
    };

    app.post('/api/preview/local-instances/status', express.json({ limit: '16kb' }), statusHandler(false));
    app.post('/api/browser/local-instances/status', express.json({ limit: '16kb' }), statusHandler(true));
  };

  return { attach, checkUrls };
};
