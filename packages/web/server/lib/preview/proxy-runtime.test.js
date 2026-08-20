import { describe, expect, it } from 'vitest';
import { runInNewContext } from 'node:vm';

import {
  applyPreviewPassthroughRequestHeaders,
  applyPreviewPassthroughResponseHeaders,
  buildPreviewUpstreamCookieHeader,
  classifyPreviewNavigation,
  classifyPreviewRequestScope,
  classifyPreviewResourceError,
  createPreviewBridgeScript,
  createPreviewLocationVirtualizerScript,
  createPreviewViewerNavigationHandoffHtml,
  createPreviewProxyRuntime,
  isPreviewNavigationRequest,
  normalizeProxyTargetUrl,
  rewritePreviewBody,
  rewritePreviewCspHeader,
  rewritePreviewRedirectLocation,
  rewritePreviewSetCookieHeaders,
} from './proxy-runtime.js';

const createResponse = () => {
  const headers = new Map();
  return {
    body: null,
    statusCode: 200,
    headers,
    setHeader(name, value) {
      headers.set(name.toLowerCase(), value);
    },
    removeHeader(name) {
      headers.delete(name.toLowerCase());
    },
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(body) {
      this.body = body;
      return body;
    },
  };
};

const createAttachedPreviewRuntime = ({
  classifyRequestScope = () => 'local',
  previewInstancesRuntime = null,
  uiAuthController = null,
  canUseBrowser = () => true,
  resolveHost = null,
  now,
} = {}) => {
  let proxyOptions;
  const proxyOptionsList = [];
  const postRoutes = new Map();
  const useRoutes = [];
  const upgradeCalls = [];
  const rejectedUpgrades = [];
  let upgradeHandler = null;
  let randomByte = 0;
  const runtime = createPreviewProxyRuntime({
    crypto: {
      randomBytes(size) {
        randomByte += 1;
        return Buffer.alloc(size, randomByte);
      },
    },
    URL,
    createProxyMiddleware(options) {
      proxyOptions = options;
      proxyOptionsList.push(options);
      const middleware = () => {};
      middleware.upgrade = (req, socket, head) => upgradeCalls.push({ req, socket, head });
      return middleware;
    },
    responseInterceptor: (handler) => (proxyRes, req, res) => handler(
      proxyRes.bodyBuffer || Buffer.alloc(0),
      proxyRes,
      req,
      res,
    ),
    resolveHost,
    ...(now ? { now } : {}),
  });
  const app = {
    post(path, ...handlers) {
      postRoutes.set(path, handlers);
    },
    use(path, ...handlers) { useRoutes.push({ path, handlers }); },
  };
  runtime.attach(app, {
    server: {
      on(event, handler) {
        if (event === 'upgrade') upgradeHandler = handler;
      },
    },
    express: { json: () => (_req, _res, next) => next() },
    uiAuthController,
    isRequestOriginAllowed: async () => true,
    rejectWebSocketUpgrade(socket, status, message) {
      rejectedUpgrades.push({ socket, status, message });
    },
    classifyRequestScope,
    previewInstancesRuntime,
    canUseBrowser,
  });

  const registerTarget = async (url, {
    headers = {}, principal, directory, ttlMs, browser = false,
  } = {}) => {
    const handlers = postRoutes.get(browser ? '/api/browser/targets' : '/api/preview/targets');
    const handler = handlers[handlers.length - 1];
    const res = createResponse();
    await handler({
      body: { url, directory, ...(ttlMs === undefined ? {} : { ttlMs }) },
      secure: false,
      headers: { host: '127.0.0.1:3000', ...headers },
      socket: { remoteAddress: '127.0.0.1' },
      principal,
    }, res);
    const cookie = String(res.headers.get('set-cookie') || '');
    const token = cookie.match(/oc_preview_token=([^;]+)/)?.[1] || '';
    return {
      id: res.body.id,
      proxyBasePath: res.body.proxyBasePath,
      expiresAt: res.body.expiresAt,
      error: res.body.error,
      code: res.body.code,
      statusCode: res.statusCode,
      token,
    };
  };

  return {
    proxyOptions: () => proxyOptions,
    proxyOptionsList,
    registerTarget,
    runtime,
    useRoutes,
    upgradeCalls,
    rejectedUpgrades,
    upgrade: (...args) => upgradeHandler?.(...args),
  };
};

describe('preview request scope classification', () => {
  it('trusts only genuine loopback browser requests', () => {
    expect(classifyPreviewRequestScope({
      headers: { host: 'localhost:3000' },
      socket: { remoteAddress: '::ffff:127.0.0.1' },
    }, 'local')).toBe('local');
    expect(classifyPreviewRequestScope({
      headers: { host: 'devryan.example.com' },
      hostname: 'localhost',
      socket: { remoteAddress: '127.0.0.1' },
    }, 'local')).toBe('unknown-public');
    expect(classifyPreviewRequestScope({
      headers: { host: '192.168.1.5:3000' },
      socket: { remoteAddress: '192.168.1.20' },
    }, 'local')).toBe('unknown-public');
  });

  it('preserves authoritative tunnel classifications', () => {
    const request = {
      headers: { host: 'localhost:3000' },
      socket: { remoteAddress: '127.0.0.1' },
    };
    expect(classifyPreviewRequestScope(request, 'tunnel')).toBe('tunnel');
    expect(classifyPreviewRequestScope(request, 'unknown-public')).toBe('unknown-public');
  });
});

const rewrite = (bodyText, kind) => rewritePreviewBody({
  bodyText,
  kind,
  proxyBasePath: '/api/preview/proxy/abc123',
  targetOrigin: 'http://127.0.0.1:3000',
});

describe('preview resource error classification', () => {
  it('suppresses Astro/Vite stylesheet modules reported as failed scripts', () => {
    expect(classifyPreviewResourceError({
      tagName: 'script',
      url: 'http://127.0.0.1:57123/api/preview/proxy/f4af70b4261d77706743959516f9cecc/src/styles/global.css',
    })).toBe('suppress');

    expect(classifyPreviewResourceError({
      tagName: 'script',
      url: 'http://127.0.0.1:57123/api/preview/proxy/f4af70b4261d77706743959516f9cecc/src/pages/support.astro?astro&type=style&index=0&lang.css',
    })).toBe('suppress');
  });

  it('suppresses framework virtual modules reported by dev servers', () => {
    expect(classifyPreviewResourceError({
      tagName: 'script',
      url: 'http://127.0.0.1:57123/api/preview/proxy/f4af70b4261d77706743959516f9cecc/src/layouts/BaseLayout.astro?astro&type=script&index=0&lang.ts',
    })).toBe('suppress');

    expect(classifyPreviewResourceError({
      tagName: 'script',
      url: 'http://127.0.0.1:57123/api/preview/proxy/f4af70b4261d77706743959516f9cecc/@vite/client',
    })).toBe('suppress');

    expect(classifyPreviewResourceError({
      tagName: 'link',
      url: 'http://127.0.0.1:57123/api/preview/proxy/f4af70b4261d77706743959516f9cecc/@id/astro:scripts/page.js',
    })).toBe('suppress');
  });

  it('suppresses conservative ecosystem dev-runtime resources', () => {
    const noisyResources = [
      '/_next/static/chunks/webpack.js',
      '/_next/static/chunks/react-refresh.js',
      '/.svelte-kit/generated/client/app.js',
      '/@id/__x00__virtual:sveltekit:browser',
      '/@remix-run/dev/dist/browser.js',
      '/__hmr?runtime=remix',
      '/_nuxt/@vite/client',
      '/_nuxt/@id/virtual:nuxt:%2FUsers%2Fapp',
      '/webpack-dev-server/client/index.js',
      '/webpack/hot/dev-server.js',
      '/__webpack_hmr',
    ];

    for (const resource of noisyResources) {
      expect(classifyPreviewResourceError({
        tagName: 'script',
        url: `http://127.0.0.1:57123/api/preview/proxy/f4af70b4261d77706743959516f9cecc${resource}`,
      })).toBe('suppress');
    }
  });

  it('keeps ordinary application resource failures visible', () => {
    expect(classifyPreviewResourceError({
      tagName: 'script',
      url: 'http://127.0.0.1:57123/api/preview/proxy/f4af70b4261d77706743959516f9cecc/assets/app.js',
    })).toBe('report');

    expect(classifyPreviewResourceError({
      tagName: 'img',
      url: 'http://127.0.0.1:57123/api/preview/proxy/f4af70b4261d77706743959516f9cecc/missing.png',
    })).toBe('report');

    expect(classifyPreviewResourceError({
      tagName: 'link',
      url: 'http://127.0.0.1:57123/api/preview/proxy/f4af70b4261d77706743959516f9cecc/styles/missing.css',
    })).toBe('report');
  });
});

