import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  OPENCODE_ALWAYS_KNOWN_ROUTES,
  OPENCODE_COMPANION_ROUTES,
  OPENCODE_ROUTE_GUARD_ENV,
  OPENCODE_ROUTE_UNKNOWN_CODE,
  OPENCODE_STATIC_ROUTES,
  assertKnownOpenCodeRoute,
  createOpenCodeRouteRegistry,
  createOpenCodeRouteTable,
  isKnownOpenCodeRoute,
  isOpenCodeRouteGuardEnabled,
  normalizeOpenCodePathname,
  openCodeFetch,
  parseOpenApiRoutes,
} from './opencode-routes.js';
import { OPENCODE_SDK_ROUTES, OPENCODE_SDK_VERSION } from './opencode-routes.generated.js';
import {
  OPENCODE_ROUTES_GENERATED_FILENAME,
  extractOpenCodeSdkRoutes,
  findInstalledOpenCodeSdk,
  readOpenCodeSdkRoutes,
  renderOpenCodeRoutesModule,
} from './opencode-routes-sdk.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SERVER_ROOT = path.resolve(HERE, '..', '..');
const COMPANION_PATCH = path.join(HERE, 'companion', 'legacy-conversation-revert.patch');

const silentLogger = () => ({ warn: vi.fn() });

// Trimmed from the shape OpenCode's `GET /doc` serves (OpenAPI 3.1).
const createFixtureDoc = (extraPaths = {}) => ({
  openapi: '3.1.0',
  info: { title: 'opencode', version: '1.0.0' },
  paths: {
    '/global/health': { get: { operationId: 'global.health', responses: {} } },
    '/session/{sessionID}': {
      parameters: [{ name: 'sessionID', in: 'path', required: true }],
      get: { operationId: 'session.get' },
      patch: { operationId: 'session.update' },
      delete: { operationId: 'session.delete' },
    },
    '/session/revert-capabilities': { get: { operationId: 'session.revertCapabilities' } },
    '/api/fs/read/*': { get: { operationId: 'v2.fs.read' } },
    '/pty/{ptyID}/connect': { get: { operationId: 'pty.connect' } },
    ...extraPaths,
  },
  components: { schemas: {} },
});

const jsonResponse = (body, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: { 'content-type': 'application/json' },
});

afterEach(() => {
  delete process.env[OPENCODE_ROUTE_GUARD_ENV];
});

describe('normalizeOpenCodePathname', () => {
  it('strips query/fragment, collapses duplicate slashes and drops the trailing slash', () => {
    expect(normalizeOpenCodePathname('/session/ses_1/message?directory=%2Ftmp&limit=5#x')).toBe('/session/ses_1/message');
    expect(normalizeOpenCodePathname('//session///ses_1//message/')).toBe('/session/ses_1/message');
    expect(normalizeOpenCodePathname('/')).toBe('/');
    expect(normalizeOpenCodePathname('http://127.0.0.1:4096/global/health?x=1')).toBe('/global/health');
    expect(normalizeOpenCodePathname('http://127.0.0.1:4096')).toBe('/');
  });

  it('rejects traversal, backslashes, control characters and relative targets', () => {
    for (const target of [
      '/session/../doc',
      '/session/./status',
      '/session/%2e%2e/doc',
      '/session/.%2E/doc',
      '/session/%2e/status',
      '/session\\..\\doc',
      '/session/\u0000',
      'session/status',
      '',
      null,
      42,
    ]) {
      expect(normalizeOpenCodePathname(target)).toBeNull();
    }
    // Dots inside a segment are not traversal.
    expect(normalizeOpenCodePathname('/file/content.v2')).toBe('/file/content.v2');
  });
});

