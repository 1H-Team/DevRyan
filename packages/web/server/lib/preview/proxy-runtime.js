const DEFAULT_TARGET_TTL_MS = 30 * 60 * 1000;
const TOKEN_COOKIE_NAME = 'oc_preview_token';
const AUTH_SESSION_COOKIE_NAMES = ['oc_app_session', 'oc_ui_session', 'oc_tunnel_session'];
const isReservedPreviewCookieName = (name) => {
  const normalized = String(name || '').toLowerCase();
  return normalized.startsWith('oc_')
    || normalized.startsWith('devryan_')
    || normalized.startsWith('openchamber_')
    || normalized.startsWith('__host-');
};

// `__Host-`/`__Secure-` cookies cannot be stored under the rewritten proxy
// path, so they are carried across the viewer origin behind this marker and
// restored byte-exactly (names are case-sensitive upstream) on the way back.
const PRESERVED_COOKIE_MARKER = '__ocproxy-';
const isPrefixedAuthCookieName = (name) => /^__(?:host|secure)-/i.test(String(name || ''));

const PREVIEW_PASSTHROUGH_REQUEST_HEADERS = ['x-inertia', 'x-inertia-version'];
const PREVIEW_PASSTHROUGH_RESPONSE_HEADERS = ['x-inertia', 'x-inertia-location'];

const LOOPBACK_HOSTS = new Set([
  'localhost',
  '127.0.0.1',
  '::1',
  '[::1]',
  '0.0.0.0',
]);

// Compare origins without assuming the target is loopback. Loopback spellings
// collapse to 127.0.0.1 the same way `normalizeProxyTargetUrl` stores them, so
// a public target's own redirects stay recognized as same-origin.
const canonicalPreviewOrigin = (rawUrl) => {
  const url = new URL(rawUrl);
  if (LOOPBACK_HOSTS.has(url.hostname)) url.hostname = '127.0.0.1';
  return url.origin;
};

const normalizePreviewRequestHost = (value) => {
  const input = typeof value === 'string' ? value.trim().toLowerCase() : '';
  if (!input) return '';
  if (input.startsWith('[')) {
    const closingBracket = input.indexOf(']');
    return closingBracket >= 0 ? input.slice(1, closingBracket) : input.slice(1);
  }
  return input.replace(/:\d+$/, '');
};

// Loopback counts as secure: browsers treat it as a trustworthy context and do
// store Secure cookies there, so local dev servers keep their existing behavior.
const isPreviewViewerSecure = (req) => {
  if (req?.secure === true) return true;
  if (req?.socket?.encrypted === true) return true;
  return LOOPBACK_HOSTS.has(normalizePreviewRequestHost(req?.headers?.host));
};

const normalizePreviewRemoteAddress = (value) => {
  const input = typeof value === 'string' ? value.trim().toLowerCase().split('%', 1)[0] : '';
  if (input.startsWith('::ffff:')) return input.slice('::ffff:'.length);
  return input;
};

const isPreviewLoopbackAddress = (value) => {
  const address = normalizePreviewRemoteAddress(value);
  if (address === '::1') return true;
  const ipv4 = address.split('.').map((part) => Number(part));
  return ipv4.length === 4
    && ipv4.every((part) => Number.isInteger(part) && part >= 0 && part <= 255)
    && ipv4[0] === 127;
};

export const classifyPreviewRequestScope = (req, classifiedScope = 'local') => {
  if (classifiedScope === 'tunnel' || classifiedScope === 'unknown-public') return classifiedScope;
  // Use the actual Host header before Express' derived hostname. A trusted
  // reverse proxy may honor X-Forwarded-Host when deriving `req.hostname`,
  // but that must never make a public request look like loopback traffic.
  const host = normalizePreviewRequestHost(req?.headers?.host || req?.hostname);
  const remoteAddress = req?.socket?.remoteAddress || req?.connection?.remoteAddress;
  const trustedLoopback = (host === 'localhost' || isPreviewLoopbackAddress(host))
    && isPreviewLoopbackAddress(remoteAddress);
  return trustedLoopback ? 'local' : 'unknown-public';
};

const PREVIEW_BRIDGE_SCRIPT_ID = 'openchamber-preview-bridge';

const parsePreviewResourcePath = (url) => {
  try {
    const parsed = new URL(String(url || ''), 'http://localhost');
    const match = parsed.pathname.match(/^\/api\/preview\/proxy\/[a-f0-9]{16,64}(\/.*)?$/i);
    const path = match ? (match[1] || '/') : parsed.pathname;
    return path + parsed.search;
  } catch {
    return String(url || '');
  }
};

const readHeader = (headers, name) => {
  if (!headers || typeof headers !== 'object') return undefined;
  const direct = headers[name];
  if (direct !== undefined) return direct;
  const lowerName = name.toLowerCase();
  const key = Object.keys(headers).find((entry) => entry.toLowerCase() === lowerName);
  return key ? headers[key] : undefined;
};

export const applyPreviewPassthroughRequestHeaders = (req, proxyReq) => {
  for (const headerName of PREVIEW_PASSTHROUGH_REQUEST_HEADERS) {
    const value = readHeader(req?.headers, headerName);
    if (value !== undefined) {
      proxyReq.setHeader(headerName, value);
    }
  }
};

export const applyPreviewPassthroughResponseHeaders = (proxyRes, res) => {
  if (!res || res.headersSent || typeof res.setHeader !== 'function') return;
  for (const headerName of PREVIEW_PASSTHROUGH_RESPONSE_HEADERS) {
    const value = readHeader(proxyRes?.headers, headerName);
    if (value !== undefined) {
      res.setHeader(headerName, value);
    }
  }
};

const syncProxyResponseHeader = (headers, res, name) => {
  if (!res || typeof res.setHeader !== 'function') return;
  const value = readHeader(headers, name);
  if (value === undefined) {
    res.removeHeader?.(name);
    return;
  }
  res.setHeader(name, value);
};

const previewResourceNoiseRuleSets = [
  {
    name: 'vite',
    suppress: ({ lower, path, tag }) => path === '/@vite/client'
      || path === '/@react-refresh'
      || path.startsWith('/@id/__x00__vite/')
      || lower.includes('/node_modules/.vite/')
      || lower.includes('/vite/dist/client/')
      || (tag === 'script' && lower.includes('/@id/')),
  },
  {
    name: 'astro',
    suppress: ({ lower, path, tag }) => path.startsWith('/@id/astro:')
      || lower.includes('/astro/dist/runtime/client/dev-toolbar/')
      || (tag === 'script' && lower.includes('.astro?') && lower.includes('type=script'))
      || (tag === 'script' && (
        lower.endsWith('.css')
        || lower.includes('.css?')
        || lower.includes('type=style')
        || lower.includes('lang.css')
      )),
  },
  {
    name: 'next',
    suppress: ({ lower, path, tag }) => tag === 'script' && (
      path === '/_next/webpack-hmr'
      || lower.includes('/_next/static/webpack/')
      || lower.includes('/_next/static/chunks/webpack')
      || lower.includes('/_next/static/chunks/react-refresh')
      || lower.includes('/_next/static/development/')
    ),
  },
  {
    name: 'sveltekit',
    suppress: ({ lower, tag }) => tag === 'script' && (
      lower.includes('/@id/__x00__virtual:')
      || lower.includes('/@id/virtual:')
      || lower.includes('/.svelte-kit/generated/')
      || lower.includes('/node_modules/.vite/deps/')
    ),
  },
  {
    name: 'remix',
    suppress: ({ lower, tag }) => tag === 'script' && (
      lower.includes('/@remix-run/dev/')
      || lower.includes('/__manifest')
      || lower.includes('/__hmr')
    ),
  },
  {
    name: 'nuxt',
    suppress: ({ lower, tag }) => tag === 'script' && (
      lower.includes('/_nuxt/@vite/client')
      || lower.includes('/_nuxt/@id/')
      || lower.includes('/_nuxt/node_modules/.vite/')
      || lower.includes('/__nuxt_error')
      || lower.includes('/__nuxt_vite_node__')
    ),
  },
  {
    name: 'webpack',
    suppress: ({ lower, path, tag }) => tag === 'script' && (
      path === '/sockjs-node/info'
      || lower.includes('/webpack-dev-server/')
      || lower.includes('/webpack/hot/')
      || lower.includes('/__webpack_hmr')
      || lower.includes('/ws') && lower.includes('webpack')
    ),
  },
];

export const classifyPreviewResourceError = ({ tagName, url }) => {
  const tag = typeof tagName === 'string' ? tagName.toLowerCase() : '';
  if (tag !== 'script' && tag !== 'link') return 'report';

  const pathAndSearch = parsePreviewResourcePath(url);
  const lower = pathAndSearch.toLowerCase();
  const path = pathAndSearch.split('?', 1)[0] || '';
  const context = { tag, path, pathAndSearch, lower };

  if (previewResourceNoiseRuleSets.some((ruleSet) => ruleSet.suppress(context))) return 'suppress';

  return 'report';
};

export const classifyPreviewNavigation = ({ url, currentUrl }) => {
  let parsed;
  try {
    parsed = new URL(String(url || ''), currentUrl || 'http://localhost/');
  } catch {
    return { action: 'allow', url: String(url || '') };
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return { action: 'allow', url: parsed.toString() };
  }

  let current;
  try {
    current = new URL(currentUrl || 'http://localhost/');
  } catch {
    current = null;
  }

  if (current
    && parsed.origin === current.origin
    && parsed.pathname === current.pathname
    && parsed.search === current.search
    && parsed.hash
  ) {
    return { action: 'allow', url: parsed.toString() };
  }

  const path = parsed.pathname || '/';
  if (parsed.origin === current?.origin && path.startsWith('/api/preview/proxy/')) {
    return { action: 'allow', url: parsed.toString() };
  }

  const host = parsed.hostname;
  const isLoopback = host === 'localhost' || host === '127.0.0.1' || host === '0.0.0.0' || host === '::1' || host === '[::1]';
  if (isLoopback || (parsed.origin === current?.origin && path.startsWith('/'))) {
    return { action: 'proxy', url: parsed.toString() };
  }

  return { action: 'external', url: parsed.toString() };
};