describe('preview body URL rewriting', () => {
  it('rewrites only HTML resource attributes in HTML responses', () => {
    const input = '<img src="/logo.png"><img src=/plain.png><video poster="/poster.webp"></video><button formaction=/save>Save</button><div style="background:url(\'/tile.webp\')"></div><a href="/docs">Docs</a><script>const url = "/api/data";</script>';
    const output = rewrite(input, 'html');

    expect(output).toContain('src="/api/preview/proxy/abc123/logo.png"');
    expect(output).toContain('src=/api/preview/proxy/abc123/plain.png');
    expect(output).toContain('poster="/api/preview/proxy/abc123/poster.webp"');
    expect(output).toContain('formaction=/api/preview/proxy/abc123/save');
    expect(output).toContain("style=\"background:url('/api/preview/proxy/abc123/tile.webp')\"");
    expect(output).toContain('href="/api/preview/proxy/abc123/docs"');
    expect(output).toContain('const url = "/api/data";');
  });

  it('drops subresource integrity hashes that rewriting would invalidate', () => {
    const output = rewrite(
      '<script src="/app.js" integrity="sha384-abc+123/def=" crossorigin="anonymous"></script><link rel=stylesheet href="/a.css" integrity=\'sha256-xyz\'>',
      'html',
    );

    expect(output).not.toContain('integrity');
    expect(output).toContain('src="/api/preview/proxy/abc123/app.js"');
    expect(output).toContain('crossorigin="anonymous"');
    expect(output).toContain('href="/api/preview/proxy/abc123/a.css"');
  });

  it('routes absolute resources on the registered public origin through the proxy', () => {
    const output = rewritePreviewBody({
      bodyText: '<base href="https://www.google.com/"><script src="https://www.google.com/x.js"></script><img src="https://cdn.example/x.png">',
      kind: 'html',
      proxyBasePath: '/api/preview/proxy/public123',
      targetOrigin: 'https://www.google.com',
    });

    expect(output).toContain('href="/api/preview/proxy/public123/"');
    expect(output).toContain('src="/api/preview/proxy/public123/x.js"');
    expect(output).toContain('src="https://cdn.example/x.png"');
  });

  it('rewrites only CSS imports and url references in CSS responses', () => {
    const input = '@import "/theme.css"; .hero { background: url(/hero.png); } .copy::after { content: "/not-a-url"; }';
    const output = rewrite(input, 'css');

    expect(output).toContain('@import "/api/preview/proxy/abc123/theme.css"');
    expect(output).toContain('url(/api/preview/proxy/abc123/hero.png)');
    expect(output).toContain('content: "/not-a-url"');
  });

  it('rewrites root-relative assets inside inline style blocks', () => {
    const input = '<style>@font-face { src: url("/fonts/app.woff2"); } main { background: url(/hero.webp); }</style>';
    const output = rewrite(input, 'html');

    expect(output).toContain('url("/api/preview/proxy/abc123/fonts/app.woff2")');
    expect(output).toContain('url(/api/preview/proxy/abc123/hero.webp)');
  });

  it('rewrites only JavaScript static import specifiers in JavaScript responses', () => {
    const input = 'import "/entry.js"; import value from "/module.js"; const url = "/api/data"; fetch("/api/data");';
    const output = rewrite(input, 'javascript');

    expect(output).toContain('import "/api/preview/proxy/abc123/entry.js"');
    expect(output).toContain('from "/api/preview/proxy/abc123/module.js"');
    expect(output).toContain('const url = "/api/data"');
    expect(output).toContain('fetch("/api/data")');
  });
});

describe('preview navigation policy', () => {
  const currentUrl = 'http://127.0.0.1:57123/api/preview/proxy/f4af70b4261d77706743959516f9cecc/docs';

  it('keeps same-page hash and already-proxied links in the iframe', () => {
    expect(classifyPreviewNavigation({ url: '#section', currentUrl }).action).toBe('allow');
    expect(classifyPreviewNavigation({
      url: 'http://127.0.0.1:57123/api/preview/proxy/f4af70b4261d77706743959516f9cecc/roadmap',
      currentUrl,
    }).action).toBe('allow');
  });

  it('routes loopback absolute links through the preview proxy', () => {
    expect(classifyPreviewNavigation({ url: 'http://localhost:3000/roadmap', currentUrl })).toEqual({
      action: 'proxy',
      url: 'http://localhost:3000/roadmap',
    });
  });

  it('sends non-loopback http links outside the preview iframe', () => {
    expect(classifyPreviewNavigation({ url: 'https://example.com/docs', currentUrl })).toEqual({
      action: 'external',
      url: 'https://example.com/docs',
    });
  });

  it('leaves non-http links to browser defaults', () => {
    expect(classifyPreviewNavigation({ url: 'mailto:test@example.com', currentUrl })).toEqual({
      action: 'allow',
      url: 'mailto:test@example.com',
    });
  });
});

