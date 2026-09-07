import { randomUUID } from 'node:crypto';

const MAX_REQUESTS = 128;
const NETWORK_TYPES = new Set(['Document', 'Fetch', 'XHR']);
const NETWORK_MAX_ENTRIES = 100;
const NETWORK_MAX_BYTES = 64 * 1024;
const NETWORK_TTL_MS = 5 * 60 * 1000;
const TRANSITIONS = new Set([
  'control_taken', 'control_returned', 'control_expired', 'control_release_failed',
  'navigate', 'relaunch', 'page_reset', 'browser_closed', 'profile_reset',
  'egress_token_rotated', 'target_changed',
]);
const MAX_NAVIGATIONS = 20;
const LOOP_WINDOW_MS = 15_000;
const LOOP_THRESHOLD = 3;
const MAX_MAIN_FRAME_REQUESTS = 8;
const MAX_TRAIL = 10;
const MAX_COOKIE_BLOCKS = 5;
const MAX_DIALOGS = 5;
const LOOP_DECAY_MS = 60_000;
const MAX_PATH_LENGTH = 200;
const MAX_DIALOG_MESSAGE = 160;

const UUID_SEGMENT = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const OPAQUE_SEGMENT = /^[A-Za-z0-9_+=-]{16,}$/u;
const LONG_DIGIT_RUN = /\d{6,}/u;

const maskPathSegment = (segment) => {
  let decoded = segment;
  try {
    decoded = decodeURIComponent(segment);
  } catch {
    // URL.pathname is already printable and safe to retain in encoded form.
  }
  return UUID_SEGMENT.test(decoded) || OPAQUE_SEGMENT.test(decoded) || LONG_DIGIT_RUN.test(decoded)
    ? '*'
    : segment;
};

const publicPath = (url) => {
  const path = url.pathname.split('/').map(maskPathSegment).join('/') || '/';
  return path.slice(0, MAX_PATH_LENGTH);
};

const publicTarget = (value) => {
  try {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password
      || url.hostname.length > 253) return null;
    return Object.freeze({
      origin: url.origin,
      host: url.hostname.toLowerCase(),
      path: publicPath(url),
    });
  } catch {
    return null;
  }
};

const boundedReason = (value) => (
  typeof value === 'string' && /^[A-Za-z0-9_.:-]{1,128}$/u.test(value) ? value : 'unknown'
);

const boundedDialogType = (value) => (
  typeof value === 'string' && /^(?:alert|beforeunload|confirm|prompt)$/u.test(value)
    ? value
    : 'unknown'
);

const boundedDialogMessage = (value) => (
  typeof value === 'string'
    ? value.replace(/[^\x20-\x7e]/gu, ' ').slice(0, MAX_DIALOG_MESSAGE)
    : ''
);

const pushBounded = (items, value, maximum) => {
  items.push(Object.freeze(value));
  while (items.length > maximum) items.shift();
};

// The managed policy hard-enables JavaScript and cookies, so routine engine
// filtering (SameSite defaults, third-party phaseout) is never actionable and
// must not surface as a warning. Only settings-driven blocks indicate drift.
const ACTIONABLE_COOKIE_BLOCK_REASONS = new Set(['UserPreferences']);