const PREVIEW_BRIDGE_SCRIPT = String.raw`(() => {
  if (window.__openchamberPreviewBridgeInstalled) return;
  window.__openchamberPreviewBridgeInstalled = true;

  const SOURCE = 'openchamber-preview-bridge';
  const VERSION = 1;
  const MAX_TEXT = 500;
  const MAX_ARG = 1000;
  const previewConfig = window.__openchamberPreviewConfig || {};
  const proxyBasePath = typeof previewConfig.proxyBasePath === 'string' ? previewConfig.proxyBasePath : '';
  const targetOrigin = typeof previewConfig.targetOrigin === 'string' ? previewConfig.targetOrigin : '';
  const embedExternalNavigation = previewConfig.embedExternalNavigation === true;
  let inspectMode = false;
  let lastHoverKey = '';
  let pendingHover = null;
  let previewColorScheme = null;
  let nativeMatchMedia = null;
  const colorSchemeListeners = new Set();

  const post = (payload) => {
    try {
      if (window.parent && typeof window.parent.postMessage === 'function') {
        const message = Object.assign({ source: SOURCE, version: VERSION }, payload || {});
        window.parent.postMessage(message, window.location.origin);
      }
    } catch {}
  };

  const normalizedOrigin = (value) => {
    try {
      const parsed = new URL(value);
      const host = parsed.hostname;
      if (host === 'localhost' || host === '0.0.0.0' || host === '::1' || host === '[::1]') {
        parsed.hostname = '127.0.0.1';
      }
      return parsed.origin;
    } catch {
      return '';
    }
  };

  const toDisplayUrl = (value) => {
    try {
      const parsed = new URL(value || window.location.href, window.location.href);
      parsed.searchParams.delete('ocPreview');
      parsed.searchParams.delete('ocBrowser');
      if (!targetOrigin || parsed.origin !== window.location.origin) return parsed.toString();
      const path = proxyBasePath && parsed.pathname.indexOf(proxyBasePath) === 0
        ? parsed.pathname.slice(proxyBasePath.length) || '/'
        : parsed.pathname || '/';
      return new URL(path + parsed.search + parsed.hash, targetOrigin).toString();
    } catch {
      return String(value || '');
    }
  };

  const toProxyUrl = (value) => {
    try {
      const parsed = new URL(value, window.location.href);
      if (!proxyBasePath) return parsed.toString();
      const proxyBase = proxyBasePath.endsWith('/') ? proxyBasePath.slice(0, -1) : proxyBasePath;
      if (parsed.origin === window.location.origin
        && (parsed.pathname === proxyBase || parsed.pathname.indexOf(proxyBase + '/') === 0)) {
        return parsed.pathname + parsed.search + parsed.hash;
      }
      return proxyBase + (parsed.pathname || '/') + parsed.search + parsed.hash;
    } catch {
      return String(value || '');
    }
  };

  const reloadPreviewDocument = () => {
    post({ type: 'navigation-start', ts: Date.now() });
    try {
      const proxyUrl = toProxyUrl(window.location.href);
      if (proxyUrl && typeof window.location.replace === 'function') {
        window.location.replace(proxyUrl);
        return;
      }
    } catch {}
    try {
      window.location.reload();
    } catch {}
  };
  window.__openchamberPreviewReload = reloadPreviewDocument;

  const reportDisplayNavigation = () => {
    const url = toDisplayUrl(window.location.href);
    if (url) post({ type: 'navigate-preview', url, navigation: 'display', ts: Date.now() });
  };

  if (!window.__openchamberPreviewHistoryPatched) {
    window.__openchamberPreviewHistoryPatched = true;
    for (const method of ['pushState', 'replaceState']) {
      const original = window.history && window.history[method];
      if (typeof original !== 'function') continue;
      window.history[method] = function() {
        const result = original.apply(this, arguments);
        reportDisplayNavigation();
        return result;
      };
    }
    window.addEventListener('popstate', reportDisplayNavigation);
    window.addEventListener('hashchange', reportDisplayNavigation);
  }

  const clip = (value, max = MAX_TEXT) => {
    const text = String(value == null ? '' : value).replace(/\s+/g, ' ').trim();
    return text.length > max ? text.slice(0, max) + '...' : text;
  };

  const stringifyArg = (value) => {
    if (typeof value === 'string') return clip(value, MAX_ARG);
    if (value instanceof Error) return clip(value.stack || value.message || String(value), MAX_ARG);
    try {
      return clip(JSON.stringify(value), MAX_ARG);
    } catch {
      return clip(String(value), MAX_ARG);
    }
  };

  const normalizeColorScheme = (value) => value === 'dark' ? 'dark' : value === 'light' ? 'light' : null;

  const mediaQueryColorScheme = (query) => {
    const normalized = String(query || '').replace(/\s+/g, ' ').trim().toLowerCase();
    if (normalized === '(prefers-color-scheme: dark)') return 'dark';
    if (normalized === '(prefers-color-scheme: light)') return 'light';
    return null;
  };

  const mediaQueryMatchesPreviewScheme = (query) => {
    const scheme = mediaQueryColorScheme(query);
    if (!scheme || !previewColorScheme) return null;
    return previewColorScheme === scheme;
  };

  const notifyColorSchemeListeners = () => {
    for (const listener of Array.from(colorSchemeListeners)) {
      try {
        const matches = mediaQueryMatchesPreviewScheme(listener.media);
        if (matches === null) continue;
        const event = { matches, media: listener.media, type: 'change', target: listener.mql, currentTarget: listener.mql };
        listener.callback.call(listener.mql, event);
      } catch {}
    }
  };

  const installColorSchemeMatchMediaPatch = () => {
    if (window.__openchamberPreviewColorSchemePatched || typeof window.matchMedia !== 'function') return;
    window.__openchamberPreviewColorSchemePatched = true;
    nativeMatchMedia = window.matchMedia.bind(window);
    window.matchMedia = function(query) {
      const nativeMql = nativeMatchMedia(query);
      if (!mediaQueryColorScheme(query)) return nativeMql;
      const listenersForMql = new Map();
      const mql = Object.create(nativeMql);
      Object.defineProperty(mql, 'matches', { get: () => mediaQueryMatchesPreviewScheme(query) ?? nativeMql.matches });
      Object.defineProperty(mql, 'media', { get: () => nativeMql.media });
      mql.addEventListener = function(type, callback, options) {
        if (type !== 'change' || typeof callback !== 'function') return nativeMql.addEventListener?.(type, callback, options);
        const entry = { media: query, mql, callback };
        listenersForMql.set(callback, entry);
        colorSchemeListeners.add(entry);
      };
      mql.removeEventListener = function(type, callback, options) {
        if (type !== 'change' || typeof callback !== 'function') return nativeMql.removeEventListener?.(type, callback, options);
        const entry = listenersForMql.get(callback);
        if (entry) colorSchemeListeners.delete(entry);
        listenersForMql.delete(callback);
      };
      mql.addListener = function(callback) { mql.addEventListener('change', callback); };
      mql.removeListener = function(callback) { mql.removeEventListener('change', callback); };
      return mql;
    };
  };

  const shouldSyncDataTheme = () => {
    try {
      const root = document.documentElement;
      if (!root) return false;
      if (root.hasAttribute('data-theme')) return true;
      if (document.querySelector('starlight-theme-select, starlight-menu-button')) return true;
      const generator = document.querySelector('meta[name="generator"]');
      const generatorContent = generator && typeof generator.getAttribute === 'function' ? generator.getAttribute('content') || '' : '';
      if (generatorContent.toLowerCase().indexOf('starlight') >= 0) return true;
      const styles = window.getComputedStyle(root);
      return Boolean(styles.getPropertyValue('--sl-color-bg').trim()
        || styles.getPropertyValue('--sl-color-text').trim()
        || styles.getPropertyValue('--sl-color-accent').trim());
    } catch {
      return false;
    }
  };

  const applyPreviewColorScheme = (scheme) => {
    const next = normalizeColorScheme(scheme);
    if (!next || previewColorScheme === next) return;
    previewColorScheme = next;
    try {
      const root = document.documentElement;
      root.style.colorScheme = next;
      root.dataset.openchamberPreviewColorScheme = next;
      if (shouldSyncDataTheme()) {
        root.dataset.theme = next;
      }
    } catch {}
    notifyColorSchemeListeners();
  };

  const readElementUrl = (element) => {
    return element.currentSrc || element.src || element.href || element.action || '';
  };

  const upstreamPathForUrl = (value) => {
    try {
      const parsed = new URL(value, window.location.href);
      const match = parsed.pathname.match(/^\/api\/preview\/proxy\/[a-f0-9]{16,64}(\/.*)?$/i);
      return match ? (match[1] || '/') : parsed.pathname;
    } catch {
      return String(value || '');
    }
  };

  const upstreamPathAndSearchForUrl = (value) => {
    try {
      const parsed = new URL(value, window.location.href);
      const match = parsed.pathname.match(/^\/api\/preview\/proxy\/[a-f0-9]{16,64}(\/.*)?$/i);
      const path = match ? (match[1] || '/') : parsed.pathname;
      return path + parsed.search;
    } catch {
      return String(value || '');
    }
  };

  const isInternalDevToolResource = (element, value) => {
    const tag = element && element.tagName && typeof element.tagName.toLowerCase === 'function' ? element.tagName.toLowerCase() : '';
    if (tag !== 'script' && tag !== 'link') return false;
    if (tag === 'script' && typeof element.hasAttribute === 'function' && element.hasAttribute('data-cf-beacon')) return true;
    const pathAndSearch = upstreamPathAndSearchForUrl(value);
    const lower = pathAndSearch.toLowerCase();
    const path = pathAndSearch.split('?', 1)[0] || '';

    const viteNoise = path === '/@vite/client'
      || path === '/@react-refresh'
      || path.indexOf('/@id/__x00__vite/') === 0
      || lower.indexOf('/node_modules/.vite/') >= 0
      || lower.indexOf('/vite/dist/client/') >= 0
      || (tag === 'script' && lower.indexOf('/@id/') >= 0);
    const astroNoise = path.indexOf('/@id/astro:') === 0
      || lower.indexOf('/astro/dist/runtime/client/dev-toolbar/') >= 0
      || (tag === 'script' && lower.indexOf('.astro?') >= 0 && lower.indexOf('type=script') >= 0)
      || (tag === 'script' && (
        lower.endsWith('.css')
        || lower.indexOf('.css?') >= 0
        || lower.indexOf('type=style') >= 0
        || lower.indexOf('lang.css') >= 0
      ));
    const nextNoise = tag === 'script' && (
      path === '/_next/webpack-hmr'
      || lower.indexOf('/_next/static/webpack/') >= 0
      || lower.indexOf('/_next/static/chunks/webpack') >= 0
      || lower.indexOf('/_next/static/chunks/react-refresh') >= 0
      || lower.indexOf('/_next/static/development/') >= 0
    );
    const svelteKitNoise = tag === 'script' && (
      lower.indexOf('/@id/__x00__virtual:') >= 0
      || lower.indexOf('/@id/virtual:') >= 0
      || lower.indexOf('/.svelte-kit/generated/') >= 0
      || lower.indexOf('/node_modules/.vite/deps/') >= 0
    );
    const remixNoise = tag === 'script' && (
      lower.indexOf('/@remix-run/dev/') >= 0
      || lower.indexOf('/__manifest') >= 0
      || lower.indexOf('/__hmr') >= 0
    );
    const nuxtNoise = tag === 'script' && (
      lower.indexOf('/_nuxt/@vite/client') >= 0
      || lower.indexOf('/_nuxt/@id/') >= 0
      || lower.indexOf('/_nuxt/node_modules/.vite/') >= 0
      || lower.indexOf('/__nuxt_error') >= 0
      || lower.indexOf('/__nuxt_vite_node__') >= 0
    );
    const webpackNoise = tag === 'script' && (
      path === '/sockjs-node/info'
      || lower.indexOf('/webpack-dev-server/') >= 0
      || lower.indexOf('/webpack/hot/') >= 0
      || lower.indexOf('/__webpack_hmr') >= 0
      || (lower.indexOf('/ws') >= 0 && lower.indexOf('webpack') >= 0)
    );

    if (viteNoise || astroNoise || nextNoise || svelteKitNoise || remixNoise || nuxtNoise || webpackNoise) return true;
    return false;
  };

  installColorSchemeMatchMediaPatch();

  const classifyNavigation = (value) => {
    try {
      const parsed = new URL(value, window.location.href);
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return { action: 'allow', url: parsed.toString() };
      const current = new URL(window.location.href);
      if (parsed.origin === current.origin && parsed.pathname === current.pathname && parsed.search === current.search && parsed.hash) {
        return { action: 'allow', url: parsed.toString() };
      }
      if (parsed.origin === current.origin && parsed.pathname.startsWith('/api/preview/proxy/')) {
        return { action: 'allow', url: parsed.toString() };
      }
      const host = parsed.hostname;
      const isLoopback = host === 'localhost' || host === '127.0.0.1' || host === '0.0.0.0' || host === '::1' || host === '[::1]';
      const isRegisteredTarget = normalizedOrigin(parsed.toString()) === normalizedOrigin(targetOrigin);
      if (isLoopback || isRegisteredTarget || (parsed.origin === current.origin && parsed.pathname.startsWith('/'))) {
        return { action: 'proxy', url: parsed.toString() };
      }
      return { action: 'external', url: parsed.toString() };
    } catch {
      return { action: 'allow', url: String(value || '') };
    }
  };

  const handOffExternalNavigation = (value, event) => {
    const navigation = classifyNavigation(value);
    if (navigation.action !== 'external') return false;
    if (!event || event.cancelable !== false) event?.preventDefault?.();
    event?.stopPropagation?.();
    post({
      type: 'navigate-preview',
      url: navigation.url,
      navigation: embedExternalNavigation ? 'target' : 'external',
      ts: Date.now(),
    });
    return true;
  };

  const staysOnRegisteredTarget = (value) => {
    const navigationOrigin = normalizedOrigin(value);
    return navigationOrigin === normalizedOrigin(targetOrigin)
      || navigationOrigin === normalizedOrigin(window.location.origin);
  };

  const routeProxyNavigation = (value, event) => {
    const navigation = classifyNavigation(value);
    if (navigation.action !== 'proxy') return false;
    if (!staysOnRegisteredTarget(navigation.url)) {
      if (!event || event.cancelable !== false) event?.preventDefault?.();
      event?.stopPropagation?.();
      post({ type: 'navigate-preview', url: navigation.url, navigation: 'target', ts: Date.now() });
      return true;
    }
    const proxyUrl = toProxyUrl(navigation.url);
    if (!proxyUrl) return false;
    if (!event || event.cancelable !== false) event?.preventDefault?.();
    event?.stopPropagation?.();
    const displayUrl = toDisplayUrl(navigation.url);
    if (displayUrl) post({ type: 'navigate-preview', url: displayUrl, navigation: 'display', ts: Date.now() });
    post({ type: 'navigation-start', ts: Date.now() });
    try {
      window.location.assign(proxyUrl);
    } catch {
      window.location.href = proxyUrl;
    }
    return true;
  };

  if (window.navigation && typeof window.navigation.addEventListener === 'function') {
    window.navigation.addEventListener('navigate', (event) => {
      const destination = event && event.destination;
      if (!destination || typeof destination.url !== 'string') return;
      // pushState/replaceState/traversal stay in the current document. The
      // history patch above already reports their display URL; treating them
      // as document navigations reloads SPAs on every router state update.
      if (destination.sameDocument === true) return;
      if (handOffExternalNavigation(destination.url, event)) return;
      routeProxyNavigation(destination.url, event);
    });
  }

  window.addEventListener('submit', (event) => {
    const form = event.target;
    if (!form || typeof form.action !== 'string') return;
    const submitterAction = event.submitter && typeof event.submitter.formAction === 'string'
      ? event.submitter.formAction
      : '';
    const destination = submitterAction || form.action;
    if (handOffExternalNavigation(destination, event)) return;
    const navigation = classifyNavigation(destination);
    if (navigation.action !== 'proxy') return;
    if (!staysOnRegisteredTarget(navigation.url)) {
      if (!event || event.cancelable !== false) event?.preventDefault?.();
      event?.stopPropagation?.();
      post({ type: 'navigate-preview', url: navigation.url, navigation: 'target', ts: Date.now() });
      return;
    }
    const proxyUrl = toProxyUrl(navigation.url);
    if (!proxyUrl) return;
    if (submitterAction) {
      event.submitter.formAction = proxyUrl;
    } else {
      form.action = proxyUrl;
    }
    const displayUrl = toDisplayUrl(navigation.url);
    if (displayUrl) post({ type: 'navigate-preview', url: displayUrl, navigation: 'display', ts: Date.now() });
    post({ type: 'navigation-start', ts: Date.now() });
  }, true);

  const isInternalDevToolRuntimeError = (filename) => {
    const path = upstreamPathForUrl(filename || '');
    const pathAndSearch = upstreamPathAndSearchForUrl(filename || '');
    const lowerPathAndSearch = pathAndSearch.toLowerCase();
    const isStyleRuntimeNoise = lowerPathAndSearch.endsWith('.css')
      || lowerPathAndSearch.indexOf('.css?') >= 0
      || lowerPathAndSearch.indexOf('type=style') >= 0
      || lowerPathAndSearch.indexOf('lang.css') >= 0;
    return path === '/@vite/client'
      || path === '/@react-refresh'
      || path.indexOf('/astro/dist/runtime/client/dev-toolbar/') >= 0
      || path.indexOf('/node_modules/.vite/') >= 0
      || isStyleRuntimeNoise;
  };

  const isInternalDevToolConsoleNoise = (level, args) => {
    if (level !== 'error' || typeof args[0] !== 'string' || args[0].indexOf('[vite]') !== 0) return false;
    const text = args.map((arg) => stringifyArg(arg)).join(' ');
    return text.indexOf('failed to connect to websocket') >= 0
      || text.indexOf("Cannot read properties of undefined (reading 'send')") >= 0
      || text.indexOf('Cannot read properties of undefined (reading "send")') >= 0;
  };

  const installWebSocketProxyPatch = () => {
    if (window.__openchamberWebSocketProxyPatched || typeof window.WebSocket !== 'function') return;
    window.__openchamberWebSocketProxyPatched = true;
    const NativeWebSocket = window.WebSocket;
    const proxyBase = proxyBasePath.endsWith('/') ? proxyBasePath.slice(0, -1) : proxyBasePath;
    if (!proxyBase) return;
    let registeredTarget = null;
    try {
      registeredTarget = new URL(targetOrigin);
    } catch {}
    let reloadTimer = 0;

    const schedulePreviewReload = () => {
      if (reloadTimer) return;
      reloadTimer = window.setTimeout(() => {
        reloadTimer = 0;
        reloadPreviewDocument();
      }, 80);
    };

    const normalizedHost = (hostname) => {
      const host = String(hostname || '').toLowerCase();
      if (host === 'localhost' || host === '0.0.0.0' || host === '::1' || host === '[::1]') return '127.0.0.1';
      return host;
    };

    const effectivePort = (url) => {
      if (url.port) return url.port;
      return url.protocol === 'https:' || url.protocol === 'wss:' ? '443' : '80';
    };

    const belongsToRegisteredTarget = (url) => {
      if (url.host === window.location.host) return true;
      if (!registeredTarget) return false;
      return normalizedHost(url.hostname) === normalizedHost(registeredTarget.hostname)
        && effectivePort(url) === effectivePort(registeredTarget);
    };

    const rewriteUrl = (url) => {
      try {
        const parsed = new URL(String(url), window.location.href);
        if (!['http:', 'https:', 'ws:', 'wss:'].includes(parsed.protocol)) return url;
        if (parsed.pathname.indexOf(proxyBase) === 0) return url;
        if (!belongsToRegisteredTarget(parsed)) return url;
        parsed.protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
        parsed.host = window.location.host;
        const path = parsed.pathname && parsed.pathname.startsWith('/') ? parsed.pathname : '/';
        parsed.pathname = proxyBase + path;
        return parsed.toString();
      } catch {
        return url;
      }
    };

    function OpenChamberPreviewWebSocket(url, protocols) {
      const protocolList = Array.isArray(protocols) ? protocols : [protocols];
      const isViteSocket = protocolList.indexOf('vite-hmr') >= 0;
      const nextUrl = rewriteUrl(url);
      const socket = arguments.length === 1
        ? new NativeWebSocket(nextUrl)
        : new NativeWebSocket(nextUrl, protocols);

      if (isViteSocket) {
        socket.addEventListener('message', (event) => {
          try {
            const payload = JSON.parse(String(event.data || ''));
            if (payload && (payload.type === 'update' || payload.type === 'full-reload')) {
              schedulePreviewReload();
            }
          } catch {}
        });
      }

      return socket;
    }

    OpenChamberPreviewWebSocket.prototype = NativeWebSocket.prototype;
    Object.setPrototypeOf(OpenChamberPreviewWebSocket, NativeWebSocket);
    Object.defineProperty(OpenChamberPreviewWebSocket, 'name', { value: 'WebSocket' });
    window.WebSocket = OpenChamberPreviewWebSocket;
  };

  const installAppRequestProxyPatch = () => {
    if (window.__openchamberAppRequestProxyPatched) return;
    window.__openchamberAppRequestProxyPatched = true;
    const proxyBase = proxyBasePath.endsWith('/') ? proxyBasePath.slice(0, -1) : proxyBasePath;
    if (!proxyBase) return;

    let registeredTarget = null;
    try {
      registeredTarget = new URL(targetOrigin);
    } catch {}

    const normalizedHost = (hostname) => {
      const host = String(hostname || '').toLowerCase();
      if (host === 'localhost' || host === '0.0.0.0' || host === '::1' || host === '[::1]') return '127.0.0.1';
      return host;
    };

    const effectivePort = (url) => {
      if (url.port) return url.port;
      return url.protocol === 'https:' ? '443' : '80';
    };

    const belongsToRegisteredTarget = (url) => {
      if (url.origin === window.location.origin) return true;
      if (!registeredTarget) return false;
      return normalizedHost(url.hostname) === normalizedHost(registeredTarget.hostname)
        && effectivePort(url) === effectivePort(registeredTarget);
    };

    const proxiedUrl = (value) => {
      if (typeof value !== 'string' && !(value instanceof URL)) return value;
      try {
        if (typeof value === 'string' && value.trim().startsWith('#')) return value;
        const parsed = new URL(String(value), window.location.href);
        if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return value;
        if (parsed.pathname.indexOf(proxyBase) === 0) return value;
        if (!belongsToRegisteredTarget(parsed)) return value;
        return proxyBase + (parsed.pathname || '/') + parsed.search + parsed.hash;
      } catch {
        return value;
      }
    };

    if (typeof window.fetch === 'function') {
      const nativeFetch = window.fetch.bind(window);
      window.fetch = function(input, init) {
        if (typeof input === 'string' || input instanceof URL) {
          return nativeFetch(proxiedUrl(input), init);
        }
        if (input instanceof Request) {
          try {
            const nextUrl = proxiedUrl(input.url);
            if (typeof nextUrl === 'string' && nextUrl !== input.url) {
              return nativeFetch(new Request(nextUrl, input), init);
            }
          } catch {}
        }
        return nativeFetch(input, init);
      };
    }

    if (window.XMLHttpRequest && window.XMLHttpRequest.prototype) {
      const nativeOpen = window.XMLHttpRequest.prototype.open;
      window.XMLHttpRequest.prototype.open = function(method, url) {
        const args = Array.prototype.slice.call(arguments);
        args[1] = proxiedUrl(url);
        return nativeOpen.apply(this, args);
      };
    }

    if (typeof window.EventSource === 'function') {
      const NativeEventSource = window.EventSource;
      function OpenChamberPreviewEventSource(url, eventSourceInitDict) {
        return new NativeEventSource(proxiedUrl(String(url)), eventSourceInitDict);
      }
      OpenChamberPreviewEventSource.prototype = NativeEventSource.prototype;
      Object.setPrototypeOf(OpenChamberPreviewEventSource, NativeEventSource);
      Object.defineProperty(OpenChamberPreviewEventSource, 'name', { value: 'EventSource' });
      window.EventSource = OpenChamberPreviewEventSource;
    }

    // SPA frameworks frequently create images, scripts, links, and style tags
    // after the initial HTML response has been parsed. Once the visible URL is
    // virtualized to the upstream route, their root-relative values would
    // otherwise escape to DevRyan's own origin. Rewrite those values before
    // the browser observes them, just as the response rewriter does for the
    // initial document.
    const proxiedSrcset = (value) => String(value || '').split(',').map((part) => {
      const trimmed = part.trim();
      if (!trimmed) return trimmed;
      const segments = trimmed.split(/\s+/);
      segments[0] = proxiedUrl(segments[0]);
      return segments.join(' ');
    }).join(', ');
    const proxiedCss = (value) => String(value || '').replace(
      /url\((['"]?)([^)'"\\s][^)'"]*)\1\)/gi,
      (_match, quote, url) => 'url(' + (quote || '') + proxiedUrl(url.trim()) + (quote || '') + ')',
    );
    const rewriteAttributeValue = (name, value) => {
      const attribute = String(name || '').toLowerCase();
      if (attribute === 'srcset') return proxiedSrcset(value);
      if (attribute === 'style') return proxiedCss(value);
      if (attribute === 'src'
        || attribute === 'href'
        || attribute === 'action'
        || attribute === 'poster'
        || attribute === 'formaction'
        || attribute === 'xlink:href') {
        return proxiedUrl(value);
      }
      return value;
    };

    const elementPrototype = window.Element && window.Element.prototype;
    if (elementPrototype && typeof elementPrototype.setAttribute === 'function') {
      const nativeSetAttribute = elementPrototype.setAttribute;
      elementPrototype.setAttribute = function(name, value) {
        return nativeSetAttribute.call(this, name, rewriteAttributeValue(name, value));
      };
    }

    const patchUrlProperty = (constructor, property, transformer = proxiedUrl) => {
      const prototype = constructor && constructor.prototype;
      if (!prototype) return;
      const descriptor = Object.getOwnPropertyDescriptor(prototype, property);
      if (!descriptor || typeof descriptor.set !== 'function' || typeof descriptor.get !== 'function') return;
      try {
        Object.defineProperty(prototype, property, Object.assign({}, descriptor, {
          set(value) { descriptor.set.call(this, transformer(value)); },
        }));
      } catch {}
    };
    patchUrlProperty(window.HTMLImageElement, 'src');
    patchUrlProperty(window.HTMLImageElement, 'srcset', proxiedSrcset);
    patchUrlProperty(window.HTMLScriptElement, 'src');
    patchUrlProperty(window.HTMLLinkElement, 'href');
    patchUrlProperty(window.HTMLAnchorElement, 'href');
    patchUrlProperty(window.HTMLFormElement, 'action');
    patchUrlProperty(window.HTMLSourceElement, 'src');
    patchUrlProperty(window.HTMLSourceElement, 'srcset', proxiedSrcset);
    patchUrlProperty(window.HTMLVideoElement, 'poster');

    const stylePrototype = window.CSSStyleDeclaration && window.CSSStyleDeclaration.prototype;
    if (stylePrototype && typeof stylePrototype.setProperty === 'function') {
      const nativeSetProperty = stylePrototype.setProperty;
      stylePrototype.setProperty = function(property, value, priority) {
        return nativeSetProperty.call(this, property, proxiedCss(value), priority);
      };
      const cssTextDescriptor = Object.getOwnPropertyDescriptor(stylePrototype, 'cssText');
      if (cssTextDescriptor && typeof cssTextDescriptor.set === 'function' && typeof cssTextDescriptor.get === 'function') {
        try {
          Object.defineProperty(stylePrototype, 'cssText', Object.assign({}, cssTextDescriptor, {
            set(value) { cssTextDescriptor.set.call(this, proxiedCss(value)); },
          }));
        } catch {}
      }
    }

    const nodePrototype = window.Node && window.Node.prototype;
    const textContentDescriptor = nodePrototype && Object.getOwnPropertyDescriptor(nodePrototype, 'textContent');
    if (textContentDescriptor && typeof textContentDescriptor.set === 'function' && typeof textContentDescriptor.get === 'function') {
      try {
        Object.defineProperty(nodePrototype, 'textContent', Object.assign({}, textContentDescriptor, {
          set(value) {
            const isStyle = this && String(this.nodeName || '').toLowerCase() === 'style';
            textContentDescriptor.set.call(this, isStyle ? proxiedCss(value) : value);
          },
        }));
      } catch {}
    }
  };

  const selectorPart = (element) => {
    const tag = element.tagName.toLowerCase();
    if (element.id && /^[A-Za-z][\w:.-]*$/.test(element.id)) return tag + '#' + CSS.escape(element.id);
    const testId = element.getAttribute('data-testid') || element.getAttribute('data-test') || element.getAttribute('data-cy');
    if (testId) return tag + '[data-testid="' + CSS.escape(testId) + '"]';
    const classes = Array.from(element.classList || []).slice(0, 3).map((entry) => '.' + CSS.escape(entry)).join('');
    return tag + classes;
  };

  const buildSelector = (element) => {
    const parts = [];
    let current = element;
    while (current && current.nodeType === Node.ELEMENT_NODE && current !== document.documentElement) {
      let part = selectorPart(current);
      const parent = current.parentElement;
      if (parent) {
        const siblings = Array.from(parent.children).filter((child) => child.tagName === current.tagName);
        if (siblings.length > 1 && !part.includes('#') && !part.includes('[data-testid=')) {
          part += ':nth-of-type(' + (siblings.indexOf(current) + 1) + ')';
        }
      }
      parts.unshift(part);
      if (part.includes('#')) break;
      current = parent;
    }
    return parts.join(' > ');
  };

  const metadataForElement = (element) => {
    if (!element || element.nodeType !== Node.ELEMENT_NODE) return null;
    const rect = element.getBoundingClientRect();
    const style = window.getComputedStyle(element);
    const attributes = {};
    for (const name of ['id', 'class', 'role', 'aria-label', 'href', 'src', 'data-testid', 'data-test', 'data-cy']) {
      const value = typeof element.getAttribute === 'function' ? element.getAttribute(name) : null;
      if (value) attributes[name] = clip(value, 300);
    }
    const ancestry = [];
    let current = element;
    while (current && current.nodeType === Node.ELEMENT_NODE && ancestry.length < 6) {
      ancestry.unshift({
        tag: current.tagName.toLowerCase(),
        id: current.id || undefined,
        className: clip(current.className || '', 200) || undefined,
        selectorPart: selectorPart(current),
      });
      current = current.parentElement;
    }
    return {
      frame: 'top',
      tag: element.tagName.toLowerCase(),
      text: clip(element.innerText || element.textContent || ''),
      selector: buildSelector(element),
      path: ancestry.map((entry) => entry.tag).join(' > '),
      bounds: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
      center: { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 },
      attributes,
      computedStyle: {
        display: style.display,
        position: style.position,
        color: style.color,
        backgroundColor: style.backgroundColor,
        fontFamily: style.fontFamily,
        fontSize: style.fontSize,
        fontWeight: style.fontWeight,
        lineHeight: style.lineHeight,
        zIndex: style.zIndex,
      },
      ancestry,
    };
  };

  const hoverKeyForTarget = (target) => {
    if (!target) return '';
    const bounds = target.bounds || {};
    return [target.selector, Math.round(bounds.x), Math.round(bounds.y), Math.round(bounds.width), Math.round(bounds.height)].join('|');
  };

  const sendHover = (event) => {
    if (!inspectMode) return;
    pendingHover = event;
    if (window.__openchamberPreviewHoverFrame) return;
    window.__openchamberPreviewHoverFrame = window.requestAnimationFrame(() => {
      window.__openchamberPreviewHoverFrame = 0;
      const currentEvent = pendingHover;
      pendingHover = null;
      if (!currentEvent || !inspectMode) return;
      const element = document.elementFromPoint(currentEvent.clientX, currentEvent.clientY);
      const target = metadataForElement(element);
      const key = hoverKeyForTarget(target);
      if (key === lastHoverKey) return;
      lastHoverKey = key;
      post({ type: 'hover', target, pointer: { x: currentEvent.clientX, y: currentEvent.clientY }, ts: Date.now() });
    });
  };

  const setInspectMode = (enabled) => {
    inspectMode = Boolean(enabled);
    lastHoverKey = '';
    document.documentElement.style.cursor = inspectMode ? 'crosshair' : '';
    if (!inspectMode) {
      post({ type: 'hover', target: null, pointer: { x: 0, y: 0 }, ts: Date.now() });
    }
  };

  for (const level of ['log', 'info', 'warn', 'error', 'debug']) {
    const original = console[level];
    console[level] = function() {
      const args = Array.prototype.slice.call(arguments);
      if (level === 'debug' && typeof args[0] === 'string' && args[0].indexOf('[vite]') === 0) {
        return original.apply(console, args);
      }
      if (isInternalDevToolConsoleNoise(level, args)) {
        return original.apply(console, args);
      }
      post({ type: 'console', level, args: args.map(stringifyArg), ts: Date.now() });
      return original.apply(console, args);
    };
  }

  installWebSocketProxyPatch();
  installAppRequestProxyPatch();

  window.addEventListener('error', (event) => {
    const target = event.target;
    if (target && target !== window && target.nodeType === Node.ELEMENT_NODE) {
      const url = readElementUrl(target);
      if (isInternalDevToolResource(target, url)) {
        return;
      }
      post({
        type: 'resource-error',
        tag: target.tagName.toLowerCase(),
        url: clip(url, 1000),
        outerHTML: clip(target.outerHTML || '', 1000),
        ts: Date.now(),
      });
      return;
    }
    if (isInternalDevToolRuntimeError(event.filename)) {
      return;
    }
    post({
      type: 'runtime-error',
      message: clip(event.message || 'Unknown error', 1000),
      stack: clip(event.error && event.error.stack ? event.error.stack : '', 2000) || undefined,
      filename: event.filename,
      line: event.lineno,
      column: event.colno,
      ts: Date.now(),
    });
  }, true);

  window.addEventListener('unhandledrejection', (event) => {
    post({
      type: 'runtime-error',
      message: clip(event.reason && event.reason.message ? event.reason.message : event.reason || 'Unhandled promise rejection', 1000),
      stack: clip(event.reason && event.reason.stack ? event.reason.stack : '', 2000) || undefined,
      ts: Date.now(),
    });
  });

  window.addEventListener('message', (event) => {
    if (event.source !== window.parent) return;
    const data = event.data;
    if (!data || data.source !== 'openchamber-preview-parent' || data.version !== VERSION) return;
    if (data.type === 'set-inspect-mode') {
      setInspectMode(data.enabled === true);
    }
    if (data.type === 'set-color-scheme') {
      applyPreviewColorScheme(data.scheme);
    }
  });

  window.addEventListener('mousemove', sendHover, true);
  window.addEventListener('mouseleave', () => {
    if (!inspectMode) return;
    lastHoverKey = '';
    post({ type: 'hover', target: null, pointer: { x: 0, y: 0 }, ts: Date.now() });
  }, true);
  window.addEventListener('click', (event) => {
    const anchor = event.target && typeof event.target.closest === 'function' ? event.target.closest('a[href]') : null;
    if (anchor && !inspectMode) {
      const navigation = classifyNavigation(anchor.href);
      if (handOffExternalNavigation(anchor.href, event)) return;
      if (navigation.action === 'proxy') {
        if (!staysOnRegisteredTarget(navigation.url)) {
          event.preventDefault();
          event.stopPropagation();
          post({ type: 'navigate-preview', url: navigation.url, navigation: 'target', ts: Date.now() });
          return;
        }

        const displayUrl = toDisplayUrl(navigation.url);
        const proxyUrl = toProxyUrl(navigation.url);
        if (proxyUrl) anchor.setAttribute('href', proxyUrl);
        if (displayUrl) post({ type: 'navigate-preview', url: displayUrl, navigation: 'display', ts: Date.now() });
      }
    }

    if (!inspectMode) return;
    event.preventDefault();
    event.stopPropagation();
    const element = document.elementFromPoint(event.clientX, event.clientY);
    const target = metadataForElement(element);
    if (target) {
      post({ type: 'select', target, pointer: { x: event.clientX, y: event.clientY }, ts: Date.now() });
    }
  }, true);

  const reportRenderReady = () => {
    post({ type: 'render-ready', url: toDisplayUrl(window.location.href), ts: Date.now() });
  };
  if (document.readyState === 'loading' && typeof document.addEventListener === 'function') {
    const onReadyStateChange = () => {
      if (document.readyState === 'loading') return;
      document.removeEventListener?.('readystatechange', onReadyStateChange);
      reportRenderReady();
    };
    document.addEventListener('readystatechange', onReadyStateChange);
  } else {
    reportRenderReady();
  }

  window.addEventListener('DOMContentLoaded', () => {
    post({ type: 'ready', url: toDisplayUrl(window.location.href), title: document.title || '' });
  });
  post({ type: 'ready', url: toDisplayUrl(window.location.href), title: document.title || '' });
})();`;

