import { prepareLocalOwnerEnrollment } from '../server/lib/multi-user/local-owner-bootstrap.js';

// A CLI process proves filesystem ownership through a one-use challenge. It
// cannot enroll an owner implicitly, and keeps the resulting cookie in memory.
export function createOwnerAuthenticatedTunnelFetch({ getDataDirectory, fetchImpl = (...args) => fetch(...args) }) {
  const cookies = new Map();
  return async (url, options = {}) => {
    const target = new URL(url);
    if (target.protocol !== 'http:' || target.hostname !== '127.0.0.1'
      || !target.pathname.startsWith('/api/openchamber/tunnel/')) return fetchImpl(url, options);
    const request = () => fetchImpl(url, { ...options, headers: { ...options.headers,
      Origin: target.origin, 'X-DevRyan-CSRF': '1', ...(cookies.has(target.origin) ? { Cookie: cookies.get(target.origin) } : {}),
    } });
    const response = await request();
    if (response.status !== 403 || (await response.clone().json().catch(() => null))?.code !== 'local_owner_required') return response;
    const challenge = await prepareLocalOwnerEnrollment({ dataDirectory: getDataDirectory(), origin: target.origin, allowEnrollment: false });
    const token = new URLSearchParams(new URL(challenge.url).hash.slice(1)).get('t');
    const authenticated = await fetchImpl(`${target.origin}/auth/local-owner-bootstrap`, {
      method: 'POST', signal: options.signal, headers: { Origin: target.origin, 'Content-Type': 'application/json', 'X-DevRyan-CSRF': '1' },
      body: JSON.stringify({ token }),
    });
    const cookie = authenticated.headers.get('set-cookie')?.match(/(?:^|,\s*)devryan_local_owner=[A-Za-z0-9_-]{43}(?=;)/)?.[0].replace(/^,\s*/, '');
    if (!authenticated.ok || !cookie) throw Object.assign(new Error('Local owner authentication required. Run openchamber enroll-owner on this host and open its local link, then retry.'), { code: 'local_owner_required' });
    cookies.set(target.origin, cookie);
    return request();
  };
}
