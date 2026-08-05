import { describe, expect, it } from 'vitest';

import {
  applyPreviewPassthroughRequestHeaders,
  applyPreviewPassthroughResponseHeaders,
  buildPreviewUpstreamCookieHeader,
  classifyPreviewNavigation,
  classifyPreviewRequestScope,
  classifyPreviewResourceError,
  createPreviewBridgeScript,
  createPreviewProxyRuntime,
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
  now,
} = {}) => {
  let proxyOptions;
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
      const middleware = () => {};
      middleware.upgrade = (req, socket, head) => upgradeCalls.push({ req, socket, head });
      return middleware;
    },
    responseInterceptor: (handler) => handler,
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
  });

  const registerTarget = async (url, { headers = {}, principal, directory, ttlMs } = {}) => {
    const handlers = postRoutes.get('/api/preview/targets');
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
    return { id: res.body.id, proxyBasePath: res.body.proxyBasePath, expiresAt: res.body.expiresAt, token };
  };

  return {
    proxyOptions: () => proxyOptions,
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
    const input = '<img src="/logo.png"><a href="/docs">Docs</a><script>const url = "/api/data";</script>';
    const output = rewrite(input, 'html');

    expect(output).toContain('src="/api/preview/proxy/abc123/logo.png"');
    expect(output).toContain('href="/api/preview/proxy/abc123/docs"');
    expect(output).toContain('const url = "/api/data";');
  });

  it('rewrites only CSS imports and url references in CSS responses', () => {
    const input = '@import "/theme.css"; .hero { background: url(/hero.png); } .copy::after { content: "/not-a-url"; }';
    const output = rewrite(input, 'css');

    expect(output).toContain('@import "/api/preview/proxy/abc123/theme.css"');
    expect(output).toContain('url(/api/preview/proxy/abc123/hero.png)');
    expect(output).toContain('content: "/not-a-url"');
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

  it('rejects redirects that pivot to another origin or port', () => {
    expect(rewritePreviewRedirectLocation({
      location: 'http://127.0.0.1:4000/admin',
      targetOrigin: 'http://127.0.0.1:3000',
      proxyBasePath: '/api/preview/proxy/abc123',
    })).toMatchObject({ ok: false });
    expect(rewritePreviewRedirectLocation({
      location: 'https://example.com',
      targetOrigin: 'http://127.0.0.1:3000',
      proxyBasePath: '/api/preview/proxy/abc123',
    })).toMatchObject({ ok: false });
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
  });

  it('escapes markup in injected configuration', () => {
    const script = createPreviewBridgeScript({
      proxyBasePath: '/api/preview/proxy/abc123',
      targetOrigin: 'http://127.0.0.1:3000/<script>',
    });

    expect(script).not.toContain('3000/<script>');
    expect(script).toContain('3000/\\u003cscript>');
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

describe('proxy target normalization (SSRF guard)', () => {
  it('allows ordinary external hosts when allowExternal is set', () => {
    expect(normalizeProxyTargetUrl('https://example.com/docs/', { allowExternal: true }))
      .toEqual({ ok: true, origin: 'https://example.com' });
  });

  it('rejects non-loopback hosts without allowExternal', () => {
    expect(normalizeProxyTargetUrl('https://example.com/', {}).ok).toBe(false);
    expect(normalizeProxyTargetUrl('https://example.com/').ok).toBe(false);
  });

  it('accepts and normalizes loopback hosts on the default path', () => {
    expect(normalizeProxyTargetUrl('http://localhost:3000/'))
      .toEqual({ ok: true, origin: 'http://127.0.0.1:3000' });
    expect(normalizeProxyTargetUrl('http://[::1]:3000/'))
      .toEqual({ ok: true, origin: 'http://127.0.0.1:3000' });
  });

  it('refuses private, loopback and link-local literals on the external path', () => {
    for (const url of [
      'http://127.0.0.1/',
      'http://10.0.0.5/',
      'http://172.16.9.9/',
      'http://192.168.1.1/',
      'http://169.254.169.254/latest/meta-data/',
      'http://100.64.0.1/',
      'http://localhost/',
      'http://service.local/',
      'http://[::1]/',
      'http://[fd00::1]/',
      'http://[fe80::1]/',
      'http://2130706433/', // decimal form of 127.0.0.1, normalized by WHATWG URL
    ]) {
      expect(normalizeProxyTargetUrl(url, { allowExternal: true }).ok, url).toBe(false);
    }
  });

  it('still blocks private hosts even via IPv4-mapped IPv6', () => {
    expect(normalizeProxyTargetUrl('http://[::ffff:127.0.0.1]/', { allowExternal: true }).ok).toBe(false);
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
      headers: {
        'content-type': 'text/html',
        'content-security-policy': ["script-src 'self'; frame-ancestors 'none'", "img-src 'self'"],
        'content-security-policy-report-only': "script-src 'none'",
        'x-frame-options': 'DENY',
      },
    };
    const res = createResponse();

    const body = await proxyOptions().on.proxyRes(
      Buffer.from('<html><head></head><body>Hi</body></html>'),
      proxyRes,
      req,
      res,
    );

    expect(proxyRes.headers['x-frame-options']).toBeUndefined();

    const cspValues = proxyRes.headers['content-security-policy'];
    expect(Array.isArray(cspValues)).toBe(true);
    const nonce = cspValues[0].match(/'nonce-([^']+)'/)?.[1];
    expect(nonce).toBeTruthy();
    expect(cspValues[0]).not.toContain('frame-ancestors');
    expect(cspValues[1]).toBe("img-src 'self'");
    expect(proxyRes.headers['content-security-policy-report-only']).toBe(`script-src 'nonce-${nonce}'`);
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
    const proxyRes = { headers: { 'content-type': 'text/html' } };
    const res = createResponse();

    const body = await proxyOptions().on.proxyRes(
      Buffer.from('<html><head></head><body>Hi</body></html>'),
      proxyRes,
      req,
      res,
    );

    expect(proxyRes.headers['content-security-policy']).toBeUndefined();
    expect(body).toMatch(/<script id="openchamber-preview-bridge" nonce="[^"]+">/);
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
          return { ok: false, status: 403, error: 'This project preview port has not been approved' };
        },
      },
    });
    const deniedTarget = await denied.registerTarget('http://localhost:4173', {
      directory: '/project',
      headers: { cookie: 'oc_app_session=owner-session' },
      principal: { id: 'user-1', appSessionId: 'app-1' },
    });
    expect(deniedTarget.id).toBeUndefined();
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
    expect(runtime.getSnapshot()).toEqual([]);
  });

  it('caps caller-requested target lifetimes at the bounded server maximum', async () => {
    const clock = 10_000;
    const { registerTarget } = createAttachedPreviewRuntime({ now: () => clock });
    const target = await registerTarget('http://localhost:4173', { ttlMs: 24 * 60 * 60 * 1000 });
    expect(target.expiresAt).toBe(clock + 30 * 60 * 1000);
  });
});
