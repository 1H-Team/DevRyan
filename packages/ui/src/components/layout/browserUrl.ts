// Pure URL normalization for the in-app browser pane.
//
// Policy: only `about:blank`, `http:` and `https:` are ever returned. A
// schemeless input defaults to HTTP for localhost/loopback/local development
// hosts (their dev servers rarely speak TLS) and HTTPS for everything else.
// Anything unparseable or on another protocol collapses to `about:blank`.

const LOCAL_HTTP_HOSTS = new Set([
  'localhost',
  '127.0.0.1',
  '::1',
  '[::1]',
  '0.0.0.0',
]);

export const formatBrowserAddress = (url: string): string => {
  return !url || url === 'about:blank' ? '' : url;
};

export const isLocalDevServerHost = (hostname: string): boolean => {
  let host = hostname.trim().toLowerCase();
  if (!host) return false;
  if (host.startsWith('[') && host.endsWith(']')) host = host.slice(1, -1);
  if (LOCAL_HTTP_HOSTS.has(host) || host === '::1') return true;
  if (host.endsWith('.localhost') || host.endsWith('.local')) return true;
  if (/^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host)) return true;
  return false;
};

export const normalizeBrowserUrl = (value: string): string => {
  const trimmed = value.trim();
  if (!trimmed || trimmed === 'about:blank') return 'about:blank';

  try {
    if (trimmed.includes('://')) {
      const parsed = new URL(trimmed);
      if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
        return parsed.toString();
      }
      return 'about:blank';
    }

    // A colon followed by digits is a host:port (localhost:3000), not a
    // scheme; any other bare scheme (mailto:, javascript:, about:config…)
    // is refused.
    if (trimmed.startsWith('about:') || /^[a-z][a-z0-9+.-]*:(?!\d)/i.test(trimmed)) {
      return 'about:blank';
    }

    const secure = new URL(`https://${trimmed}`);
    if (isLocalDevServerHost(secure.hostname)) {
      return new URL(`http://${trimmed}`).toString();
    }
    if (!secure.hostname) return 'about:blank';
    return secure.toString();
  } catch {
    return 'about:blank';
  }
};