describe('preview redirect policy', () => {
  it('rewrites relative and same-origin redirects through the target path', () => {
    expect(rewritePreviewRedirectLocation({
      location: '/login?next=%2Fdocs',
      targetOrigin: 'http://127.0.0.1:3000',
      proxyBasePath: '/api/preview/proxy/abc123',
      requestPath: '/docs/start',
    })).toEqual({
      ok: true,
      location: '/api/preview/proxy/abc123/login?next=%2Fdocs',
    });
    expect(rewritePreviewRedirectLocation({
      location: 'next',
      targetOrigin: 'http://127.0.0.1:3000',
      proxyBasePath: '/api/preview/proxy/abc123',
      requestPath: '/docs/start',
    }).location).toBe('/api/preview/proxy/abc123/docs/next');
  });

  it('hands non-loopback redirects to the viewer but rejects unapproved loopback pivots', () => {
    expect(rewritePreviewRedirectLocation({
      location: 'http://127.0.0.1:4000/admin',
      targetOrigin: 'http://127.0.0.1:3000',
      proxyBasePath: '/api/preview/proxy/abc123',
    })).toMatchObject({ ok: false });
    expect(rewritePreviewRedirectLocation({
      location: 'https://example.com',
      targetOrigin: 'http://127.0.0.1:3000',
      proxyBasePath: '/api/preview/proxy/abc123',
    })).toEqual({ ok: true, externalUrl: 'https://example.com/' });
    expect(rewritePreviewRedirectLocation({
      location: 'http://192.168.1.20/admin',
      targetOrigin: 'http://127.0.0.1:3000',
      proxyBasePath: '/api/preview/proxy/abc123',
    })).toEqual({ ok: true, externalUrl: 'http://192.168.1.20/admin' });

    const html = createPreviewViewerNavigationHandoffHtml({
      url: 'https://example.com/?next=<script>',
      bridgeNonce: 'fixture-nonce',
    });
    expect(html).toContain('nonce="fixture-nonce"');
    expect(html).not.toContain("navigation: 'external'");
    expect(html).toContain('"navigation":"external"');
    expect(html).not.toContain('<script>');
  });

  it('keeps a public target\'s own redirects inside the proxy', () => {
    expect(rewritePreviewRedirectLocation({
      location: '/auth?state=x',
      targetOrigin: 'https://auth.example.com',
      proxyBasePath: '/api/preview/proxy/abc123',
      requestPath: '/login',
    })).toEqual({
      ok: true,
      location: '/api/preview/proxy/abc123/auth?state=x',
    });
    expect(rewritePreviewRedirectLocation({
      location: 'https://auth.example.com/next',
      targetOrigin: 'https://auth.example.com',
      proxyBasePath: '/api/preview/proxy/abc123',
      requestPath: '/login',
    }).location).toBe('/api/preview/proxy/abc123/next');
    expect(rewritePreviewRedirectLocation({
      location: 'https://other.example.com/',
      targetOrigin: 'https://auth.example.com',
      proxyBasePath: '/api/preview/proxy/abc123',
      requestPath: '/login',
    })).toEqual({ ok: true, externalUrl: 'https://other.example.com/' });
  });

  it('treats loopback spellings of the same target as one origin', () => {
    expect(rewritePreviewRedirectLocation({
      location: 'http://localhost:3000/next',
      targetOrigin: 'http://127.0.0.1:3000',
      proxyBasePath: '/api/preview/proxy/abc123',
    }).location).toBe('/api/preview/proxy/abc123/next');
  });

  it('classifies only document and iframe requests as navigations', () => {
    expect(isPreviewNavigationRequest({ headers: { 'sec-fetch-dest': 'iframe' } })).toBe(true);
    expect(isPreviewNavigationRequest({ headers: { 'sec-fetch-dest': 'document' } })).toBe(true);
    expect(isPreviewNavigationRequest({
      headers: { 'sec-fetch-dest': 'empty', accept: 'application/json' },
    })).toBe(false);
    // A fetch that advertises text/html must not be mistaken for a navigation.
    expect(isPreviewNavigationRequest({
      headers: { 'sec-fetch-dest': 'empty', accept: 'text/html' },
    })).toBe(false);
    // Browsers without Fetch Metadata still fall back to Accept.
    expect(isPreviewNavigationRequest({ headers: { accept: 'text/html,*/*' } })).toBe(true);
    expect(isPreviewNavigationRequest({ headers: {} })).toBe(false);
  });
});

describe('preview cookie isolation', () => {
  it('forwards app cookies while stripping every DevRyan credential namespace', () => {
    expect(buildPreviewUpstreamCookieHeader([
      'oc_app_session=secret',
      'oc_preview_token=target-secret',
      'devryan_internal=secret',
      'theme=dark',
      'app_session=abc',
    ].join('; '))).toBe('theme=dark; app_session=abc');
  });

  it('scopes upstream cookies to one target and drops domain or reserved cookies', () => {
    const headers = {
      'Set-Cookie': [
        'app_session=abc; Path=/; HttpOnly; SameSite=Lax',
        'theme=dark; Path=/account; Domain=localhost',
        'oc_app_session=malicious; Path=/',
      ],
    };
    rewritePreviewSetCookieHeaders(headers, '/api/preview/proxy/abc123');
    expect(headers['Set-Cookie']).toBeUndefined();
    expect(headers['set-cookie']).toEqual([
      'app_session=abc; Path=/api/preview/proxy/abc123; HttpOnly; SameSite=Lax',
      'theme=dark; Path=/api/preview/proxy/abc123/account',
    ]);
  });

  it('carries prefixed auth cookies across the viewer origin and restores them upstream', () => {
    const headers = {
      'set-cookie': [
        '__Host-Session=abc; Path=/; Secure; HttpOnly; SameSite=None',
        '__Secure-Csrf=xyz; Path=/; Secure',
        '__ocproxy-spoofed=evil; Path=/',
      ],
    };
    rewritePreviewSetCookieHeaders(headers, '/api/preview/proxy/abc123');
    expect(headers['set-cookie']).toEqual([
      '__ocproxy-__Host-Session=abc; Path=/api/preview/proxy/abc123; Secure; HttpOnly; SameSite=None',
      '__ocproxy-__Secure-Csrf=xyz; Path=/api/preview/proxy/abc123; Secure',
    ]);

    expect(buildPreviewUpstreamCookieHeader([
      '__ocproxy-__Host-Session=abc',
      '__ocproxy-__Secure-Csrf=xyz',
      '__ocproxy-notprefixed=nope',
      '__Host-direct=blocked',
      'oc_app_session=secret',
      'theme=dark',
    ].join('; '))).toBe('__Host-Session=abc; __Secure-Csrf=xyz; theme=dark');
  });

  it('drops Secure and downgrades SameSite=None on an insecure viewer origin', () => {
    const headers = {
      'set-cookie': ['__Host-Session=abc; Path=/; Secure; HttpOnly; SameSite=None'],
    };
    rewritePreviewSetCookieHeaders(headers, '/api/preview/proxy/abc123', { viewerSecure: false });
    expect(headers['set-cookie']).toEqual([
      '__ocproxy-__Host-Session=abc; Path=/api/preview/proxy/abc123; HttpOnly; SameSite=Lax',
    ]);
  });
});