export const createPreviewLocationVirtualizerScript = (proxyBasePath) => {
  const serializedProxyBasePath = JSON.stringify(proxyBasePath).replace(/</g, '\\u003c');
  return `try{const proxyBase=${serializedProxyBasePath}.replace(/\\/$/,'');const current=new URL(window.location.href);if(current.origin===window.location.origin&&(current.pathname===proxyBase||current.pathname.indexOf(proxyBase+'/')===0)){const targetPath=current.pathname.slice(proxyBase.length)||'/';current.searchParams.delete('ocPreview');current.searchParams.delete('ocBrowser');window.history.replaceState(window.history.state,'',targetPath+current.search+current.hash);window.__openchamberPreviewLocationVirtualized=true;}}catch{}`;
};

export const createPreviewBridgeScript = ({
  proxyBasePath,
  targetOrigin,
  embedExternalNavigation = false,
}) => {
  const config = JSON.stringify({
    proxyBasePath,
    targetOrigin,
    embedExternalNavigation,
  }).replace(/</g, '\\u003c');
  return `window.__openchamberPreviewConfig=${config};${PREVIEW_BRIDGE_SCRIPT}`;
};

const parseCookieHeader = (cookieHeader) => {
  const result = new Map();
  if (typeof cookieHeader !== 'string' || cookieHeader.length === 0) {
    return result;
  }

  const parts = cookieHeader.split(';');
  for (const part of parts) {
    const idx = part.indexOf('=');
    if (idx <= 0) {
      continue;
    }
    const key = part.slice(0, idx).trim();
    const value = part.slice(idx + 1).trim();
    if (!key) {
      continue;
    }
    result.set(key, value);
  }
  return result;
};

