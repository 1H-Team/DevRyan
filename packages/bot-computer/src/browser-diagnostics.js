const MAX_REQUESTS = 128;
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
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return null;
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
  const mainFrameRequests = new Map();
  const navigations = [];
  const trail = [];
  const cookieBlocks = [];
  const dialogs = [];
  let revision = 0;
  let latest = null;
  let healthyAfterLoop = null;

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
      if (request.mainFrame) remember(mainFrameRequests, requestId, request, MAX_MAIN_FRAME_REQUESTS);
    },
    recordResponse({ requestId, url, statusCode } = {}) {
      const request = mainFrameRequests.get(requestId);
      const target = targetFor(requestId, url);
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
      const request = mainFrameRequests.get(requestId);
      if (!request?.mainFrame) return;
      const target = targetFor(requestId, url);
      if (!target || !Array.isArray(reasons)) return;
      const normalized = [...new Set(reasons.map(boundedReason).filter((reason) => reason !== 'unknown'))];
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
      if (request?.mainFrame && errorText === 'net::ERR_ABORTED' && !blockedReason) return;
      const target = targetFor(requestId, url);
      if (!target) return;
      const reason = blockedReason
        ? `blocked_${boundedReason(blockedReason)}`
        : `network_${boundedReason(errorText)}`;
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
    recordEgressDenied({ host, statusCode } = {}) {
      if (typeof host !== 'string' || !/^(?=.{1,253}$)[A-Za-z0-9.-]+$/u.test(host)) return;
      publish({
        origin: null,
        statusCode,
        kind: 'egress_denied',
        reason: 'egress_policy_denied',
        blockedHost: host.toLowerCase(),
      });
    },
    reset() {
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
