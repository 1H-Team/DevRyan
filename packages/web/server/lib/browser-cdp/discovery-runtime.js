// Discovery endpoint for the in-app browser CDP bridge.
//
// The Electron main process owns the bridge; this runtime is the read-only
// lookup the managed OpenCode child (and therefore `agent-browser`) uses to
// find it. The bridge status is injected as a live callback rather than read
// from process.env: an already-running child cannot observe later parent env
// mutations, so the bearer token is minted once at Electron startup, handed to
// the child at spawn time, and checked here on every request.
//
// Deterministic states, so an agent can branch without parsing prose:
//   disabled          - the user turned agent control of the browser off
//   no_target         - no browser tab is open, so there is nothing to attach
//   debugger_conflict - DevTools owns the guest's debugger
//   ready             - { wsUrl } is present and connectable

export const BROWSER_CDP_DISCOVERY_PATH = '/api/desktop/browser-cdp';

const LOOPBACK_ADDRESSES = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

export const isLoopbackSocketAddress = (address) => {
  if (typeof address !== 'string' || address.length === 0) return false;
  return LOOPBACK_ADDRESSES.has(address) || address.startsWith('127.');
};

// Constant-time-ish comparison so a wrong bearer cannot be probed by timing.
export const isMatchingDiscoveryToken = (expected, provided) => {
  if (typeof expected !== 'string' || expected.length === 0) return false;
  if (typeof provided !== 'string' || provided.length !== expected.length) return false;
  let mismatch = 0;
  for (let index = 0; index < expected.length; index += 1) {
    mismatch |= expected.charCodeAt(index) ^ provided.charCodeAt(index);
  }
  return mismatch === 0;
};

export const readBearerToken = (authorizationHeader) => {
  if (typeof authorizationHeader !== 'string') return '';
  const match = authorizationHeader.match(/^Bearer\s+(.+)$/i);
  return match ? match[1].trim() : '';
};

export const createBrowserCdpDiscoveryRuntime = ({ getBridgeStatus, getDiscoveryToken }) => {
  const handleRequest = async (req, res) => {
    // No caching, and never a permissive CORS header: this response carries a
    // capability URL.
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, private');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
    res.removeHeader?.('Access-Control-Allow-Origin');

    // Use the real peer address, never proxy-supplied headers: the app sets
    // `trust proxy`, which makes req.ip spoofable.
    const remoteAddress = req.socket?.remoteAddress;
    if (!isLoopbackSocketAddress(remoteAddress)) {
      return res.status(404).json({ state: 'unavailable' });
    }

    const expectedToken = typeof getDiscoveryToken === 'function' ? getDiscoveryToken() : '';
    if (!expectedToken) {
      return res.status(404).json({ state: 'unavailable' });
    }
    if (!isMatchingDiscoveryToken(expectedToken, readBearerToken(req.headers?.authorization))) {
      return res.status(401).json({ state: 'unauthorized' });
    }

    // The provider may be async: the Electron shell wakes a sleeping browser
    // guest on demand before reporting, so an agent can attach without the
    // user re-opening the panel.
    let status = { state: 'disabled' };
    try {
      status = (typeof getBridgeStatus === 'function' ? await getBridgeStatus() : null) || { state: 'disabled' };
    } catch {
      status = { state: 'disabled' };
    }
    if (status.state !== 'ready' || typeof status.wsUrl !== 'string' || !status.wsUrl) {
      return res.status(200).json({ state: status.state || 'disabled' });
    }

    return res.status(200).json({ state: 'ready', wsUrl: status.wsUrl });
  };

  const attach = (app) => {
    app.get(BROWSER_CDP_DISCOVERY_PATH, handleRequest);
  };

  return { attach, handleRequest };
};