describe('preview bridge lifecycle', () => {
  it('reports history navigation without asking the parent to rebuild the iframe', () => {
    const script = createPreviewBridgeScript({
      proxyBasePath: '/api/preview/proxy/abc123',
      targetOrigin: 'http://127.0.0.1:3000',
    });

    expect(script).toContain('window.__openchamberPreviewConfig=');
    expect(script).toContain("navigation: 'display'");
    expect(script).toContain("for (const method of ['pushState', 'replaceState'])");
    expect(script).toContain("navigation: 'target'");
    expect(script).toContain("parsed.searchParams.delete('ocPreview')");
    expect(script).toContain('installWebSocketProxyPatch');
    expect(script).toContain('parsed.pathname = proxyBase + path');
    expect(script).toContain("normalizedHost(url.hostname) === normalizedHost(registeredTarget.hostname)");
    expect(script).toContain("typeof input === 'string' || input instanceof URL");
    expect(script).toContain("if (!belongsToRegisteredTarget(parsed)) return value");
    expect(script).toContain("window.navigation.addEventListener('navigate'");
    expect(script).toContain('destination.sameDocument === true');
    expect(script).toContain("window.addEventListener('submit'");
    expect(script).toContain("type: 'render-ready'");
    expect(script).toContain("document.addEventListener('readystatechange'");
    expect(script).toContain('handOffExternalNavigation');
    expect(script).toContain("outerHTML: clip(element.outerHTML || '', 6000)");
    expect(script).toContain("post({ type: 'select', target");
  });

  it('presents the target route to the SPA while keeping requests on the registered proxy', async () => {
    const proxyBasePath = '/api/preview/proxy/0123456789abcdef0123456789abcdef';
    const targetOrigin = 'http://127.0.0.1:8080';
    let currentUrl = new URL(`http://127.0.0.1:3101${proxyBasePath}/?ocBrowser=1`);
    const messages = [];
    const fetches = [];
    const listeners = new Map();
    const navigationListeners = new Map();
    const location = {
      get href() { return currentUrl.toString(); },
      get origin() { return currentUrl.origin; },
      get protocol() { return currentUrl.protocol; },
      get host() { return currentUrl.host; },
      get hostname() { return currentUrl.hostname; },
      get port() { return currentUrl.port; },
      get pathname() { return currentUrl.pathname; },
      get search() { return currentUrl.search; },
      get hash() { return currentUrl.hash; },
      assign(value) { currentUrl = new URL(value, currentUrl); },
      replace(value) { currentUrl = new URL(value, currentUrl); },
      reload() {},
    };
    const updateHistory = (_state, _title, value) => {
      if (value !== undefined && value !== null) {
        currentUrl = new URL(String(value), currentUrl);
      }
    };
    const parent = {
      postMessage(message) {
        messages.push(message);
      },
    };
    class FakeElement {
      constructor() {
        this.attributes = new Map();
      }

      setAttribute(name, value) {
        this.attributes.set(name, String(value));
      }

      getAttribute(name) {
        return this.attributes.get(name) || null;
      }
    }
    const window = {
      location,
      parent,
      Element: FakeElement,
      navigation: {
        addEventListener(type, listener) {
          navigationListeners.set(type, listener);
        },
      },
      history: {
        state: null,
        pushState: updateHistory,
        replaceState: updateHistory,
      },
      addEventListener(type, listener) {
        listeners.set(type, listener);
      },
      requestAnimationFrame(callback) {
        callback();
        return 1;
      },
      setTimeout,
      clearTimeout,
      fetch: async (input) => {
        fetches.push(String(input));
        return { ok: true };
      },
    };
    const document = {
      title: 'Target fixture',
      documentElement: {
        style: {},
        dataset: {},
        hasAttribute: () => false,
      },
      querySelector: () => null,
      elementFromPoint: () => null,
    };

    runInNewContext(createPreviewBridgeScript({ proxyBasePath, targetOrigin }), {
      window,
      document,
      console: { log() {}, info() {}, warn() {}, error() {}, debug() {} },
      URL,
      setTimeout,
      clearTimeout,
    });
    runInNewContext(createPreviewLocationVirtualizerScript(proxyBasePath), {
      window,
      document,
      console: { log() {}, info() {}, warn() {}, error() {}, debug() {} },
      URL,
      setTimeout,
      clearTimeout,
    });

    expect(location.pathname).toBe('/');
    expect(location.search).toBe('');
    expect(window.__openchamberPreviewLocationVirtualized).toBe(true);
    expect(messages.some((message) => (
      message.type === 'ready' && message.url === `${targetOrigin}/`
    ))).toBe(true);
    expect(messages).toContainEqual(expect.objectContaining({ type: 'render-ready' }));

    await window.fetch('/api/data?fixture=1');
    expect(fetches).toEqual([`${proxyBasePath}/api/data?fixture=1`]);

    const dynamicImage = new FakeElement();
    dynamicImage.setAttribute('src', '/images/dynamic.webp');
    dynamicImage.setAttribute('srcset', '/images/small.webp 1x, /images/large.webp 2x');
    dynamicImage.setAttribute('style', 'background-image: url("/images/background.webp")');
    expect(dynamicImage.getAttribute('src')).toBe(`${proxyBasePath}/images/dynamic.webp`);
    expect(dynamicImage.getAttribute('srcset')).toBe(
      `${proxyBasePath}/images/small.webp 1x, ${proxyBasePath}/images/large.webp 2x`,
    );
    expect(dynamicImage.getAttribute('style')).toBe(
      `background-image: url("${proxyBasePath}/images/background.webp")`,
    );

    let navigationCancelled = false;
    navigationListeners.get('navigate')?.({
      destination: { url: 'https://auth.example.com/sign-in' },
      cancelable: true,
      preventDefault() { navigationCancelled = true; },
      stopPropagation() {},
    });
    expect(navigationCancelled).toBe(true);
    expect(messages).toContainEqual(expect.objectContaining({
      type: 'navigate-preview',
      navigation: 'external',
      url: 'https://auth.example.com/sign-in',
    }));

    navigationCancelled = false;
    navigationListeners.get('navigate')?.({
      destination: { url: 'http://127.0.0.1:3101/supabase-proxy/auth/v1/authorize?provider=google' },
      cancelable: true,
      preventDefault() { navigationCancelled = true; },
      stopPropagation() {},
    });
    expect(navigationCancelled).toBe(true);
    expect(location.pathname).toBe(`${proxyBasePath}/supabase-proxy/auth/v1/authorize`);
    expect(location.search).toBe('?provider=google');
    expect(messages).toContainEqual(expect.objectContaining({
      type: 'navigate-preview',
      navigation: 'display',
      url: `${targetOrigin}/supabase-proxy/auth/v1/authorize?provider=google`,
    }));
    expect(messages).toContainEqual(expect.objectContaining({ type: 'navigation-start' }));

    const beforeSameDocumentNavigation = currentUrl.toString();
    const navigationStartCount = messages.filter((message) => message.type === 'navigation-start').length;
    navigationCancelled = false;
    navigationListeners.get('navigate')?.({
      destination: { url: `${targetOrigin}/account`, sameDocument: true },
      cancelable: true,
      preventDefault() { navigationCancelled = true; },
      stopPropagation() {},
    });
    expect(navigationCancelled).toBe(false);
    expect(currentUrl.toString()).toBe(beforeSameDocumentNavigation);
    expect(messages.filter((message) => message.type === 'navigation-start')).toHaveLength(navigationStartCount);

    let formCancelled = false;
    listeners.get('submit')?.({
      target: { action: 'https://accounts.example.com/continue' },
      cancelable: true,
      preventDefault() { formCancelled = true; },
      stopPropagation() {},
    });
    expect(formCancelled).toBe(true);
    expect(messages).toContainEqual(expect.objectContaining({
      type: 'navigate-preview',
      navigation: 'external',
      url: 'https://accounts.example.com/continue',
    }));

    const localForm = { action: 'http://127.0.0.1:3101/session' };
    listeners.get('submit')?.({ target: localForm });
    expect(localForm.action).toBe(`${proxyBasePath}/session`);
  });

  it('escapes markup in injected configuration', () => {
    const script = createPreviewBridgeScript({
      proxyBasePath: '/api/preview/proxy/abc123',
      targetOrigin: 'http://127.0.0.1:3000/<script>',
    });

    expect(script).not.toContain('3000/<script>');
    expect(script).toContain('3000/\\u003cscript>');
  });

  it('routes cross-origin navigation back through Browser when embedding is enabled', () => {
    const script = createPreviewBridgeScript({
      proxyBasePath: '/api/preview/proxy/abc123',
      targetOrigin: 'https://www.google.com',
      embedExternalNavigation: true,
    });

    expect(script).toContain('"embedExternalNavigation":true');
    expect(script).toContain("embedExternalNavigation ? 'target' : 'external'");
    expect(script).toContain('isRegisteredTarget');
  });
});