describe('createOpenCodeRouteTable', () => {
  const table = createOpenCodeRouteTable([
    ['GET', '/session/{sessionID}/message'],
    ['POST', '/session/{sessionID}/message'],
    ['GET', '/session/status'],
    ['GET', '/api/fs/read/*'],
    { method: 'post', path: '/mcp/{name}/connect' },
    ['BOGUS', '/ignored'],
    ['GET', 'relative'],
  ]);

  it('matches path parameters, one segment each, method-aware', () => {
    expect(table.size).toBe(5);
    expect(table.has('GET', '/session/ses_1/message')).toBe(true);
    expect(table.has('post', '/session/ses_1/message?directory=%2Fx')).toBe(true);
    expect(table.has('DELETE', '/session/ses_1/message')).toBe(false);
    expect(table.has('GET', '/session/a/b/message')).toBe(false);
    expect(table.has('GET', '/session/message')).toBe(false);
    expect(table.has('POST', '/mcp/my%20server/connect')).toBe(true);
    expect(table.has('GET', '/ignored')).toBe(false);
  });

  it('matches like OpenCode: case-insensitive, trailing wildcard, duplicate slashes', () => {
    expect(table.has('GET', '/Session/Status')).toBe(true);
    expect(table.has('GET', '/api/fs/read/src/index.ts')).toBe(true);
    expect(table.has('GET', '/api/fs/read')).toBe(true);
    expect(table.has('GET', '//session//ses_1//message/')).toBe(true);
    expect(table.has('GET', '/api/fs/read/../../doc')).toBe(false);
  });

  it('does not map HEAD to GET but answers OPTIONS for any known path', () => {
    expect(table.has('HEAD', '/session/status')).toBe(false);
    expect(table.has('OPTIONS', '/session/status')).toBe(true);
    expect(table.has('OPTIONS', '/nope')).toBe(false);
  });
});