const buildCookie = ({
  name,
  value,
  path,
  maxAgeSeconds,
  secure,
}) => {
  const chunks = [`${name}=${value}`];
  if (path) chunks.push(`Path=${path}`);
  if (typeof maxAgeSeconds === 'number' && Number.isFinite(maxAgeSeconds)) {
    chunks.push(`Max-Age=${Math.max(0, Math.trunc(maxAgeSeconds))}`);
  }
  chunks.push('HttpOnly');
  chunks.push('SameSite=Lax');
  if (secure) chunks.push('Secure');
  return chunks.join('; ');
};

export const buildPreviewUpstreamCookieHeader = (cookieHeader) => {
  const cookies = parseCookieHeader(cookieHeader);
  const upstream = [];
  for (const [name, value] of cookies.entries()) {
    if (String(name).toLowerCase().startsWith(PRESERVED_COOKIE_MARKER)) {
      const restored = String(name).slice(PRESERVED_COOKIE_MARKER.length);
      if (isPrefixedAuthCookieName(restored)) upstream.push(`${restored}=${value}`);
      continue;
    }
    if (isReservedPreviewCookieName(name)) continue;
    upstream.push(`${name}=${value}`);
  }
  return upstream.join('; ');
};

export const rewritePreviewSetCookieHeaders = (headers, proxyBasePath, { viewerSecure = true } = {}) => {
  const raw = readHeader(headers, 'set-cookie');
  if (raw === undefined) return;
  const source = Array.isArray(raw) ? raw : [raw];
  const rewritten = source.flatMap((cookieValue) => {
    const parts = String(cookieValue || '').split(';').map((part) => part.trim()).filter(Boolean);
    const first = parts[0] || '';
    const separator = first.indexOf('=');
    const name = separator > 0 ? first.slice(0, separator).trim() : '';
    if (!name) return [];
    // An upstream cookie already wearing the marker is indistinguishable from
    // one we wrapped, so it cannot be carried without corrupting the mapping.
    if (name.toLowerCase().startsWith(PRESERVED_COOKIE_MARKER)) return [];
    const prefixed = isPrefixedAuthCookieName(name);
    if (!prefixed && isReservedPreviewCookieName(name)) return [];
    const nameValue = prefixed
      ? `${PRESERVED_COOKIE_MARKER}${first}`
      : first;

    let upstreamPath = '/';
    const attributes = [];
    for (const attribute of parts.slice(1)) {
      const [rawName, ...rawValue] = attribute.split('=');
      const attributeName = rawName.trim().toLowerCase();
      if (attributeName === 'domain') continue;
      if (attributeName === 'path') {
        const candidate = rawValue.join('=').trim();
        upstreamPath = candidate.startsWith('/') ? candidate : '/';
        continue;
      }
      // On an insecure viewer origin the browser silently refuses a Secure
      // cookie, which strands the upstream session. SameSite=None depends on
      // Secure, and everything is same-origin once proxied, so Lax is safe.
      if (!viewerSecure && attributeName === 'secure') continue;
      if (!viewerSecure && attributeName === 'samesite' && rawValue.join('=').trim().toLowerCase() === 'none') {
        attributes.push('SameSite=Lax');
        continue;
      }
      attributes.push(attribute);
    }
    const base = proxyBasePath.endsWith('/') ? proxyBasePath.slice(0, -1) : proxyBasePath;
    const scopedPath = upstreamPath === '/' ? base : `${base}${upstreamPath}`;
    return [[nameValue, `Path=${scopedPath}`, ...attributes].join('; ')];
  });

  for (const key of Object.keys(headers || {})) {
    if (key.toLowerCase() === 'set-cookie') delete headers[key];
  }
  if (rewritten.length > 0) headers['set-cookie'] = rewritten;
};