describe('preview Inertia header passthrough', () => {
  it('forwards Inertia request headers to the preview target', () => {
    const forwarded = new Map();
    const proxyReq = {
      setHeader: (name, value) => forwarded.set(name, value),
    };

    applyPreviewPassthroughRequestHeaders({
      headers: {
        'x-inertia': 'true',
        'x-inertia-version': 'asset-hash',
        'x-unrelated': 'ignored',
      },
    }, proxyReq);

    expect(forwarded.get('x-inertia')).toBe('true');
    expect(forwarded.get('x-inertia-version')).toBe('asset-hash');
    expect(forwarded.has('x-unrelated')).toBe(false);
  });

  it('forwards Inertia response headers back to the preview client', () => {
    const forwarded = new Map();
    const res = {
      headersSent: false,
      setHeader: (name, value) => forwarded.set(name, value),
    };

    applyPreviewPassthroughResponseHeaders({
      headers: {
        'x-inertia': 'true',
        'x-inertia-location': 'http://127.0.0.1:8000/login',
        'x-unrelated': 'ignored',
      },
    }, res);

    expect(forwarded.get('x-inertia')).toBe('true');
    expect(forwarded.get('x-inertia-location')).toBe('http://127.0.0.1:8000/login');
    expect(forwarded.has('x-unrelated')).toBe(false);
  });

  it('does not touch a response whose headers were already sent', () => {
    const forwarded = new Map();
    const res = {
      headersSent: true,
      setHeader: (name, value) => forwarded.set(name, value),
    };

    applyPreviewPassthroughResponseHeaders({ headers: { 'x-inertia': 'true' } }, res);

    expect(forwarded.size).toBe(0);
  });
});

describe('preview inline module script rewriting', () => {
  it('rewrites inline module imports in HTML responses', () => {
    const input = [
      '<script type="module">',
      'import RefreshRuntime from "/@react-refresh";',
      'window.__vite_plugin_react_preamble_installed__ = true;',
      '</script>',
      '<script type=module>',
      'import { injectIntoGlobalHook } from "/@react-refresh";',
      'import value from "/module.js";',
      'const url = "/api/data";',
      '</script>',
      "<script type='module'>",
      'import "/entry.js";',
      '</script>',
      '<script type="text/javascript">',
      'import "/not-rewritten.js";',
      '</script>',
      '<script>const refreshUrl = "/@react-refresh";</script>',
    ].join('');
    const output = rewrite(input, 'html');

    expect(output).toContain('from "/api/preview/proxy/abc123/@react-refresh"');
    expect(output).toContain('import { injectIntoGlobalHook } from "/api/preview/proxy/abc123/@react-refresh";');
    expect(output).toContain('import value from "/api/preview/proxy/abc123/module.js";');
    expect(output).toContain('const url = "/api/data";');
    expect(output).toContain('import "/api/preview/proxy/abc123/entry.js";');
    expect(output).toContain('import "/not-rewritten.js";');
    expect(output).toContain('window.__vite_plugin_react_preamble_installed__ = true;');
    expect(output).toContain('const refreshUrl = "/@react-refresh";');
  });

  it('rewrites dynamic imports inside inline module scripts', () => {
    const input = '<script type="module">const page = await import("/pages/home.js");</script>';
    const output = rewrite(input, 'html');

    expect(output).toContain('import("/api/preview/proxy/abc123/pages/home.js")');
  });

  it('leaves external module scripts to the attribute rewriter', () => {
    const input = '<script type="module" src="/app.js">import "/ignored.js";</script>';
    const output = rewrite(input, 'html');

    expect(output).toContain('src="/api/preview/proxy/abc123/app.js"');
    expect(output).toContain('import "/ignored.js";');
  });

  it('removes CSP meta tags that block the preview bridge', () => {
    const input = '<meta http-equiv="Content-Security-Policy" content="script-src \'self\'"><div>Preview</div>';
    const output = rewrite(input, 'html');

    expect(output).not.toContain('Content-Security-Policy');
    expect(output).toContain('<div>Preview</div>');
  });
});

describe('proxy target normalization', () => {
  it('rejects every non-loopback host', () => {
    expect(normalizeProxyTargetUrl('https://example.com/').ok).toBe(false);
    for (const url of [
      'http://10.0.0.5/',
      'http://172.16.9.9/',
      'http://192.168.1.1/',
      'http://169.254.169.254/latest/meta-data/',
      'http://100.64.0.1/',
      'http://service.local/',
      'http://[fd00::1]/',
      'http://[fe80::1]/',
    ]) {
      expect(normalizeProxyTargetUrl(url).ok, url).toBe(false);
    }
  });

  it('accepts and normalizes loopback hosts on the default path', () => {
    expect(normalizeProxyTargetUrl('http://localhost:3000/'))
      .toEqual({ ok: true, origin: 'http://127.0.0.1:3000' });
    expect(normalizeProxyTargetUrl('http://[::1]:3000/'))
      .toEqual({ ok: true, origin: 'http://127.0.0.1:3000' });
  });
});

describe('preview CSP rewrite', () => {
  it('drops frame-ancestors and require-trusted-types-for but keeps the rest', () => {
    const result = rewritePreviewCspHeader(
      "default-src 'self'; frame-ancestors 'none'; require-trusted-types-for 'script'",
      'abc123',
    );
    expect(result).not.toContain('frame-ancestors');
    expect(result).not.toContain('require-trusted-types-for');
    expect(result).toContain("default-src 'self'");
  });

  it('adds the nonce to an existing script-src instead of removing it', () => {
    const result = rewritePreviewCspHeader("script-src 'self'", 'abc123');
    expect(result).toContain("script-src 'self' 'nonce-abc123'");
  });

  it('adds the nonce to script-src-elem when present', () => {
    const result = rewritePreviewCspHeader("script-src-elem 'self'", 'abc123');
    expect(result).toContain("script-src-elem 'self' 'nonce-abc123'");
  });

  it('synthesizes script-src from default-src when no script directive exists', () => {
    const result = rewritePreviewCspHeader("default-src 'self' https://cdn.example.com", 'abc123');
    expect(result).toContain("default-src 'self' https://cdn.example.com");
    expect(result).toContain("script-src 'self' https://cdn.example.com 'nonce-abc123'");
  });

  it("drops a lone 'none' so the nonce takes effect", () => {
    const result = rewritePreviewCspHeader("script-src 'none'", 'abc123');
    expect(result).toBe("script-src 'nonce-abc123'");
  });

  it('returns null when only frame-ancestors was present', () => {
    expect(rewritePreviewCspHeader("frame-ancestors 'none'", '')).toBe(null);
  });

  it('returns empty/unset CSP values unchanged', () => {
    expect(rewritePreviewCspHeader('', 'abc123')).toBe('');
    expect(rewritePreviewCspHeader(undefined, 'abc123')).toBe(undefined);
  });
});

