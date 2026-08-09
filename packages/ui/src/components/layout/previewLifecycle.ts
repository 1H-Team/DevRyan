const LOOPBACK_PREVIEW_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]', '0.0.0.0']);

export const isPreviewLoopbackHost = (hostname: string): boolean => (
  LOOPBACK_PREVIEW_HOSTS.has(hostname.toLowerCase())
);

export const parsePreviewHttpUrl = (value: string): URL | null => {
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
    if (parsed.hostname === '0.0.0.0' || parsed.hostname === 'localhost' || parsed.hostname === '::1' || parsed.hostname === '[::1]') {
      parsed.hostname = '127.0.0.1';
    }
    return parsed;
  } catch {
    return null;
  }
};

export const isBrowserHostRoutedUrl = (value: string): boolean => {
  const parsed = parsePreviewHttpUrl(value);
  return Boolean(parsed && isPreviewLoopbackHost(parsed.hostname));
};

/**
 * A reported in-frame route may be reused only by the proxy that owns the
 * same origin. A different origin is an intentional new target registration.
 */
export const resolvePreviewReloadUrl = (targetUrl: string, displayUrl: string): URL | null => {
  const target = parsePreviewHttpUrl(targetUrl);
  if (!target) return null;

  const display = parsePreviewHttpUrl(displayUrl);
  return display?.origin === target.origin ? display : target;
};

export const buildPreviewFrameKey = (
  tabID: string,
  targetKey: string,
  reloadGeneration: number,
): string => `${tabID}:${targetKey}:${reloadGeneration}`;

type PreviewProxyRestoreInput = {
  frameOrigin: string;
  parentOrigin: string;
  framePathname: string;
  proxyBasePath: string;
  bridgeInstalled: boolean;
};

export const shouldRestorePreviewProxyPath = ({
  frameOrigin,
  parentOrigin,
  framePathname,
  proxyBasePath,
  bridgeInstalled,
}: PreviewProxyRestoreInput): boolean => (
  frameOrigin === parentOrigin
  && !bridgeInstalled
  && !framePathname.startsWith(proxyBasePath)
);