export const normalizeProxyTargetUrl = (rawUrl) => {
  let url;
  try {
    url = new URL(rawUrl);
  } catch {
    return { ok: false, error: 'Invalid URL' };
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return { ok: false, error: 'Only http(s) URLs are supported' };
  }

  const hostname = url.hostname;
  if (!LOOPBACK_HOSTS.has(hostname)) {
    return { ok: false, error: 'Only loopback hosts are supported' };
  }

  const port = url.port ? Number.parseInt(url.port, 10) : (url.protocol === 'https:' ? 443 : 80);
  if (!Number.isFinite(port) || port <= 0 || port > 65535) {
    return { ok: false, error: 'Invalid port' };
  }

  // Normalize common loopback hostnames to IPv4 to avoid environments where
  // `localhost` resolves to ::1 but the dev server only binds IPv4.
  if (LOOPBACK_HOSTS.has(hostname) && (hostname === '0.0.0.0' || hostname === 'localhost' || hostname === '::1' || hostname === '[::1]')) {
    url.hostname = '127.0.0.1';
  }

  // Only keep origin here; the proxy path is preserved on the OpenChamber side.
  return { ok: true, origin: url.origin };
};

const normalizeLoopbackUrl = (rawUrl) => normalizeProxyTargetUrl(rawUrl);

export const rewritePreviewRedirectLocation = ({ location, targetOrigin, proxyBasePath, requestPath = '/' }) => {
  if (typeof location !== 'string' || !location.trim()) {
    return { ok: true, location };
  }

  let resolved;
  try {
    const upstreamRequestUrl = new URL(requestPath || '/', targetOrigin);
    resolved = new URL(location, upstreamRequestUrl);
  } catch {
    return { ok: false, error: 'Preview redirect returned an invalid URL' };
  }

  let sameOrigin = false;
  try {
    sameOrigin = canonicalPreviewOrigin(resolved.toString()) === canonicalPreviewOrigin(targetOrigin);
  } catch {
    sameOrigin = false;
  }
  if (!sameOrigin) {
    if (
      (resolved.protocol === 'http:' || resolved.protocol === 'https:')
      && !LOOPBACK_HOSTS.has(resolved.hostname)
    ) {
      return { ok: true, externalUrl: resolved.toString() };
    }
    return { ok: false, error: 'Preview redirect attempted to leave the approved origin' };
  }

  const base = proxyBasePath.endsWith('/') ? proxyBasePath.slice(0, -1) : proxyBasePath;
  return {
    ok: true,
    location: `${base}${resolved.pathname || '/'}${resolved.search}${resolved.hash}`,
  };
};

// Only a document/iframe navigation may be answered with a handoff page. A
// subresource (fetch/XHR/script/image) must receive the real redirect, or the
// caller silently parses an HTML handoff as its API response.
export const isPreviewNavigationRequest = (req) => {
  const destination = String(readHeader(req?.headers, 'sec-fetch-dest') || '').toLowerCase();
  if (destination) return destination === 'document' || destination === 'iframe';
  const accept = String(readHeader(req?.headers, 'accept') || '').toLowerCase();
  return accept.includes('text/html');
};

export const createPreviewViewerNavigationHandoffHtml = ({ url, bridgeNonce = '', navigation = 'external' }) => {
  const normalized = new URL(url).toString();
  const navigationMode = navigation === 'target' ? 'target' : 'external';
  const payload = JSON.stringify({
    source: 'openchamber-preview-bridge',
    version: 1,
    type: 'navigate-preview',
    url: normalized,
    navigation: navigationMode,
    ts: Date.now(),
  }).replace(/</g, '\\u003c');
  const escapedHref = normalized
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
  const nonceAttr = bridgeNonce ? ` nonce="${bridgeNonce}"` : '';
  return `<!doctype html><html><head><meta charset="utf-8"><title>Continue in Browser</title></head><body><p>Continuing to the next page.</p><p><a href="${escapedHref}" target="_blank" rel="noopener noreferrer">Open page</a></p><script${nonceAttr}>window.parent.postMessage(${payload}, window.location.origin);</script></body></html>`;
};