describe('static route table', () => {
  it('matches the installed SDK v2 generated client (rerun scripts/generate-opencode-routes.mjs after an SDK bump)', () => {
    const sdk = findInstalledOpenCodeSdk(HERE);
    const expected = renderOpenCodeRoutesModule(readOpenCodeSdkRoutes(sdk));
    const actual = fs.readFileSync(path.join(HERE, OPENCODE_ROUTES_GENERATED_FILENAME), 'utf8');
    expect(actual).toBe(expected);
    expect(OPENCODE_SDK_VERSION).toBe(sdk.version);
  });

  it('fails loudly when the SDK generated-client shape changes', () => {
    expect(() => extractOpenCodeSdkRoutes('client.get({ url: "/a" }); client.request({ url: "/b" });')).toThrow(/shape changed/);
    expect(() => extractOpenCodeSdkRoutes('')).toThrow(TypeError);
    expect(extractOpenCodeSdkRoutes('(o ?? this.client).post({\n url: "/b" }); this.client.sse.get({ url: "/a" });'))
      .toEqual([['GET', '/a'], ['POST', '/b']]);
  });

  it('includes the SDK health, SSE and PTY WebSocket routes and never the legacy /health', () => {
    expect(isKnownOpenCodeRoute('GET', '/global/health')).toBe(true);
    expect(isKnownOpenCodeRoute('GET', '/health')).toBe(false);
    expect(isKnownOpenCodeRoute('GET', '/model')).toBe(false);
    expect(isKnownOpenCodeRoute('GET', '/event?directory=%2Ftmp')).toBe(true);
    expect(isKnownOpenCodeRoute('GET', '/global/event')).toBe(true);
    expect(isKnownOpenCodeRoute('GET', '/pty/pty_1/connect?ticket=abc')).toBe(true);
    expect(isKnownOpenCodeRoute('GET', '/api/pty/pty_1/connect')).toBe(true);
    expect(isKnownOpenCodeRoute('GET', '/doc')).toBe(true);
    for (const [method, routePath] of OPENCODE_SDK_ROUTES) {
      expect(isKnownOpenCodeRoute(method, routePath.replace(/\{[^}]+\}/g, 'x1').replace(/\*$/, 'a/b'))).toBe(true);
    }
  });

  it('lists exactly the routes the companion patch adds on top of the SDK', () => {
    const patch = fs.readFileSync(COMPANION_PATCH, 'utf8');
    const addedEndpointLines = patch.match(/^\+.*HttpApiEndpoint\./gm) ?? [];
    const added = [...patch.matchAll(/^\+\s+HttpApiEndpoint\.(get|post|put|patch|delete)\("[^"]+", SessionPaths\.(\w+)/gm)]
      .map(([, method, key]) => {
        const template = new RegExp(`^\\+\\s+${key}: \`\\$\\{root\\}([^\`]*)\``, 'm').exec(patch)?.[1];
        return [method.toUpperCase(), `/session${template.replace(/:(\w+)/g, '{$1}')}`];
      });
    // A companion endpoint outside the session group needs a table entry too.
    expect(added).toHaveLength(addedEndpointLines.length);
    expect(added.sort()).toEqual([...OPENCODE_COMPANION_ROUTES].sort());
    for (const [method, routePath] of OPENCODE_COMPANION_ROUTES) {
      expect(OPENCODE_SDK_ROUTES.some(([m, p]) => m === method && p === routePath)).toBe(false);
      expect(isKnownOpenCodeRoute(method, routePath.replace('{sessionID}', 'ses_1'))).toBe(true);
    }
  });
});

describe('parseOpenApiRoutes', () => {
  it('extracts method/path pairs from an OpenAPI document and ignores non-operation keys', () => {
    const routes = parseOpenApiRoutes(createFixtureDoc());
    expect(routes).toEqual(expect.arrayContaining([
      ['GET', '/global/health'],
      ['GET', '/session/{sessionID}'],
      ['PATCH', '/session/{sessionID}'],
      ['DELETE', '/session/{sessionID}'],
      ['GET', '/api/fs/read/*'],
    ]));
    expect(routes.some(([method]) => method === 'PARAMETERS')).toBe(false);
    expect(routes).toHaveLength(7);
  });

  it('returns null for documents without operations', () => {
    expect(parseOpenApiRoutes(null)).toBeNull();
    expect(parseOpenApiRoutes('<!doctype html>')).toBeNull();
    expect(parseOpenApiRoutes({ paths: [] })).toBeNull();
    expect(parseOpenApiRoutes({ paths: { '/x': { summary: 'no operations' } } })).toBeNull();
  });
});

describe('OpenCode route registry', () => {
  it('uses the static table until the live /doc table loads, then the live table is authoritative', async () => {
    let releaseDoc;
    const docGate = new Promise((resolve) => { releaseDoc = resolve; });
    const fetchImpl = vi.fn(async () => {
      await docGate;
      return jsonResponse(createFixtureDoc({ '/only/live': { post: {} } }));
    });
    const registry = createOpenCodeRouteRegistry({ fetchImpl, logger: silentLogger() });
    registry.configure({ buildDocUrl: () => 'http://127.0.0.1:1/doc', getAuthHeaders: () => ({ Authorization: 'Bearer t' }) });

    registry.observeRuntime({ ready: true, key: 'http://127.0.0.1:1|1.18.31' });
    // Never blocks: the static table answers while /doc is in flight.
    expect(registry.getSource()).toBe('static');
    expect(registry.isKnown('GET', '/agent')).toBe(true);
    expect(registry.isKnown('POST', '/only/live')).toBe(false);

    releaseDoc();
    await expect(registry.refresh()).resolves.toBe(true);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(fetchImpl.mock.calls[0][0]).toBe('http://127.0.0.1:1/doc');
    expect(fetchImpl.mock.calls[0][1].headers).toEqual(expect.objectContaining({ Authorization: 'Bearer t' }));
    expect(registry.getSource()).toBe('live');
    expect(registry.isKnown('POST', '/only/live')).toBe(true);
    expect(registry.isKnown('GET', '/agent')).toBe(false);
    // Always-known transports survive a live spec that omits them.
    expect(registry.isKnown('GET', '/event')).toBe(true);
    expect(registry.isKnown('GET', '/global/event')).toBe(true);
    expect(registry.isKnown('GET', '/doc')).toBe(true);

    // Same runtime: no further /doc requests.
    registry.observeRuntime({ ready: true, key: 'http://127.0.0.1:1|1.18.31' });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('reloads after a restart: new runtime identity or an observed not-ready period', async () => {
    const docs = [
      createFixtureDoc({ '/first': { get: {} } }),
      createFixtureDoc({ '/second': { get: {} } }),
      createFixtureDoc({ '/third': { get: {} } }),
    ];
    const fetchImpl = vi.fn(async () => jsonResponse(docs.shift()));
    const registry = createOpenCodeRouteRegistry({ fetchImpl, logger: silentLogger() });
    registry.configure({ buildDocUrl: () => 'http://oc/doc' });

    registry.observeRuntime({ ready: true, key: 'a|1' });
    await registry.refresh();
    expect(registry.isKnown('GET', '/first')).toBe(true);

    // Upgrade/port change: the old live table is dropped immediately.
    registry.observeRuntime({ ready: true, key: 'a|2' });
    expect(registry.isKnown('GET', '/first')).toBe(false);
    expect(registry.isKnown('GET', '/agent')).toBe(true);
    await registry.refresh();
    expect(registry.isKnown('GET', '/second')).toBe(true);

    // Same identity restarted in place.
    registry.observeRuntime({ ready: false, key: null });
    registry.observeRuntime({ ready: true, key: 'a|2' });
    await registry.refresh();
    expect(registry.isKnown('GET', '/third')).toBe(true);
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it('keeps the static table on /doc failures and retries only after the retry delay', async () => {
    let now = 1_000;
    const logger = silentLogger();
    const fetchImpl = vi.fn(async () => new Response('<!doctype html>', { status: 200, headers: { 'content-type': 'text/html' } }));
    const registry = createOpenCodeRouteRegistry({ fetchImpl, logger, now: () => now, retryDelayMs: 30_000 });
    registry.configure({ buildDocUrl: () => 'http://oc/doc' });

    registry.observeRuntime({ ready: true, key: 'k' });
    await registry.refresh();
    expect(registry.getSource()).toBe('static');
    const attempts = fetchImpl.mock.calls.length;

    registry.observeRuntime({ ready: true, key: 'k' });
    expect(fetchImpl).toHaveBeenCalledTimes(attempts);
    now += 30_001;
    registry.observeRuntime({ ready: true, key: 'k' });
    expect(fetchImpl).toHaveBeenCalledTimes(attempts + 1);
    await registry.refresh();
    // One warning per runtime identity, however many retries fail.
    expect(logger.warn).toHaveBeenCalledTimes(1);

    fetchImpl.mockImplementation(async () => jsonResponse({ paths: { '/not-opencode': { get: {} } } }));
    registry.observeRuntime({ ready: true, key: 'other' });
    await registry.refresh();
    expect(registry.getSource()).toBe('static');
    expect(registry.isKnown('GET', '/not-opencode')).toBe(false);
    expect(logger.warn).toHaveBeenLastCalledWith(expect.stringContaining('does not describe an OpenCode server'));
  });

  it('does not load /doc while the runtime is not ready', () => {
    const fetchImpl = vi.fn();
    const registry = createOpenCodeRouteRegistry({ fetchImpl, logger: silentLogger() });
    registry.configure({ buildDocUrl: () => 'http://oc/doc' });
    registry.observeRuntime({ ready: false, key: null });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('reports each rejected route once, without the query string, and bounded', () => {
    const logger = silentLogger();
    const recordDiagnostic = vi.fn();
    const registry = createOpenCodeRouteRegistry({ logger, recordDiagnostic });

    registry.reportUnknown('get', '/health?directory=%2FUsers%2Fsecret&token=abc', 'proxy');
    registry.reportUnknown('GET', '/health?other=1', 'proxy');
    registry.reportUnknown('GET', `/${'x'.repeat(500)}`, 'server');

    expect(logger.warn).toHaveBeenCalledTimes(2);
    expect(logger.warn.mock.calls[0][0]).toBe('[opencode-routes] rejected unknown OpenCode route GET /health (source=proxy, table=static)');
    expect(logger.warn.mock.calls.flat().join('\n')).not.toMatch(/secret|token/);
    expect(recordDiagnostic).toHaveBeenCalledWith({
      type: 'log',
      event: 'opencode_route_unknown',
      payload: { method: 'GET', path: '/health', source: 'proxy', table: 'static' },
    });
    expect(recordDiagnostic.mock.calls[1][0].payload.path.length).toBeLessThanOrEqual(161);
  });
});

describe('openCodeFetch and the kill switch', () => {
  it('rejects unknown routes before any network I/O', async () => {
    const fetchImpl = vi.fn();
    const registry = createOpenCodeRouteRegistry({ logger: silentLogger() });
    await expect(openCodeFetch('http://127.0.0.1:4096/model', { method: 'GET' }, { fetchImpl, registry }))
      .rejects.toMatchObject({ code: OPENCODE_ROUTE_UNKNOWN_CODE, statusCode: 404 });
    await expect(openCodeFetch('http://127.0.0.1:4096/session/../doc', {}, { fetchImpl, registry }))
      .rejects.toMatchObject({ code: OPENCODE_ROUTE_UNKNOWN_CODE });
    await expect(openCodeFetch(new URL('http://127.0.0.1:4096/global/health'), { method: 'DELETE' }, { fetchImpl, registry }))
      .rejects.toMatchObject({ code: OPENCODE_ROUTE_UNKNOWN_CODE });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('forwards known routes unchanged', async () => {
    const response = new Response('[]');
    const fetchImpl = vi.fn(async () => response);
    const registry = createOpenCodeRouteRegistry({ logger: silentLogger() });
    const init = { method: 'GET', headers: { Accept: 'application/json' } };
    const url = 'http://127.0.0.1:4096/session/ses_1/message?directory=%2Ftmp%2Fproject&limit=10';
    await expect(openCodeFetch(url, init, { fetchImpl, registry })).resolves.toBe(response);
    expect(fetchImpl).toHaveBeenCalledWith(url, init);
  });

  it('is disabled only by DEVRYAN_OPENCODE_ROUTE_GUARD=0', async () => {
    expect(isOpenCodeRouteGuardEnabled({})).toBe(true);
    expect(isOpenCodeRouteGuardEnabled({ [OPENCODE_ROUTE_GUARD_ENV]: 'false' })).toBe(true);
    expect(isOpenCodeRouteGuardEnabled({ [OPENCODE_ROUTE_GUARD_ENV]: '0' })).toBe(false);

    const fetchImpl = vi.fn(async () => new Response('ok'));
    const registry = createOpenCodeRouteRegistry({ logger: silentLogger() });
    process.env[OPENCODE_ROUTE_GUARD_ENV] = '0';
    await openCodeFetch('http://127.0.0.1:4096/model', {}, { fetchImpl, registry });
    expect(() => assertKnownOpenCodeRoute('GET', '/model', { registry })).not.toThrow();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});

// Supplementary guard for server-side call sites that fetch OpenCode directly:
// every literal path handed to buildOpenCodeUrl must be a real OpenCode route.
const EXPRESSION = '\u0000';

const skipQuoted = (source, index) => {
  const quote = source[index];
  let cursor = index + 1;
  while (cursor < source.length && source[cursor] !== quote) {
    cursor += source[cursor] === '\\' ? 2 : 1;
  }
  return cursor + 1;
};

// Reads a template literal starting at `index` (a backtick); expressions,
// including nested template literals, collapse to one EXPRESSION marker.
const readTemplateLiteral = (source, index) => {
  let text = '';
  let cursor = index + 1;
  while (cursor < source.length && source[cursor] !== '`') {
    if (source[cursor] === '\\') {
      text += source.slice(cursor, cursor + 2);
      cursor += 2;
    } else if (source[cursor] === '$' && source[cursor + 1] === '{') {
      let depth = 1;
      cursor += 2;
      while (cursor < source.length && depth > 0) {
        const char = source[cursor];
        if (char === '`') cursor = readTemplateLiteral(source, cursor).end;
        else if (char === '"' || char === "'") cursor = skipQuoted(source, cursor);
        else {
          if (char === '{') depth += 1;
          if (char === '}') depth -= 1;
          cursor += 1;
        }
      }
      text += EXPRESSION;
    } else {
      text += source[cursor];
      cursor += 1;
    }
  }
  return { text, end: cursor + 1 };
};

const readLiteralArgument = (source, index) => {
  const char = source[index];
  if (char === '\'' || char === '"') {
    const end = skipQuoted(source, index);
    return source.slice(index + 1, end - 1);
  }
  if (char === '`') return readTemplateLiteral(source, index).text;
  return null;
};

// Literal text becomes static segments; a whole-segment expression becomes a
// wildcard segment; an expression glued to the end of the final segment is a
// query suffix (`/config/providers${query}`).
const toCallSegments = (literal) => {
  const pathOnly = literal.split('?')[0].replace(/\/{2,}/g, '/');
  const segments = pathOnly.split('/').slice(1);
  if (segments.length > 0) {
    const last = segments.length - 1;
    if (segments[last].length > 1 && segments[last].endsWith(EXPRESSION)) segments[last] = segments[last].slice(0, -1);
    if (segments[last] === '' && last > 0) segments.pop();
  }
  return segments.map((segment) => (segment.includes(EXPRESSION) ? null : segment.toLowerCase()));
};

const KNOWN_TEMPLATES = [...OPENCODE_STATIC_ROUTES, ...OPENCODE_ALWAYS_KNOWN_ROUTES]
  .map(([, routePath]) => routePath.split('/').slice(1));

const templateMatches = (template, segments) => {
  const wildcard = template[template.length - 1] === '*';
  const fixed = wildcard ? template.slice(0, -1) : template;
  if (wildcard ? segments.length < fixed.length : segments.length !== fixed.length) return false;
  return fixed.every((part, index) => (
    /^\{[^}]+\}$/.test(part) || segments[index] === null || segments[index] === part.toLowerCase()
  ));
};

const isKnownLiteralPath = (literal) => {
  const segments = toCallSegments(literal);
  return KNOWN_TEMPLATES.some((template) => templateMatches(template, segments));
};

const collectLiteralBuildOpenCodeUrlPaths = (source) => {
  const found = [];
  for (const match of source.matchAll(/\bbuildOpenCodeUrl\s*\(\s*/g)) {
    const literal = readLiteralArgument(source, match.index + match[0].length);
    if (literal !== null) found.push(literal);
  }
  return found;
};

const listServerSourceFiles = (directory) => fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
  const fullPath = path.join(directory, entry.name);
  if (entry.isDirectory()) return entry.name === 'node_modules' ? [] : listServerSourceFiles(fullPath);
  return /\.(?:m?js)$/.test(entry.name) && !/\.(?:test|spec)\.m?js$/.test(entry.name) ? [fullPath] : [];
});

describe('server-side buildOpenCodeUrl call sites', () => {
  it('recognizes query suffixes, dynamic segments and unknown paths', () => {
    const paths = collectLiteralBuildOpenCodeUrlPaths([
      "buildOpenCodeUrl('/model')",
      'options.buildOpenCodeUrl("/health", \'\')',
      'buildOpenCodeUrl(`/config/providers${query}`, \'\')',
      'buildOpenCodeUrl(`/session/${encodeURIComponent(id)}/message${serialized ? `?${serialized}` : \'\'}`, \'\')',
      'buildOpenCodeUrl(`/session/${encodeURIComponent(step.sessionID)}/${action}?${q}`, \'\')',
      'buildOpenCodeUrl(pathname, \'\')',
    ].join('\n'));
    expect(paths.map(isKnownLiteralPath)).toEqual([false, false, true, true, true]);
  });

  it('only reference known OpenCode routes', () => {
    const unknown = [];
    let checked = 0;
    for (const file of listServerSourceFiles(SERVER_ROOT)) {
      for (const literal of collectLiteralBuildOpenCodeUrlPaths(fs.readFileSync(file, 'utf8'))) {
        // `buildOpenCodeUrl('/', '')` only derives the upstream base URL.
        if (literal === '/') continue;
        checked += 1;
        if (!isKnownLiteralPath(literal)) {
          unknown.push(`${path.relative(SERVER_ROOT, file)}: ${literal.replaceAll(EXPRESSION, '${…}')}`);
        }
      }
    }
    expect(unknown).toEqual([]);
    expect(checked).toBeGreaterThan(30);
  });
});
