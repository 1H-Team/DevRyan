const MAX_REQUESTS = 128;
const MAX_NAVIGATIONS = 20;
const LOOP_WINDOW_MS = 15_000;
const LOOP_THRESHOLD = 3;

const publicTarget = (value) => {
  try {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return null;
    return Object.freeze({ origin: url.origin, host: url.hostname.toLowerCase() });
  } catch {
    return null;
  }
};

const boundedReason = (value) => (
  typeof value === 'string' && /^[A-Za-z0-9_.:-]{1,128}$/u.test(value) ? value : 'unknown'
);

// The managed policy hard-enables JavaScript and cookies, so routine engine
// filtering (SameSite defaults, third-party phaseout) is never actionable and
// must not surface as a warning. Only settings-driven blocks indicate drift.
const ACTIONABLE_COOKIE_BLOCK_REASONS = new Set(['UserPreferences']);

export function createBrowserDiagnostics({ now = Date.now } = {}) {
  const requests = new Map();
  const navigations = [];
  let revision = 0;
  let latest = null;

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

  const rememberRequest = (requestId, value) => {
    if (typeof requestId !== 'string' || !value) return;
    requests.delete(requestId);
    requests.set(requestId, value);
    while (requests.size > MAX_REQUESTS) requests.delete(requests.keys().next().value);
  };

  const targetFor = (requestId, url) => publicTarget(url) || requests.get(requestId)?.target || null;

  return Object.freeze({
    recordRequest({ requestId, url, type, mainFrame = false, redirected = false } = {}) {
      const target = publicTarget(url);
      if (!target) return;
      const previous = requests.get(requestId);
      rememberRequest(requestId, {
        target,
        type: typeof type === 'string' ? type : 'Other',
        mainFrame: Boolean(mainFrame),
        redirectCount: (previous?.redirectCount || 0) + (redirected ? 1 : 0),
      });
    },
    recordResponse({ requestId, url, statusCode } = {}) {
      const request = requests.get(requestId);
      const target = targetFor(requestId, url);
      if (!target || !request?.mainFrame) return;
      const timestamp = now();
      navigations.push({ origin: target.origin, timestamp });
      while (navigations.length > MAX_NAVIGATIONS) navigations.shift();
      const repetitionCount = navigations.filter((entry) => (
        entry.origin === target.origin && timestamp - entry.timestamp <= LOOP_WINDOW_MS
      )).length;
      publish({
        origin: target.origin,
        statusCode,
        redirectCount: request.redirectCount,
        repetitionCount,
        kind: repetitionCount >= LOOP_THRESHOLD ? 'site_rejection' : 'healthy',
        reason: repetitionCount >= LOOP_THRESHOLD ? 'navigation_loop' : 'navigation_completed',
      });
    },
    recordCookieBlock({ requestId, url, reasons } = {}) {
      if (!requests.get(requestId)?.mainFrame) return;
      const target = targetFor(requestId, url);
      if (!target || !Array.isArray(reasons)) return;
      const actionable = reasons.filter((reason) => ACTIONABLE_COOKIE_BLOCK_REASONS.has(reason));
      if (actionable.length === 0) return;
      publish({
        origin: target.origin,
        kind: 'blocked_cookies',
        reason: `cookie_${boundedReason(actionable[0])}`,
      });
    },
    recordFailure({ requestId, url, errorText, blockedReason } = {}) {
      const request = requests.get(requestId);
      const target = targetFor(requestId, url);
      if (!target) return;
      publish({
        origin: target.origin,
        kind: request?.mainFrame ? 'site_rejection' : 'subresource_failure',
        reason: blockedReason
          ? `blocked_${boundedReason(blockedReason)}`
          : `network_${boundedReason(errorText)}`,
        blockedHost: request?.mainFrame ? null : target.host,
      });
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
    snapshot: () => latest,
  });
}