export const rewritePreviewBody = ({ bodyText, proxyBasePath, targetOrigin, kind }) => {
  if (typeof bodyText !== 'string' || bodyText.length === 0) {
    return bodyText;
  }

  const prefix = proxyBasePath.endsWith('/') ? proxyBasePath.slice(0, -1) : proxyBasePath;
  const target = targetOrigin ? new URL(targetOrigin) : null;
  const isSameTarget = (url) => {
    if (!target) return false;
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return false;
    if (url.origin === target.origin) return true;
    const host = url.hostname;
    const targetHost = target.hostname;
    const loopbackAlias = LOOPBACK_HOSTS.has(host) && LOOPBACK_HOSTS.has(targetHost);
    return loopbackAlias && url.protocol === target.protocol && url.port === target.port;
  };
  const rewriteResourceUrl = (value) => {
    if (typeof value !== 'string' || value.length === 0) return value;
    if (value.startsWith('/') && !value.startsWith('//')) {
      if (value.startsWith('/api/preview/proxy/')) return value;
      return `${prefix}${value}`;
    }
    try {
      const parsed = new URL(value);
      if (isSameTarget(parsed)) {
        return `${prefix}${parsed.pathname}${parsed.search}${parsed.hash}`;
      }
    } catch {
      return value;
    }
    return value;
  };
  const rewriteHtml = (text) => text
    .replace(/\b(src|href|action|poster|formaction|xlink:href)=(['"])([^'"]*)\2/gi, (_match, attr, quote, value) => {
      return `${attr}=${quote}${rewriteResourceUrl(value)}${quote}`;
    })
    .replace(/\b(src|href|action|poster|formaction|xlink:href)=([^\s'"`=<>]+)/gi, (_match, attr, value) => {
      return `${attr}=${rewriteResourceUrl(value)}`;
    })
    .replace(/\bsrcset=(['"])([^'"]*)\1/gi, (_match, quote, value) => {
      const rewritten = String(value).split(',').map((part) => {
        const trimmed = part.trim();
        if (!trimmed) return trimmed;
        const segments = trimmed.split(/\s+/);
        const url = segments[0] || '';
        segments[0] = rewriteResourceUrl(url);
        return segments.join(' ');
      }).join(', ');
      return `srcset=${quote}${rewritten}${quote}`;
    })
    .replace(/\bstyle="([^"]*)"/gi, (_match, value) => `style="${rewriteCss(value)}"`)
    .replace(/\bstyle='([^']*)'/gi, (_match, value) => `style='${rewriteCss(value)}'`)
    // Subresource integrity cannot survive here: bodies are rewritten and
    // upstream compression is disabled, so every recorded hash mismatches and
    // the browser blocks the asset.
    .replace(/\s+integrity=(['"])[^'"]*\1/gi, '');
  const rewriteCss = (text) => text
    .replace(/url\((['"]?)([^)'"]*)\1\)/gi, (_match, quote, value) => {
      const q = quote || '';
      return `url(${q}${rewriteResourceUrl(value)}${q})`;
    })
    .replace(/@import\s+(['"])\/(?!\/)([^'"]*)\1/gi, (_match, quote, path) => {
      return `@import ${quote}${rewriteResourceUrl(`/${path}`)}${quote}`;
    });
  const rewriteJavaScript = (text) => text
    .replace(/\bfrom\s+(['"])\/(?!\/)([^'"]*)\1/gi, (_match, quote, path) => {
      return `from ${quote}${rewriteResourceUrl(`/${path}`)}${quote}`;
    })
    .replace(/\bimport\s+(['"])\/(?!\/)([^'"]*)\1/gi, (_match, quote, path) => {
      return `import ${quote}${rewriteResourceUrl(`/${path}`)}${quote}`;
    })
    .replace(/\bimport\(\s*(['"])\/(?!\/)([^'"]*)\1\s*\)/gi, (_match, quote, path) => {
      return `import(${quote}${rewriteResourceUrl(`/${path}`)}${quote})`;
    });
  // Inline <script type="module"> blocks (e.g. Vite's React-refresh preamble)
  // import root-relative specifiers that must be routed through the proxy too.
  const rewriteInlineModuleScripts = (text) => text.replace(
    /<script\b([^>]*)>([\s\S]*?)<\/script>/gi,
    (match, attrs, scriptBody) => {
      if (/\bsrc\s*=/i.test(attrs)) return match;

      const typeMatch = String(attrs || '').match(/\btype\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i);
      const type = String(typeMatch?.[1] ?? typeMatch?.[2] ?? typeMatch?.[3] ?? '').trim().toLowerCase();
      if (type !== 'module') return match;

      const rewrittenScriptBody = rewriteJavaScript(scriptBody);
      if (rewrittenScriptBody === scriptBody) return match;
      return `<script${attrs}>${rewrittenScriptBody}</script>`;
    },
  );
  const rewriteInlineStyles = (text) => text.replace(
    /<style\b([^>]*)>([\s\S]*?)<\/style>/gi,
    (_match, attrs, styleBody) => `<style${attrs}>${rewriteCss(styleBody)}</style>`,
  );
  // A meta-delivered CSP cannot be relaxed per-response the way the header can
  // (the bridge nonce is only added to headers), so drop it entirely.
  const stripPreviewCspMeta = (text) => text
    .replace(/<meta\b(?=[^>]*\bhttp-equiv\s*=\s*(['"])content-security-policy\1)[^>]*>/gi, '')
    .replace(/<meta\b(?=[^>]*\bhttp-equiv\s*=\s*content-security-policy\b)[^>]*>/gi, '');

  if (kind === 'html') {
    return stripPreviewCspMeta(rewriteInlineModuleScripts(rewriteInlineStyles(rewriteHtml(bodyText))));
  }
  if (kind === 'css') return rewriteCss(bodyText);
  if (kind === 'javascript') return rewriteJavaScript(bodyText);
  return bodyText;
};

// Rewrite a dev server's CSP so the injected preview bridge can run via a
// per-response nonce, while keeping the dev server's own script restrictions.
// frame-ancestors is dropped (it blocks embedding) and require-trusted-types-for
// is dropped (it can block the bridge's DOM use); everything else is preserved.
// Returns null if no directives remain.
export const rewritePreviewCspHeader = (cspValue, nonce) => {
  if (typeof cspValue !== 'string' || cspValue.length === 0) return cspValue;
  const nonceSource = nonce ? `'nonce-${nonce}'` : '';
  const directives = cspValue
    .split(';')
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => {
      const tokens = part.split(/\s+/);
      return { name: (tokens[0] || '').toLowerCase(), tokens };
    })
    .filter((directive) => directive.name !== 'frame-ancestors' && directive.name !== 'require-trusted-types-for');

  if (nonceSource) {
    const byName = new Map(directives.map((directive) => [directive.name, directive]));
    const allowNonce = (directive) => {
      // Drop a lone 'none' so the nonce takes effect, then add our nonce.
      directive.tokens = directive.tokens.filter((token) => token.toLowerCase() !== "'none'");
      if (!directive.tokens.includes(nonceSource)) directive.tokens.push(nonceSource);
    };
    const scriptElem = byName.get('script-src-elem');
    const scriptSrc = byName.get('script-src');
    if (scriptElem) allowNonce(scriptElem);
    if (scriptSrc) allowNonce(scriptSrc);
    if (!scriptElem && !scriptSrc && byName.has('default-src')) {
      const base = byName.get('default-src').tokens.slice(1).filter((token) => token.toLowerCase() !== "'none'");
      directives.push({ name: 'script-src', tokens: ['script-src', ...base, nonceSource] });
    }
  }

  const rebuilt = directives.map((directive) => directive.tokens.join(' '));
  return rebuilt.length > 0 ? rebuilt.join('; ') : null;
};

export const createPreviewProxyRuntime = ({
  crypto,
  URL,
  createProxyMiddleware,
  responseInterceptor,
  now: nowFn = () => Date.now(),
}) => {
  const targets = new Map();
  let sweepTimer = null;

  const now = nowFn;

  const removeTarget = (id) => {
    const entry = targets.get(id);
    if (!entry) return false;
    targets.delete(id);
    try {
      entry.unregisterRevocation?.();
    } catch {
    }
    return true;
  };

  const requestOwnerKey = (req) => {
    const cookies = parseCookieHeader(req?.headers?.cookie);
    for (const cookieName of AUTH_SESSION_COOKIE_NAMES) {
      const token = cookies.get(cookieName);
      if (!token) continue;
      if (typeof crypto.createHash === 'function') {
        const digest = crypto.createHash('sha256').update(`${cookieName}:${token}`).digest('hex');
        return `session-cookie:${digest}`;
      }
      return `session-cookie:${cookieName}:${token}`;
    }
    if (req?.principal?.appSessionId) return `app-session:${req.principal.appSessionId}`;
    return `principal:${req?.principal?.id || 'local-admin'}`;
  };

  const sweepExpired = () => {
    const t = now();
    for (const [id, entry] of targets.entries()) {
      if (entry.expiresAt <= t) {
        removeTarget(id);
      }
    }
  };

  const ensureSweeper = () => {
    if (sweepTimer) {
      return;
    }
    sweepTimer = setInterval(sweepExpired, 30_000);
    // Don't keep the process alive.
    sweepTimer.unref?.();
  };

  const createTarget = (origin, ttlMs, {
    ownerKey,
    ownerUserId,
    grantId = null,
    projectKey = null,
    registerRevocation = null,
    browserRestricted = false,
  } = {}) => {
    const createdAt = now();
    const requestedTtl = Number.isFinite(ttlMs) ? Math.trunc(ttlMs) : DEFAULT_TARGET_TTL_MS;
    const boundedTtl = Math.min(DEFAULT_TARGET_TTL_MS, Math.max(15_000, requestedTtl));

    // Re-registration (the client refreshes shortly before expiry) must keep the
    // same id: the proxy path scopes every upstream cookie, so a new id would
    // silently sign the embedded page out and remount the frame mid-session.
    for (const entry of targets.values()) {
      if (entry.expiresAt <= createdAt) continue;
      if (entry.origin !== origin || entry.ownerKey !== ownerKey) continue;
      if (entry.browserRestricted !== browserRestricted) continue;
      if (entry.grantId !== grantId) continue;
      entry.expiresAt = createdAt + boundedTtl;
      if (projectKey !== null) entry.projectKey = projectKey;
      return { id: entry.id, token: entry.token, expiresAt: entry.expiresAt };
    }

    const id = crypto.randomBytes(16).toString('hex');
    const token = crypto.randomBytes(16).toString('hex');
    const expiresAt = createdAt + boundedTtl;
    targets.set(id, {
      id,
      origin,
      token,
      ownerKey,
      ownerUserId,
      grantId,
      projectKey,
      browserRestricted,
      createdAt,
      expiresAt,
    });
    const entry = targets.get(id);
    if (entry && typeof registerRevocation === 'function') {
      entry.unregisterRevocation = registerRevocation(() => removeTarget(id));
    }
    return { id, token, expiresAt };
  };

  const routerTargetForEntry = (entry) => entry.origin;

  const resolveTargetFromRequest = (req) => {
    const rawUrl = req?.originalUrl || req?.url || '';
    const parsed = new URL(rawUrl, 'http://localhost');
    const pathname = parsed.pathname || '';

    const match = pathname.match(/^\/api\/preview\/proxy\/([a-f0-9]{16,64})(?:\/|$)/i);
    const id = match?.[1] || '';
    if (!id) {
      return { ok: false, status: 404, code: 'preview_target_not_found', error: 'Preview target not found' };
    }

    const entry = targets.get(id);
    if (!entry || entry.expiresAt <= now()) {
      removeTarget(id);
      return { ok: false, status: 404, code: 'preview_target_expired', error: 'Preview target expired' };
    }

    const cookies = parseCookieHeader(req.headers?.cookie);
    const token = cookies.get(TOKEN_COOKIE_NAME) || '';
    if (!token || token !== entry.token) {
      return { ok: false, status: 403, error: 'Preview token missing' };
    }

    if (!entry.ownerKey || requestOwnerKey(req) !== entry.ownerKey) {
      return { ok: false, status: 403, error: 'Preview target belongs to another session' };
    }

    return { ok: true, id, entry, parsed };
  };

  const stripProxyPrefix = (pathname, id) => {
    const prefix = `/api/preview/proxy/${id}`;
    if (!pathname.startsWith(prefix)) {
      return pathname;
    }
    const rest = pathname.slice(prefix.length);
    return rest.length === 0 ? '/' : rest;
  };

  const removeRawQueryParam = (search, paramName) => {
    if (typeof search !== 'string' || search.length <= 1) {
      return '';
    }
    const query = search.startsWith('?') ? search.slice(1) : search;
    const parts = query.split('&').filter((part) => {
      const name = part.split('=', 1)[0] || '';
      try {
        return decodeURIComponent(name.replace(/\+/g, ' ')) !== paramName;
      } catch {
        return name !== paramName;
      }
    });
    return parts.length > 0 ? `?${parts.join('&')}` : '';
  };

  const stripInternalPreviewQuery = (search) => (
    removeRawQueryParam(removeRawQueryParam(search, 'ocPreview'), 'ocBrowser')
  );

  const applyUpstreamNavigationHeaders = (proxyReq, req, resolved) => {
    if (!resolved?.ok) return;
    if (readHeader(req?.headers, 'origin') !== undefined) {
      proxyReq.setHeader('origin', resolved.entry.origin);
    }

    const rawReferer = readHeader(req?.headers, 'referer');
    if (typeof rawReferer !== 'string' || !rawReferer) return;
    try {
      const referer = new URL(rawReferer);
      const path = stripProxyPrefix(referer.pathname, resolved.id);
      proxyReq.setHeader('referer', new URL(`${path}${stripInternalPreviewQuery(referer.search)}${referer.hash}`, resolved.entry.origin).toString());
    } catch {
      proxyReq.removeHeader?.('referer');
    }
  };

  // Drop response headers that prevent the dev server from being framed.
  // The proxy itself is same-origin, so embedding is otherwise safe. CSP
  // headers are rewritten (not dropped): frame-ancestors is removed and the
  // per-response bridge nonce is allowed, keeping the dev server's own script
  // restrictions intact.
  const stripFrameBustingHeaders = (headers, bridgeNonce, res) => {
    if (!headers || typeof headers !== 'object') {
      return;
    }

    const headerKeys = Object.keys(headers);
    for (const key of headerKeys) {
      const lowerKey = key.toLowerCase();
      if (lowerKey === 'x-frame-options') {
        delete headers[key];
        res?.removeHeader?.(key);
        continue;
      }
      if (lowerKey === 'content-security-policy' || lowerKey === 'content-security-policy-report-only') {
        const original = headers[key];
        const values = Array.isArray(original) ? original : [original];
        const rewritten = values
          .map((value) => rewritePreviewCspHeader(value, bridgeNonce))
          .filter((value) => typeof value === 'string' && value.length > 0);
        if (rewritten.length === 0) {
          delete headers[key];
          res?.removeHeader?.(key);
        } else {
          const value = Array.isArray(original) ? rewritten : rewritten[0];
          headers[key] = value;
          res?.setHeader?.(key, value);
        }
      }
    }
  };

  const attach = (app, {
    server,
    express,
    uiAuthController,
    isRequestOriginAllowed,
    rejectWebSocketUpgrade,
    classifyRequestScope = () => 'local',
    previewInstancesRuntime = null,
    canUseBrowser = () => true,
  }) => {
    ensureSweeper();

    const injectPreviewBridge = (bodyText, {
      proxyBasePath,
      targetOrigin,
      bridgeNonce,
      embedExternalNavigation = false,
      virtualizeLocation = true,
    }) => {
      if (typeof bodyText !== 'string' || bodyText.includes(PREVIEW_BRIDGE_SCRIPT_ID)) {
        return bodyText;
      }

      const nonceAttr = bridgeNonce ? ` nonce="${bridgeNonce}"` : '';
      // This must run synchronously before the bridge installs its Navigation
      // API listener. A module script is deferred; its replaceState would then
      // be intercepted by the bridge as a fresh proxy navigation and reload
      // the iframe forever before the app modules can settle.
      const locationVirtualizer = virtualizeLocation
        ? `<script id="${PREVIEW_BRIDGE_SCRIPT_ID}-location"${nonceAttr}>${createPreviewLocationVirtualizerScript(proxyBasePath)}</script>`
        : '';
      const script = `${locationVirtualizer}<script id="${PREVIEW_BRIDGE_SCRIPT_ID}"${nonceAttr}>${createPreviewBridgeScript({
        proxyBasePath,
        targetOrigin,
        embedExternalNavigation,
      })}</script>`;
      if (/<head(?:\s[^>]*)?>/i.test(bodyText)) {
        return bodyText.replace(/<head(\s[^>]*)?>/i, (match) => `${match}${script}`);
      }
      if (bodyText.includes('</body>')) {
        return bodyText.replace('</body>', `${script}</body>`);
      }
      return `${bodyText}${script}`;
    };

    const rewriteViteClientHmr = (bodyText, proxyBasePath) => {
      if (typeof bodyText !== 'string' || !bodyText.includes('vite-hmr')) {
        return bodyText;
      }

      const base = proxyBasePath.endsWith('/') ? proxyBasePath : `${proxyBasePath}/`;
      const escapedBase = JSON.stringify(base).slice(1, -1);
      return bodyText
        .replace(/const base\$1 = [^;]+;/, () => `const base$1 = ${JSON.stringify(base)};`)
        .replace(/const base = [^;]+;/, () => `const base = ${JSON.stringify(base)};`)
        .replace(/const hmrPort = [^;]+;/, () => 'const hmrPort = importMetaUrl.port;')
        .replace(/const socketHost = [^;]+;/, () => `const socketHost = \`\${importMetaUrl.hostname}\${importMetaUrl.port ? ':' + importMetaUrl.port : ''}${escapedBase}\`;`)
        .replace(/const directSocketHost = [^;]+;/, () => 'const directSocketHost = socketHost;')
        .replace(
          /const socketHost = `\$\{[^;]+?;\nconst directSocketHost = [^;]+;/s,
          () => `const socketHost = \`\${importMetaUrl.hostname}\${importMetaUrl.port ? ':' + importMetaUrl.port : ''}${escapedBase}\`;\nconst directSocketHost = socketHost;`,
        )
        .replace(
          /(?:window\.)?location\.reload\(\)/g,
          () => 'window.__openchamberPreviewReload ? window.__openchamberPreviewReload() : window.location.reload()',
        );
    };

    const createTargetHandler = (browserRestricted) => async (req, res) => {
      try {
        if (uiAuthController?.enabled) {
          const sessionToken = await uiAuthController?.ensureSessionToken?.(req, res);
          if (!sessionToken) {
            return res.status(401).json({ error: 'UI authentication required' });
          }

          const originAllowed = await isRequestOriginAllowed(req);
          if (!originAllowed) {
            return res.status(403).json({ error: 'Invalid origin' });
          }
        }

        if (browserRestricted && !canUseBrowser(req.principal)) {
          return res.status(403).json({ error: 'Browser access is disabled' });
        }

        const rawUrl = typeof req.body?.url === 'string' ? req.body.url.trim() : '';
        if (!rawUrl) {
          return res.status(400).json({ error: 'url is required' });
        }

        const ttlMs = typeof req.body?.ttlMs === 'number' ? req.body.ttlMs : DEFAULT_TARGET_TTL_MS;
        const normalized = normalizeLoopbackUrl(rawUrl);
        if (!normalized.ok) {
          if (browserRestricted) {
            try {
              const candidate = new URL(rawUrl);
              if (candidate.protocol === 'http:' || candidate.protocol === 'https:') {
                return res.status(400).json({
                  error: 'External Browser targets must be opened on the client',
                  code: 'browser_external_target_requires_client',
                });
              }
            } catch {
            }
          }
          return res.status(400).json({ error: normalized.error });
        }

        const requestScope = classifyPreviewRequestScope(req, classifyRequestScope(req));
        let grantId = null;
        let projectKey = null;
        if (requestScope === 'tunnel' || requestScope === 'unknown-public') {
          if (!previewInstancesRuntime) {
            return res.status(503).json({ error: 'Remote preview grants are unavailable' });
          }
          const authorization = await previewInstancesRuntime.authorizeTarget({
            principal: req.principal,
            directory: req.body?.directory,
            url: rawUrl,
          });
          if (!authorization.ok) {
            return res.status(authorization.status).json({
              error: authorization.error,
              ...(authorization.code ? { code: authorization.code } : {}),
            });
          }
          grantId = authorization.grantId;
          projectKey = authorization.projectKey;
        }

        const target = createTarget(normalized.origin, ttlMs, {
          ownerKey: requestOwnerKey(req),
          ownerUserId: req.principal?.id || 'local-admin',
          grantId,
          projectKey,
          browserRestricted,
          registerRevocation: typeof uiAuthController?.registerConnection === 'function'
            ? (close) => uiAuthController.registerConnection(req.principal, close)
            : null,
        });
        const cookiePath = `/api/preview/proxy/${target.id}`;
        const secure = Boolean(req.secure);
        res.setHeader('Set-Cookie', buildCookie({
          name: TOKEN_COOKIE_NAME,
          value: target.token,
          path: cookiePath,
          maxAgeSeconds: Math.round((target.expiresAt - now()) / 1000),
          secure,
        }));

        return res.json({
          id: target.id,
          proxyBasePath: cookiePath,
          expiresAt: target.expiresAt,
        });
      } catch (error) {
        console.error('[preview-proxy] Failed to create target:', error);
        return res.status(500).json({ error: 'Failed to create preview target' });
      }
    };

    app.post('/api/preview/targets', express.json(), createTargetHandler(false));
    app.post('/api/browser/targets', express.json(), createTargetHandler(true));

    const createProxy = () => createProxyMiddleware({
      target: 'http://127.0.0.1',
      changeOrigin: true,
      // Loopback development may use self-signed certificates.
      secure: false,
      // WebSocket upgrades are wired manually below so authentication and
      // request-origin checks run before the proxy can touch the socket.
      ws: false,
      selfHandleResponse: true,
      // Restrict the proxy to preview paths. WebSocket upgrades are attached
      // manually below after authentication so terminal and message-stream
      // sockets can never be claimed by this proxy.
      //
      // We use a function so the same filter handles both cases:
      //   - HTTP requests through Express, where `req.url` has been stripped
      //     of the `/api/preview/proxy` mount-point, so we check `originalUrl`.
      //   - Raw upgrade events from the HTTP server, where `req.url` still
      //     contains the full path.
      pathFilter: (pathname, req) => {
        const target = req?.originalUrl || pathname || req?.url || '';
        return target.startsWith('/api/preview/proxy/');
      },
      router: (req) => {
        const resolved = resolveTargetFromRequest(req);
        if (!resolved.ok) {
          return 'http://127.0.0.1';
        }
        return routerTargetForEntry(resolved.entry);
      },
      pathRewrite: (pathValue, req) => {
        const resolved = resolveTargetFromRequest(req);
        if (!resolved.ok) {
          return pathValue;
        }

        const parsed = new URL(req.originalUrl || req.url || '', 'http://localhost');
        // Never forward our auth cookie token to the dev server.
        const strippedPath = stripProxyPrefix(parsed.pathname, resolved.id);
        const pathAndSearch = `${strippedPath}${stripInternalPreviewQuery(parsed.search)}`;
        return pathAndSearch;
      },
      on: {
        proxyReq: (proxyReq, req) => {
          applyPreviewPassthroughRequestHeaders(req, proxyReq);
          applyUpstreamNavigationHeaders(proxyReq, req, resolveTargetFromRequest(req));
          // Keep local dev servers from receiving OpenChamber credentials.
          const upstreamCookies = buildPreviewUpstreamCookieHeader(req.headers?.cookie);
          if (upstreamCookies) proxyReq.setHeader('cookie', upstreamCookies);
          else proxyReq.removeHeader('cookie');
          proxyReq.removeHeader('authorization');
          proxyReq.removeHeader('x-openchamber-ui-session');
          proxyReq.setHeader('accept-encoding', 'identity');
        },
        proxyReqWs: (proxyReq, req) => {
          applyPreviewPassthroughRequestHeaders(req, proxyReq);
          applyUpstreamNavigationHeaders(proxyReq, req, resolveTargetFromRequest(req));
          const upstreamCookies = buildPreviewUpstreamCookieHeader(req.headers?.cookie);
          if (upstreamCookies) proxyReq.setHeader('cookie', upstreamCookies);
          else proxyReq.removeHeader('cookie');
          proxyReq.removeHeader('authorization');
          proxyReq.removeHeader('x-openchamber-ui-session');
        },
        proxyRes: (() => {
          const interceptResponse = responseInterceptor(async (responseBuffer, proxyRes, req, res) => {
          applyPreviewPassthroughResponseHeaders(proxyRes, res);
          // Per-response nonce lets the injected bridge run under the dev
          // server's CSP without dropping its script restrictions wholesale.
          const bridgeNonce = crypto.randomBytes(16).toString('base64');
          // Allow the dev server response to be framed inside OpenChamber even
          // if it normally sets X-Frame-Options or a CSP frame-ancestors rule.
          // The proxy is same-origin so embedding is otherwise safe.
          stripFrameBustingHeaders(proxyRes.headers, bridgeNonce, res);

          const resolved = resolveTargetFromRequest(req);
          if (!resolved.ok) {
            return responseBuffer;
          }

          const proxyBasePath = `/api/preview/proxy/${resolved.id}`;
          rewritePreviewSetCookieHeaders(proxyRes.headers, proxyBasePath, { viewerSecure: isPreviewViewerSecure(req) });
          syncProxyResponseHeader(proxyRes.headers, res, 'set-cookie');
          const parsed = new URL(req.originalUrl || req.url || '', 'http://localhost');
          const upstreamPath = stripProxyPrefix(parsed.pathname, resolved.id);
          const locationHeader = readHeader(proxyRes.headers, 'location');
          if (locationHeader !== undefined) {
            const redirect = rewritePreviewRedirectLocation({
              location: Array.isArray(locationHeader) ? locationHeader[0] : String(locationHeader),
              targetOrigin: resolved.entry.origin,
              proxyBasePath,
              requestPath: `${upstreamPath}${parsed.search}`,
            });
            if (!redirect.ok) {
              res.statusCode = 502;
              delete proxyRes.headers.location;
              delete proxyRes.headers.Location;
              delete proxyRes.headers['content-length'];
              proxyRes.headers['content-type'] = 'application/json; charset=utf-8';
              res.removeHeader?.('location');
              res.setHeader?.('content-type', 'application/json; charset=utf-8');
              return Buffer.from(JSON.stringify({ error: redirect.error }), 'utf8');
            }
            if (redirect.externalUrl && !isPreviewNavigationRequest(req)) {
              // Subresource redirects keep their real status and absolute
              // target so the browser follows (or CORS-fails) them exactly as
              // it would without the proxy.
              proxyRes.headers.location = redirect.externalUrl;
              delete proxyRes.headers.Location;
              res.setHeader?.('location', redirect.externalUrl);
              return responseBuffer;
            }
            if (redirect.externalUrl) {
              res.statusCode = 200;
              delete proxyRes.headers.location;
              delete proxyRes.headers.Location;
              delete proxyRes.headers['content-length'];
              proxyRes.headers['content-type'] = 'text/html; charset=utf-8';
              proxyRes.headers['cache-control'] = 'no-store';
              res.removeHeader?.('location');
              res.setHeader?.('content-type', 'text/html; charset=utf-8');
              res.setHeader?.('cache-control', 'no-store');
              return Buffer.from(createPreviewViewerNavigationHandoffHtml({
                url: redirect.externalUrl,
                bridgeNonce,
                navigation: resolved.entry.browserRestricted ? 'target' : 'external',
              }), 'utf8');
            }
            proxyRes.headers.location = redirect.location;
            delete proxyRes.headers.Location;
            res.setHeader?.('location', redirect.location);
          }

          const contentType = String(proxyRes.headers?.['content-type'] || '').toLowerCase();
          const isHtml = contentType.includes('text/html') || contentType.includes('application/xhtml+xml');
          const isCss = contentType.includes('text/css');
          const isJavaScript = contentType.includes('javascript') || contentType.includes('ecmascript');
          if (!isHtml && !isCss && !isJavaScript) {
            return responseBuffer;
          }

          proxyRes.headers['cache-control'] = 'no-store, no-cache, must-revalidate, proxy-revalidate';
          proxyRes.headers.pragma = 'no-cache';
          proxyRes.headers.expires = '0';
          delete proxyRes.headers.etag;
          delete proxyRes.headers['last-modified'];
          res.setHeader?.('cache-control', proxyRes.headers['cache-control']);
          res.setHeader?.('pragma', proxyRes.headers.pragma);
          res.setHeader?.('expires', proxyRes.headers.expires);
          res.removeHeader?.('etag');
          res.removeHeader?.('last-modified');

          if (isJavaScript && upstreamPath === '/@vite/client') {
            return rewritePreviewBody({
              bodyText: rewriteViteClientHmr(responseBuffer.toString('utf8'), proxyBasePath),
              proxyBasePath,
              targetOrigin: resolved.entry.origin,
              kind: 'javascript',
            });
          }

          const rewrittenBody = rewritePreviewBody({
            bodyText: responseBuffer.toString('utf8'),
            proxyBasePath,
            targetOrigin: resolved.entry.origin,
            kind: isHtml ? 'html' : isCss ? 'css' : 'javascript',
          });
          return isHtml
            ? injectPreviewBridge(rewrittenBody, {
              proxyBasePath,
              targetOrigin: resolved.entry.origin,
              bridgeNonce,
              embedExternalNavigation: resolved.entry.browserRestricted,
              virtualizeLocation: true,
            })
            : rewrittenBody;
          });

          return (proxyRes, req, res) => {
            const contentType = String(readHeader(proxyRes?.headers, 'content-type') || '').toLowerCase();
            const hasRedirect = readHeader(proxyRes?.headers, 'location') !== undefined;
            const destination = String(readHeader(req?.headers, 'sec-fetch-dest') || '').toLowerCase();
            const isUntypedDocument = !contentType && (destination === 'document' || destination === 'iframe');
            if (isUntypedDocument) proxyRes.headers['content-type'] = 'text/html; charset=utf-8';
            const needsRewrite = hasRedirect
              || isUntypedDocument
              || contentType.includes('text/html')
              || contentType.includes('application/xhtml+xml')
              || contentType.includes('text/css')
              || contentType.includes('javascript')
              || contentType.includes('ecmascript');
            if (needsRewrite) return interceptResponse(proxyRes, req, res);

            const resolved = resolveTargetFromRequest(req);
            if (!resolved.ok) {
              res.statusCode = resolved.status;
              res.setHeader?.('content-type', 'application/json; charset=utf-8');
              res.end?.(JSON.stringify({ error: resolved.error }));
              return;
            }

            const proxyBasePath = `/api/preview/proxy/${resolved.id}`;
            rewritePreviewSetCookieHeaders(proxyRes.headers, proxyBasePath, { viewerSecure: isPreviewViewerSecure(req) });
            const bridgeNonce = crypto.randomBytes(16).toString('base64');
            stripFrameBustingHeaders(proxyRes.headers, bridgeNonce, res);
            res.statusCode = proxyRes.statusCode || 200;
            if (proxyRes.statusMessage) res.statusMessage = proxyRes.statusMessage;
            const hopByHopHeaders = new Set([
              'connection',
              'keep-alive',
              'proxy-authenticate',
              'proxy-authorization',
              'te',
              'trailer',
              'transfer-encoding',
              'upgrade',
            ]);
            for (const [name, value] of Object.entries(proxyRes.headers || {})) {
              if (value === undefined || hopByHopHeaders.has(name.toLowerCase())) continue;
              res.setHeader?.(name, value);
            }
            proxyRes.pipe(res);
          };
        })(),
        error: (err, _req, res) => {
          const isDev = typeof process !== 'undefined'
            && process
            && process.env
            && process.env.NODE_ENV !== 'production';

          const message = err && typeof err === 'object' && typeof err.message === 'string'
            ? err.message
            : 'Unknown proxy error';

          console.error('[preview-proxy] proxy error:', message);

          if (res && !res.headersSent && typeof res.status === 'function') {
            const payload = { error: 'Preview proxy error' };

            if (isDev) {
              try {
                const resolved = resolveTargetFromRequest(_req);
                payload.details = {
                  message,
                  code: err && typeof err === 'object' ? err.code : undefined,
                  targetOrigin: resolved?.ok ? resolved.entry.origin : undefined,
                };
              } catch {
                payload.details = { message };
              }
            }

            res.status(502).json(payload);
          }
        },
      },
    });

    const loopbackProxy = createProxy();

    app.use('/api/preview/proxy', async (req, res, next) => {
      const resolved = resolveTargetFromRequest(req);
      if (!resolved.ok) {
        return res.status(resolved.status).json({
          error: resolved.error,
          ...(resolved.code ? { code: resolved.code } : {}),
        });
      }
      if (resolved.entry.browserRestricted) {
        if (typeof uiAuthController?.ensureSessionToken === 'function') {
          const sessionToken = await uiAuthController.ensureSessionToken(req, res);
          if (!sessionToken) return res.status(401).json({ error: 'UI authentication required' });
        }
        if (!canUseBrowser(req.principal)) {
          return res.status(403).json({ error: 'Browser access is disabled' });
        }
      }
      next();
    }, (req, res, next) => {
      const resolved = resolveTargetFromRequest(req);
      if (!resolved.ok) {
        return res.status(resolved.status).json({
          error: resolved.error,
          ...(resolved.code ? { code: resolved.code } : {}),
        });
      }
      return loopbackProxy(req, res, next);
    });

    server.on('upgrade', (req, socket, head) => {
      const rawUrl = req?.url || '';
      if (!/^\/api\/preview\/proxy\/[a-f0-9]{16,64}(?:\/|$)/i.test(new URL(rawUrl, 'http://localhost').pathname)) {
        return;
      }

      const handleUpgrade = async () => {
        try {
          if (typeof uiAuthController?.ensureSessionToken === 'function') {
            const sessionToken = await uiAuthController?.ensureSessionToken?.(req, null);
            if (!sessionToken) {
              rejectWebSocketUpgrade(socket, 401, 'UI authentication required');
              return;
            }

            const originAllowed = await isRequestOriginAllowed(req);
            if (!originAllowed) {
              rejectWebSocketUpgrade(socket, 403, 'Invalid origin');
              return;
            }
          }

          const resolved = resolveTargetFromRequest(req);
          if (!resolved.ok) {
            rejectWebSocketUpgrade(socket, resolved.status, resolved.error);
            return;
          }
          if (resolved.entry.browserRestricted && !canUseBrowser(req.principal)) {
            rejectWebSocketUpgrade(socket, 403, 'Browser access is disabled');
            return;
          }

          const unregisterConnection = typeof uiAuthController?.registerConnection === 'function'
            ? uiAuthController.registerConnection(req.principal, () => socket.destroy())
            : () => {};
          socket.once('close', unregisterConnection);

          // Rewrite req.url to what the dev server expects.
          const rawUrl = req.url || '';
          req.originalUrl = rawUrl;
          const parsed = new URL(rawUrl, 'http://localhost');
          const nextPath = stripProxyPrefix(parsed.pathname, resolved.id);
          req.url = `${nextPath}${stripInternalPreviewQuery(parsed.search)}`;
          loopbackProxy.upgrade(req, socket, head);
        } catch {
          rejectWebSocketUpgrade(socket, 500, 'Upgrade failed');
        }
      };

      void handleUpgrade();
    });
  };

  return {
    attach,
    revokeGrantTargets(grantId) {
      if (!grantId) return 0;
      let removed = 0;
      for (const [targetId, target] of targets) {
        if (target.grantId !== grantId) continue;
        removeTarget(targetId);
        removed += 1;
      }
      return removed;
    },
    revokeOwnerTargets(ownerUserId) {
      if (!ownerUserId) return 0;
      let removed = 0;
      for (const [targetId, target] of targets) {
        if (target.ownerUserId !== ownerUserId) continue;
        removeTarget(targetId);
        removed += 1;
      }
      return removed;
    },
    getSnapshot: () => [...targets.values()].map((target) => ({
      id: target.id,
      origin: target.origin,
      grantId: target.grantId,
      projectKey: target.projectKey,
      browserRestricted: target.browserRestricted,
      createdAt: target.createdAt,
      expiresAt: target.expiresAt,
    })),
    shutdown() {
      if (sweepTimer) clearInterval(sweepTimer);
      sweepTimer = null;
      for (const targetId of [...targets.keys()]) removeTarget(targetId);
    },
  };
};
