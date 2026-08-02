import { describe, expect, it } from 'vitest';

import {
  applyPreviewPassthroughRequestHeaders,
  applyPreviewPassthroughResponseHeaders,
  classifyPreviewNavigation,
  classifyPreviewResourceError,
  createPreviewBridgeScript,
  createPreviewProxyRuntime,
  normalizeProxyTargetUrl,
  rewritePreviewBody,
  rewritePreviewCspHeader,
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

const createAttachedPreviewRuntime = () => {
  let proxyOptions;
  const postRoutes = new Map();
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
      middleware.upgrade = () => {};
      return middleware;
    },
    responseInterceptor: (handler) => handler,
  });
  const app = {
    post(path, ...handlers) {
      postRoutes.set(path, handlers);
    },
    use() {},
  };
  runtime.attach(app, {
    server: { on() {} },
    express: { json: () => (_req, _res, next) => next() },
    uiAuthController: null,
    isRequestOriginAllowed: async () => true,
    rejectWebSocketUpgrade() {},
  });

  const registerTarget = async (url) => {
    const handlers = postRoutes.get('/api/preview/targets');
    const handler = handlers[handlers.length - 1];
    const res = createResponse();
    await handler({ body: { url }, secure: false, headers: {} }, res);
    const cookie = String(res.headers.get('set-cookie') || '');
    const token = cookie.match(/oc_preview_token=([^;]+)/)?.[1] || '';
    return { id: res.body.id, proxyBasePath: res.body.proxyBasePath, token };
  };

  return { proxyOptions: () => proxyOptions, registerTarget };
};

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
});