export function createBrowserDiagnostics({ now = Date.now } = {}) {
  const requests = new Map();
  const networkRequests = new Map();
  const mainFrameRequests = new Map();
  const navigations = [];
  const trail = [];
  const cookieBlocks = [];
  const dialogs = [];
  let revision = 0;
  let latest = null;
  let healthyAfterLoop = null;
  const streamId = randomUUID();
  const network = [];
  let networkBytes = Buffer.byteLength(JSON.stringify({ streamId, entries: [] }), 'utf8');
  let sequence = 0;
  let generation = 0;

  const pruneNetwork = () => {
    const cutoff = now() - NETWORK_TTL_MS;
    while (network.length && (network.length > NETWORK_MAX_ENTRIES
      || networkBytes > NETWORK_MAX_BYTES || network[0].entry.observedAt <= cutoff)) {
      networkBytes -= network.shift().bytes;
    }
  };
  const recordNetwork = (fields) => {
    const entry = Object.freeze({ sequence: ++sequence, observedAt: now(), generation, ...fields });
    const bytes = Buffer.byteLength(JSON.stringify(entry), 'utf8') + 1;
    network.push({ entry, bytes });
    networkBytes += bytes;
    pruneNetwork();
  };
  const recordTransition = (reason, nextGeneration = generation, failureCode) => {
    if (!TRANSITIONS.has(reason)) return;
    if (Number.isSafeInteger(nextGeneration) && nextGeneration >= 0) generation = nextGeneration;
    recordNetwork({ kind: 'lifecycle', reason,
      ...(typeof failureCode === 'string' && /^DEVRYAN_BOT_[A-Z0-9_]{1,96}$/u.test(failureCode)
        ? { failureCode } : {}),
    });
  };

  const publish = (diagnostic) => {
    revision += 1;
    latest = Object.freeze({
      revision,
      observedAt: now(),
      origin: diagnostic.origin ?? null,
      statusCode: Number.isInteger(diagnostic.statusCode) ? diagnostic.statusCode : null,
      redirectCount: Number.isInteger(diagnostic.redirectCount) ? diagnostic.redirectCount : 0,
      repetitionCount: Number.isInteger(diagnostic.repetitionCount) ? diagnostic.repetitionCount : 0,
      kind: diagnostic.kind,
      reason: boundedReason(diagnostic.reason),
      blockedHost: diagnostic.blockedHost ?? null,
    });
  };

  const touchRevision = () => {
    revision += 1;
    if (latest) latest = Object.freeze({ ...latest, revision });
  };

  const remember = (map, requestId, value, maximum) => {
    if (typeof requestId !== 'string' || !value) return;
    map.delete(requestId);
    map.set(requestId, value);
    while (map.size > maximum) map.delete(map.keys().next().value);
  };

  const requestFor = (requestId) => mainFrameRequests.get(requestId) || requests.get(requestId) || null;
  const networkRequestFor = (requestId) => {
    const request = networkRequests.get(requestId);
    if (request && request.observedAt > now() - NETWORK_TTL_MS) return request;
    networkRequests.delete(requestId);
    return null;
  };
  const targetFor = (requestId, url) => publicTarget(url) || requestFor(requestId)?.target || null;

  const publicSnapshot = () => {
    if (!latest) return null;
    if (latest.kind === 'site_rejection' && latest.reason === 'navigation_loop'
      && healthyAfterLoop && healthyAfterLoop.observedAt > latest.observedAt
      && now() - healthyAfterLoop.observedAt >= LOOP_DECAY_MS) {
      publish({
        ...healthyAfterLoop,
        kind: 'healthy',
        reason: 'navigation_loop_cleared',
      });
      healthyAfterLoop = null;
    }
    return Object.freeze({
      ...latest,
      trail: Object.freeze([...trail]),
      cookieBlocks: Object.freeze([...cookieBlocks]),
      dialogs: Object.freeze([...dialogs]),
    });
  };

  return Object.freeze({
    recordRequest({ requestId, url, type, mainFrame = false, redirected = false } = {}) {
      const target = publicTarget(url);
      if (!target) return;
      const previous = requestFor(requestId);
      const redirectHops = redirected && previous
        ? [...previous.redirectHops, `${previous.target.origin}\n${previous.target.path}`]
        : [...(previous?.redirectHops || [])];
      const request = Object.freeze({
        target,
        type: typeof type === 'string' ? type : 'Other',
        mainFrame: Boolean(mainFrame),
        redirectCount: (previous?.redirectCount || 0) + (redirected ? 1 : 0),
        redirectHops: Object.freeze(redirectHops.slice(-MAX_NAVIGATIONS)),
      });
      remember(requests, requestId, request, MAX_REQUESTS);
      if (NETWORK_TYPES.has(request.type)) {
        remember(networkRequests, requestId, { type: request.type, target, observedAt: now() }, MAX_REQUESTS);
      }
      if (request.mainFrame) remember(mainFrameRequests, requestId, request, MAX_MAIN_FRAME_REQUESTS);
    },
    recordResponse({ requestId, url, statusCode } = {}) {
      const request = requestFor(requestId);
      const networkRequest = networkRequestFor(requestId);
      const target = targetFor(requestId, url) || networkRequest?.target;
      if (target && networkRequest && Number.isInteger(statusCode)
        && statusCode >= 100 && statusCode <= 599) {
        recordNetwork({ kind: 'response', origin: target.origin, path: target.path,
          requestType: networkRequest.type, statusCode });
      }
      if (!target || !request?.mainFrame) return;
      const observedAt = now();
      const navigation = Object.freeze({ origin: target.origin, path: target.path, timestamp: observedAt });
      navigations.push(navigation);
      while (navigations.length > MAX_NAVIGATIONS) navigations.shift();
      const repetitionCount = navigations.filter((entry) => (
        entry.origin === target.origin
        && entry.path === target.path
        && observedAt - entry.timestamp <= LOOP_WINDOW_MS
      )).length;
      const redirectLoop = request.redirectHops.includes(`${target.origin}\n${target.path}`);
      const loop = repetitionCount >= LOOP_THRESHOLD || redirectLoop;
      pushBounded(trail, {
        kind: 'navigation',
        origin: target.origin,
        path: target.path,
        statusCode: Number.isInteger(statusCode) ? statusCode : null,
        redirectCount: request.redirectCount,
        observedAt,
      }, MAX_TRAIL);
      const diagnostic = {
        origin: target.origin,
        statusCode,
        redirectCount: request.redirectCount,
        repetitionCount,
      };
      if (loop) {
        healthyAfterLoop = null;
        publish({ ...diagnostic, kind: 'site_rejection', reason: 'navigation_loop' });
        return;
      }
      if (latest?.kind === 'site_rejection' && latest.reason === 'navigation_loop') {
        healthyAfterLoop = Object.freeze({ ...diagnostic, observedAt });
        return;
      }
      publish({ ...diagnostic, kind: 'healthy', reason: 'navigation_completed' });
    },
    recordCookieBlock({ requestId, url, reasons } = {}) {
      const request = requestFor(requestId);
      const networkRequest = networkRequestFor(requestId);
      const target = targetFor(requestId, url) || networkRequest?.target;
      if (!target || !Array.isArray(reasons)) return;
      const normalized = [...new Set(reasons.map(boundedReason).filter((reason) => reason !== 'unknown'))];
      if (networkRequest) {
        for (const reason of normalized.slice(0, MAX_COOKIE_BLOCKS)) {
          recordNetwork({ kind: 'cookie_block', origin: target.origin, path: target.path,
            requestType: networkRequest.type, reason });
        }
      }
      if (!request?.mainFrame) return;
      for (const reason of normalized.filter((candidate) => !ACTIONABLE_COOKIE_BLOCK_REASONS.has(candidate))) {
        pushBounded(cookieBlocks, {
          origin: target.origin,
          path: target.path,
          reason,
          observedAt: now(),
        }, MAX_COOKIE_BLOCKS);
      }
      const actionable = normalized.find((reason) => ACTIONABLE_COOKIE_BLOCK_REASONS.has(reason));
      if (!actionable) return;
      publish({
        origin: target.origin,
        kind: 'blocked_cookies',
        reason: `cookie_${actionable}`,
      });
    },
    recordFailure({ requestId, url, errorText, blockedReason } = {}) {
      const request = requestFor(requestId);
      const networkRequest = networkRequestFor(requestId);
      const target = targetFor(requestId, url) || networkRequest?.target;
      if (!target) return;
      const reason = blockedReason
        ? `blocked_${boundedReason(blockedReason)}`
        : `network_${boundedReason(errorText)}`;
      if (networkRequest) {
        recordNetwork({ kind: 'failure', origin: target.origin, path: target.path,
          requestType: networkRequest.type, reason });
      }
      if (errorText === 'net::ERR_ABORTED' && !blockedReason) return;
      pushBounded(trail, {
        kind: 'failure',
        origin: target.origin,
        path: target.path,
        reason,
        observedAt: now(),
      }, MAX_TRAIL);
      publish({
        origin: target.origin,
        kind: request?.mainFrame ? 'site_rejection' : 'subresource_failure',
        reason,
        blockedHost: request?.mainFrame ? null : target.host,
      });
    },
    recordDialog({ url, type, message } = {}) {
      const target = publicTarget(url);
      if (!target) return;
      const dialog = {
        kind: 'dialog',
        origin: target.origin,
        path: target.path,
        type: boundedDialogType(type),
        message: boundedDialogMessage(message),
        observedAt: now(),
      };
      pushBounded(dialogs, dialog, MAX_DIALOGS);
      pushBounded(trail, dialog, MAX_TRAIL);
      touchRevision();
    },
    recordPopupLimit({ url } = {}) {
      const target = publicTarget(url);
      if (!target) return;
      pushBounded(trail, {
        kind: 'failure',
        origin: target.origin,
        path: target.path,
        reason: 'popup_limit',
        observedAt: now(),
      }, MAX_TRAIL);
      touchRevision();
    },
    recordProxyFailure({ host, statusCode, reason } = {}) {
      if (typeof host !== 'string' || !/^(?=.{1,253}$)[A-Za-z0-9.-]+$/u.test(host)) return;
      recordNetwork({ kind: 'proxy_failure', origin: `https://${host.toLowerCase()}`,
        reason: boundedReason(reason),
        ...(Number.isInteger(statusCode) && statusCode >= 400 && statusCode <= 599 ? { statusCode } : {}),
      });
    },
    recordEgressDenied({ host, statusCode } = {}) {
      if (typeof host !== 'string' || !/^(?=.{1,253}$)[A-Za-z0-9.-]+$/u.test(host)) return;
      recordNetwork({ kind: 'proxy_failure', origin: `https://${host.toLowerCase()}`,
        reason: 'egress_policy_denied', statusCode: 403 });
      publish({
        origin: null,
        statusCode,
        kind: 'egress_denied',
        reason: 'egress_policy_denied',
        blockedHost: host.toLowerCase(),
      });
    },
    recordTransition,
    networkSnapshot() {
      pruneNetwork();
      return Object.freeze({ streamId, entries: Object.freeze(network.map(({ entry }) => entry)) });
    },
    reset(reason, nextGeneration) {
      recordTransition(reason, nextGeneration);
      if (reason === 'relaunch' || reason === 'profile_reset') networkRequests.clear();
      requests.clear();
      mainFrameRequests.clear();
      navigations.length = 0;
      trail.length = 0;
      cookieBlocks.length = 0;
      dialogs.length = 0;
      healthyAfterLoop = null;
      latest = null;
      revision += 1;
    },
    snapshot: publicSnapshot,
  });
}