describe('attached proxy runtime', () => {
  it('accepts preview proxy paths and rejects other WebSocket paths like the terminal', () => {
    const { proxyOptions } = createAttachedPreviewRuntime();
    const pathFilter = proxyOptions().pathFilter;

    expect(pathFilter('/api/preview/proxy/abc123/', { originalUrl: '/api/preview/proxy/abc123/' })).toBe(true);
    expect(pathFilter('/api/preview/proxy/abc123/ws', { url: '/api/preview/proxy/abc123/ws' })).toBe(true);
    expect(pathFilter('/api/terminal/ws', { url: '/api/terminal/ws' })).toBe(false);
    expect(pathFilter('/api/other', {})).toBe(false);
  });

  it('shares one per-response nonce between the rewritten CSP and the injected bridge', async () => {
    const { proxyOptions, registerTarget } = createAttachedPreviewRuntime();
    const target = await registerTarget('http://127.0.0.1:3000');

    const req = {
      originalUrl: `${target.proxyBasePath}/`,
      url: `${target.proxyBasePath}/`,
      headers: { cookie: `oc_preview_token=${target.token}` },
    };
    const proxyRes = {
      bodyBuffer: Buffer.from('<html><head></head><body>Hi</body></html>'),
      headers: {
        'content-type': 'text/html',
        'content-security-policy': ["script-src 'self'; frame-ancestors 'none'", "img-src 'self'"],
        'content-security-policy-report-only': "script-src 'none'",
        'x-frame-options': 'DENY',
        'set-cookie': ['theme=dark; Path=/; SameSite=Lax'],
        etag: 'upstream-etag',
      },
    };
    const res = createResponse();

    const body = await proxyOptions().on.proxyRes(
      proxyRes,
      req,
      res,
    );

    expect(proxyRes.headers['x-frame-options']).toBeUndefined();
    expect(res.headers.has('x-frame-options')).toBe(false);

    const cspValues = proxyRes.headers['content-security-policy'];
    expect(Array.isArray(cspValues)).toBe(true);
    const nonce = cspValues[0].match(/'nonce-([^']+)'/)?.[1];
    expect(nonce).toBeTruthy();
    expect(cspValues[0]).not.toContain('frame-ancestors');
    expect(cspValues[1]).toBe("img-src 'self'");
    expect(proxyRes.headers['content-security-policy-report-only']).toBe(`script-src 'nonce-${nonce}'`);
    expect(res.headers.get('content-security-policy')).toEqual(cspValues);
    expect(res.headers.get('content-security-policy-report-only')).toBe(`script-src 'nonce-${nonce}'`);
    expect(res.headers.get('set-cookie')).toEqual([
      `theme=dark; Path=${target.proxyBasePath}; SameSite=Lax`,
    ]);
    expect(res.headers.get('cache-control')).toBe('no-store, no-cache, must-revalidate, proxy-revalidate');
    expect(res.headers.has('etag')).toBe(false);
    expect(body).toContain(`<script id="openchamber-preview-bridge" nonce="${nonce}">`);
  });

  it('injects the bridge without touching headers when the target sends no CSP', async () => {
    const { proxyOptions, registerTarget } = createAttachedPreviewRuntime();
    const target = await registerTarget('http://127.0.0.1:3000');

    const req = {
      originalUrl: `${target.proxyBasePath}/`,
      url: `${target.proxyBasePath}/`,
      headers: { cookie: `oc_preview_token=${target.token}` },
    };
    const proxyRes = {
      bodyBuffer: Buffer.from('<html><head></head><body>Hi</body></html>'),
      headers: { 'content-type': 'text/html' },
    };
    const res = createResponse();

    const body = await proxyOptions().on.proxyRes(
      proxyRes,
      req,
      res,
    );

    expect(proxyRes.headers['content-security-policy']).toBeUndefined();
    expect(body).toMatch(/<script id="openchamber-preview-bridge" nonce="[^"]+">/);
  });

  it('streams binary and long-lived responses without buffering them', async () => {
    const { proxyOptions, registerTarget } = createAttachedPreviewRuntime();
    const target = await registerTarget('http://127.0.0.1:3000');
    const req = {
      originalUrl: `${target.proxyBasePath}/video.mp4`,
      url: `${target.proxyBasePath}/video.mp4`,
      headers: { cookie: `oc_preview_token=${target.token}` },
    };
    const res = createResponse();
    let pipedTo = null;
    const proxyRes = {
      statusCode: 206,
      statusMessage: 'Partial Content',
      headers: {
        'content-type': 'video/mp4',
        'content-length': '4096',
        'transfer-encoding': 'chunked',
        'x-frame-options': 'DENY',
      },
      pipe(destination) {
        pipedTo = destination;
      },
    };

    await proxyOptions().on.proxyRes(proxyRes, req, res);

    expect(pipedTo).toBe(res);
    expect(res.statusCode).toBe(206);
    expect(res.headers.get('content-type')).toBe('video/mp4');
    expect(res.headers.get('content-length')).toBe('4096');
    expect(res.headers.has('transfer-encoding')).toBe(false);
    expect(res.headers.has('x-frame-options')).toBe(false);
  });

  it('binds proxy targets to the authenticated browser session', async () => {
    const { registerTarget, useRoutes } = createAttachedPreviewRuntime();
    const ownerCookie = 'oc_app_session=owner-session';
    const target = await registerTarget('http://127.0.0.1:3000', {
      headers: { cookie: ownerCookie },
      principal: { id: 'user-1', appSessionId: 'app-1' },
    });
    const route = useRoutes.find((entry) => entry.path === '/api/preview/proxy');
    const guard = route.handlers[0];

    let nextCalled = false;
    const ownerResponse = createResponse();
    guard({
      originalUrl: `${target.proxyBasePath}/`,
      headers: { cookie: `${ownerCookie}; oc_preview_token=${target.token}` },
    }, ownerResponse, () => { nextCalled = true; });
    expect(nextCalled).toBe(true);

    const otherResponse = createResponse();
    guard({
      originalUrl: `${target.proxyBasePath}/`,
      headers: { cookie: `oc_app_session=other-session; oc_preview_token=${target.token}` },
    }, otherResponse, () => {});
    expect(otherResponse.statusCode).toBe(403);
    expect(otherResponse.body.error).toContain('another session');
  });

  it('gates Browser target creation and continued proxy access without changing Preview', async () => {
    let browserAllowed = false;
    const harness = createAttachedPreviewRuntime({
      canUseBrowser: () => browserAllowed,
    });

    const denied = await harness.registerTarget('http://127.0.0.1:3000', {
      browser: true,
      principal: { id: 'user-1', policy: { browser: false } },
    });
    expect(denied.id).toBeUndefined();
    expect(harness.runtime.getSnapshot()).toEqual([]);

    const preview = await harness.registerTarget('http://127.0.0.1:3000', {
      principal: { id: 'user-1', policy: { browser: false } },
    });
    expect(preview.id).toBeTruthy();

    browserAllowed = true;
    const browser = await harness.registerTarget('http://127.0.0.1:3001', {
      browser: true,
      principal: { id: 'user-1', policy: { browser: true } },
    });
    expect(harness.runtime.getSnapshot().find((target) => target.id === browser.id))
      .toMatchObject({ browserRestricted: true });

    browserAllowed = false;
    const route = harness.useRoutes.find((entry) => entry.path === '/api/preview/proxy');
    const response = createResponse();
    let nextCalled = false;
    await route.handlers[0]({
      originalUrl: `${browser.proxyBasePath}/`,
      headers: { cookie: `oc_preview_token=${browser.token}` },
      principal: { id: 'user-1', policy: { browser: false } },
    }, response, () => { nextCalled = true; });
    expect(response.statusCode).toBe(403);
    expect(nextCalled).toBe(false);

    const socket = { once() {}, destroy() {} };
    harness.upgrade({
      url: `${browser.proxyBasePath}/hmr`,
      headers: { cookie: `oc_preview_token=${browser.token}` },
      principal: { id: 'user-1', policy: { browser: false } },
    }, socket, Buffer.alloc(0));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(harness.rejectedUpgrades).toContainEqual({
      socket,
      status: 403,
      message: 'Browser access is disabled',
    });
  });

  it('rejects external Browser targets without DNS or outbound proxy setup', async () => {
    const dnsCalls = [];
    const harness = createAttachedPreviewRuntime({
      resolveHost: async (hostname) => {
        dnsCalls.push(hostname);
        return [
          { address: '2001:4860:4860::8888', family: 6 },
          { address: '142.250.191.100', family: 4 },
        ];
      },
    });

    const preview = await harness.registerTarget('https://www.google.com/');
    expect(preview.statusCode).toBe(400);

    const browser = await harness.registerTarget('https://www.google.com/search?q=devryan', {
      browser: true,
      principal: { id: 'user-1', policy: { browser: true } },
    });
    expect(browser.statusCode).toBe(400);
    expect(browser.code).toBe('browser_external_target_requires_client');
    expect(browser.error).toContain('opened on the client');
    expect(dnsCalls).toEqual([]);
    expect(harness.runtime.getSnapshot()).toEqual([]);
  });

  it('returns the client-navigation contract for private names and nonstandard external ports', async () => {
    const privateDns = createAttachedPreviewRuntime({
      resolveHost: async () => [
        { address: '142.250.191.100', family: 4 },
        { address: '169.254.169.254', family: 4 },
      ],
    });
    const rebound = await privateDns.registerTarget('https://browser.example/', { browser: true });
    expect(rebound.statusCode).toBe(400);
    expect(rebound.code).toBe('browser_external_target_requires_client');

    const unsafePort = await privateDns.registerTarget('https://browser.example:8443/', { browser: true });
    expect(unsafePort.statusCode).toBe(400);
    expect(unsafePort.code).toBe('browser_external_target_requires_client');
  });

  it('hands external Browser redirects to the client while Preview uses its external handoff', async () => {
    const harness = createAttachedPreviewRuntime();
    const browser = await harness.registerTarget('http://127.0.0.1:3000', { browser: true });
    const preview = await harness.registerTarget('http://127.0.0.1:3001');
    const renderRedirect = async (target) => {
      const req = {
        originalUrl: `${target.proxyBasePath}/start`,
        url: `${target.proxyBasePath}/start`,
        headers: {
          cookie: `oc_preview_token=${target.token}`,
          'sec-fetch-dest': 'iframe',
        },
      };
      const proxyRes = {
        bodyBuffer: Buffer.from('redirect'),
        headers: {
          location: 'https://accounts.google.com/',
          'content-type': 'text/html',
        },
      };
      const res = createResponse();
      const body = String(await harness.proxyOptions().on.proxyRes(
        proxyRes,
        req,
        res,
      ));
      return { body, res };
    };

    const browserRedirect = await renderRedirect(browser);
    expect(browserRedirect.body).toContain('"navigation":"target"');
    expect(browserRedirect.res.statusCode).toBe(200);
    expect(browserRedirect.res.headers.has('location')).toBe(false);
    expect(browserRedirect.res.headers.get('content-type')).toBe('text/html; charset=utf-8');
    expect(browserRedirect.res.headers.get('cache-control')).toBe('no-store');

    const previewRedirect = await renderRedirect(preview);
    expect(previewRedirect.body).toContain('"navigation":"external"');
    expect(previewRedirect.res.headers.has('location')).toBe(false);
  });

  it('passes cross-origin subresource redirects through instead of handing them off', async () => {
    const harness = createAttachedPreviewRuntime();
    const browser = await harness.registerTarget('http://127.0.0.1:3000', { browser: true });
    const req = {
      originalUrl: `${browser.proxyBasePath}/api/session`,
      url: `${browser.proxyBasePath}/api/session`,
      headers: {
        cookie: `oc_preview_token=${browser.token}`,
        'sec-fetch-dest': 'empty',
        accept: 'application/json',
      },
    };
    const proxyRes = {
      statusCode: 302,
      bodyBuffer: Buffer.from(''),
      headers: {
        location: 'https://accounts.google.com/signin',
        'content-type': 'text/html',
      },
    };
    const res = createResponse();
    const body = String(await harness.proxyOptions().on.proxyRes(proxyRes, req, res));

    expect(body).not.toContain('navigate-preview');
    expect(res.statusCode).toBe(200);
    expect(res.headers.get('location')).toBe('https://accounts.google.com/signin');
    expect(proxyRes.headers.location).toBe('https://accounts.google.com/signin');
  });

  it('reuses a live target for the same owner and origin so proxy paths survive refresh', async () => {
    const harness = createAttachedPreviewRuntime();
    const first = await harness.registerTarget('http://127.0.0.1:3000', { browser: true });
    const second = await harness.registerTarget('http://127.0.0.1:3000', { browser: true });

    expect(second.proxyBasePath).toBe(first.proxyBasePath);
    expect(second.token).toBe(first.token);
    expect(second.expiresAt).toBeGreaterThanOrEqual(first.expiresAt);

    const otherOrigin = await harness.registerTarget('http://127.0.0.1:3001', { browser: true });
    expect(otherOrigin.proxyBasePath).not.toBe(first.proxyBasePath);

    // Preview and Browser registrations stay independent even for one origin.
    const previewTarget = await harness.registerTarget('http://127.0.0.1:3000');
    expect(previewTarget.proxyBasePath).not.toBe(first.proxyBasePath);
  });

  it('keeps URL virtualization enabled for loopback Browser and Preview documents', async () => {
    const harness = createAttachedPreviewRuntime();
    const loopbackBrowser = await harness.registerTarget('http://127.0.0.1:8080/', { browser: true });
    const preview = await harness.registerTarget('http://127.0.0.1:3000');
    const render = async (target) => String(await harness.proxyOptions().on.proxyRes(
      {
        bodyBuffer: Buffer.from('<html><head></head><body>Hi</body></html>'),
        headers: { 'content-type': 'text/html' },
      },
      {
        originalUrl: `${target.proxyBasePath}/`,
        url: `${target.proxyBasePath}/`,
        headers: { cookie: `oc_preview_token=${target.token}` },
      },
      createResponse(),
    ));

    const loopbackBrowserHtml = await render(loopbackBrowser);
    const previewHtml = await render(preview);
    expect(loopbackBrowserHtml).toContain('id="openchamber-preview-bridge-location"');
    expect(loopbackBrowserHtml).not.toContain('id="openchamber-preview-bridge-location" type="module"');
    expect(loopbackBrowserHtml).toContain("window.history.replaceState(window.history.state,'',targetPath+current.search+current.hash)");
    expect(loopbackBrowserHtml.indexOf('id="openchamber-preview-bridge-location"'))
      .toBeLessThan(loopbackBrowserHtml.indexOf('window.__openchamberPreviewConfig='));
    expect(previewHtml).toContain('id="openchamber-preview-bridge-location"');
    expect(previewHtml).not.toContain('id="openchamber-preview-bridge-location" type="module"');
  });

  it('enforces the same session binding for HMR WebSocket upgrades', async () => {
    const harness = createAttachedPreviewRuntime();
    const ownerCookie = 'oc_app_session=owner-session';
    const target = await harness.registerTarget('http://127.0.0.1:4173', {
      headers: { cookie: ownerCookie },
      principal: { id: 'user-1', appSessionId: 'app-1' },
    });
    const createSocket = () => ({ once() {}, destroy() {} });

    const otherSocket = createSocket();
    harness.upgrade({
      url: `${target.proxyBasePath}/hmr?channel=one`,
      headers: {
        cookie: `oc_app_session=other-session; oc_preview_token=${target.token}`,
      },
    }, otherSocket, Buffer.alloc(0));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(harness.rejectedUpgrades).toContainEqual({
      socket: otherSocket,
      status: 403,
      message: 'Preview target belongs to another session',
    });
    expect(harness.upgradeCalls).toHaveLength(0);

    const ownerSocket = createSocket();
    const ownerRequest = {
      url: `${target.proxyBasePath}/hmr?channel=one&ocPreview=legacy`,
      headers: {
        cookie: `${ownerCookie}; oc_preview_token=${target.token}`,
      },
    };
    harness.upgrade(ownerRequest, ownerSocket, Buffer.alloc(0));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(harness.upgradeCalls).toHaveLength(1);
    expect(ownerRequest.url).toBe('/hmr?channel=one');
  });

  it('requires a live project grant for tunnel target creation', async () => {
    const calls = [];
    const denied = createAttachedPreviewRuntime({
      classifyRequestScope: () => 'tunnel',
      previewInstancesRuntime: {
        async authorizeTarget(request) {
          calls.push(request);
          return {
            ok: false,
            status: 403,
            code: 'project_preview_not_approved',
            error: 'This project preview port has not been approved',
          };
        },
      },
    });
    const deniedTarget = await denied.registerTarget('http://localhost:4173', {
      directory: '/project',
      headers: { cookie: 'oc_app_session=owner-session' },
      principal: { id: 'user-1', appSessionId: 'app-1' },
    });
    expect(deniedTarget.id).toBeUndefined();
    expect(deniedTarget.code).toBe('project_preview_not_approved');
    expect(calls).toHaveLength(1);
    expect(denied.runtime.getSnapshot()).toEqual([]);

    const allowed = createAttachedPreviewRuntime({
      classifyRequestScope: () => 'unknown-public',
      previewInstancesRuntime: {
        async authorizeTarget() {
          return { ok: true, grantId: 'grant-1', projectKey: 'project:one' };
        },
      },
    });
    const allowedTarget = await allowed.registerTarget('http://localhost:4173', {
      directory: '/project',
      headers: { cookie: 'oc_app_session=owner-session' },
      principal: { id: 'user-1', appSessionId: 'app-1' },
    });
    expect(allowedTarget.id).toBeTruthy();
    expect(allowed.runtime.getSnapshot()[0]).toMatchObject({
      grantId: 'grant-1',
      projectKey: 'project:one',
    });
  });

  it('strips application credentials from HMR websocket upgrades', () => {
    const { proxyOptions } = createAttachedPreviewRuntime();
    const removed = [];
    proxyOptions().on.proxyReqWs({
      removeHeader(name) { removed.push(name); },
      setHeader() {},
    }, { headers: {} });
    expect(removed).toEqual(['cookie', 'authorization', 'x-openchamber-ui-session']);
  });

  it('rewrites upstream Origin and Referer without leaking the proxy target path', async () => {
    const { proxyOptions, registerTarget } = createAttachedPreviewRuntime();
    const target = await registerTarget('http://127.0.0.1:4173');
    const headers = new Map();
    proxyOptions().on.proxyReq({
      setHeader(name, value) { headers.set(name, value); },
      removeHeader(name) { headers.delete(name); },
    }, {
      originalUrl: `${target.proxyBasePath}/api/save`,
      headers: {
        cookie: `oc_preview_token=${target.token}`,
        origin: 'https://devryan.example.com',
        referer: `https://devryan.example.com${target.proxyBasePath}/editor?ocPreview=4`,
      },
    });
    expect(headers.get('origin')).toBe('http://127.0.0.1:4173');
    expect(headers.get('referer')).toBe('http://127.0.0.1:4173/editor');
  });

  it('removes session targets immediately when authentication is revoked', async () => {
    let revoke = null;
    const { registerTarget, runtime } = createAttachedPreviewRuntime({
      uiAuthController: {
        enabled: false,
        registerConnection(_principal, close) {
          revoke = close;
          return () => { revoke = null; };
        },
      },
    });
    await registerTarget('http://localhost:4173', {
      headers: { cookie: 'oc_app_session=owner-session' },
      principal: { id: 'user-1', appSessionId: 'app-1' },
    });
    expect(runtime.getSnapshot()).toHaveLength(1);
    revoke();
    expect(runtime.getSnapshot()).toEqual([]);
  });

  it('expires target ids and rejects their path-scoped cookies', async () => {
    let clock = 1_000;
    const { registerTarget, runtime, useRoutes } = createAttachedPreviewRuntime({ now: () => clock });
    const target = await registerTarget('http://localhost:4173');
    expect(runtime.getSnapshot()).toHaveLength(1);
    clock += 31 * 60 * 1000;
    const guard = useRoutes.find((entry) => entry.path === '/api/preview/proxy').handlers[0];
    const response = createResponse();
    guard({
      originalUrl: `${target.proxyBasePath}/`,
      headers: { cookie: `oc_preview_token=${target.token}` },
    }, response, () => {});
    expect(response.statusCode).toBe(404);
    expect(response.body).toEqual({
      error: 'Preview target expired',
      code: 'preview_target_expired',
    });
    expect(runtime.getSnapshot()).toEqual([]);
  });

  it('caps caller-requested target lifetimes at the bounded server maximum', async () => {
    const clock = 10_000;
    const { registerTarget } = createAttachedPreviewRuntime({ now: () => clock });
    const target = await registerTarget('http://localhost:4173', { ttlMs: 24 * 60 * 60 * 1000 });
    expect(target.expiresAt).toBe(clock + 30 * 60 * 1000);
  });
});
