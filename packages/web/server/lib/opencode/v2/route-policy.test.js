import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { OPENCODE_V2_OPENAPI_FILENAME, extractOpenCodeV2Operations } from './openapi-routes.js';
import { OPENCODE_V2_ROUTES, OPENCODE_V2_ROUTES_VERSION } from './routes.generated.js';
import {
  OPENCODE_V2_AUDIENCE,
  OPENCODE_V2_EXTRA_ROUTES,
  OPENCODE_V2_ROUTE_CLASS,
  OPENCODE_V2_ROUTE_CLASSES,
  bindOpenCodeV2Location,
  checkBrowserSessionPatchBody,
  classifyOpenCodeV2Body,
  diffLiveSpec,
  evaluateOpenCodeV2Request,
  getOpenCodeV2RouteClass,
  hasOpenCodeV2BodyRule,
  listOpenCodeV2KnownRoutes,
  matchOpenCodeV2Route,
  normalizeOpenCodeV2Path,
} from './route-policy.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const VENDORED_TEXT = fs.readFileSync(path.join(HERE, OPENCODE_V2_OPENAPI_FILENAME), 'utf8');
const vendoredDoc = () => JSON.parse(VENDORED_TEXT);

const { BROWSER, SERVER, PRIVILEGED, DENY } = OPENCODE_V2_ROUTE_CLASS;
const AUDIENCES = Object.values(OPENCODE_V2_AUDIENCE);
const RANK = { browser: 0, server: 1, privileged: 2 };

const keyOf = (route) => `${route.method} ${route.template}`;

// DESIGN.md C.3 written independently of the policy table: the first matching
// rule wins; anything unmatched is `server` ("every remaining read" plus the
// enumerated server writes), except the documented exceptions at the end.
const C3_RULES = [
  // browser
  [BROWSER, /^GET \/api\/info$/],
  // deny: terminals and shells
  [DENY, /^\w+ \/api\/pty(\/|$)/],
  [DENY, /^\w+ \/api\/experimental\/persistent-pty\//],
  [DENY, /^\w+ \/api\/experimental\/session\/\{sessionID\}\/terminal/],
  [DENY, /^\w+ \/api\/shell(\/|$)/],
  [DENY, /^GET \/api\/config\/shell$/],
  [DENY, /^POST \/api\/session\/\{sessionID\}\/shell$/],
  // deny: files, config and MCP
  [DENY, /^POST \/api\/experimental\/fs\/write$/],
  [DENY, /^\w+ \/api\/fs\//],
  [DENY, /^PATCH \/api\/experimental\/config$/],
  [DENY, /^(PUT|DELETE) \/api\/experimental\/mcp\/\{server\}$/],
  [DENY, /^POST \/api\/vcs\/init$/],
  // deny: integrations and workspace
  [DENY, /^\w+ \/api\/integration\/\{integrationID\}\/connect\/command/],
  [DENY, /^POST \/api\/experimental\/integration\/wellknown$/],
  [DENY, /^\w+ \/api\/worktree(\/|$)/],
  [DENY, /^PATCH \/api\/project\/\{projectID\}$/],
  // deny: session surface
  [DENY, /^POST \/api\/session\/\{sessionID\}\/move$/],
  [DENY, /^PUT \/api\/session\/\{sessionID\}\/environment$/],
  [DENY, /^POST \/api\/experimental\/session\/\{sessionID\}\/skill$/],
  [DENY, /^(PATCH|DELETE) \/api\/session\/\{sessionID\}\/inbox\/\{inboxID\}$/],
  [DENY, /^POST \/api\/session\/\{sessionID\}\/permission$/],
  [DENY, /^POST \/api\/session\/\{sessionID\}\/form$/],
  // deny: plugins and debug
  [DENY, /^POST \/api\/rpc\//],
  [DENY, /^POST \/api\/plugin\/(update|check)$/],
  [DENY, /^(GET|DELETE) \/api\/debug\/location$/],
  // deny: import, export and generation
  [DENY, /^POST \/api\/experimental\/session\/import$/],
  [DENY, /^GET \/api\/experimental\/session\/\{sessionID\}\/export$/],
  [DENY, /^POST \/api\/session\/\{sessionID\}\/generate$/],
  [DENY, /^POST \/api\/experimental\/generate$/],
  // deny: pairing and search
  [DENY, /^POST \/api\/pair$/],
  [DENY, /^GET \/auth\/connect\/\{code\}$/],
  [DENY, /^POST \/api\/websearch$/],
  // privileged
  [PRIVILEGED, /^POST \/api\/session\/\{sessionID\}\/synthetic$/],
  [PRIVILEGED, /^\w+ \/api\/session\/\{sessionID\}\/revert(\/|$)/],
  [PRIVILEGED, /^POST \/api\/session\/\{sessionID\}\/(agent|model)$/],
  [PRIVILEGED, /^(PUT|DELETE) \/api\/experimental\/session\/\{sessionID\}\/instructions\/entries\/\{key\}$/],
  [PRIVILEGED, /^POST \/api\/location\/reload$/],
  [PRIVILEGED, /^POST \/api\/session\/\{sessionID\}\/background$/],
  // G4 hardening: the credential list returns secret values.
  [PRIVILEGED, /^GET \/api\/credential$/],
  // Not enumerated as a server write in C.3 and unused by DevRyan.
  [DENY, /^DELETE \/api\/permission\/saved\/\{id\}$/],
];

const expectedClass = (key) => C3_RULES.find(([, pattern]) => pattern.test(key))?.[0] ?? SERVER;

const PARAM_VALUES = {
  sessionID: 'ses_test1',
  messageID: 'msg_test1',
  inboxID: 'msg_test2',
  formID: 'frm_test1',
  requestID: 'per_test1',
  ptyID: 'pty_test1',
  key: 'entry.key',
};

const concreteParam = (parameter) => {
  if (PARAM_VALUES[parameter.name]) return PARAM_VALUES[parameter.name];
  if (parameter.name === 'id' && parameter.pattern === '^sh_') return 'sh_test1';
  return `${parameter.name}-1`;
};

const concretePath = (route) => {
  let value = route.template;
  for (const parameter of route.pathParams) value = value.replace(`{${parameter.name}}`, concreteParam(parameter));
  return value.endsWith('/*') ? `${value.slice(0, -1)}dir/file.txt` : value;
};

// Minimal valid bodies for the body-dependent operations.
const BODY_FOR = {
  'POST /api/session': { title: 'T' },
  'PATCH /api/session/{sessionID}': { title: 'T' },
  'POST /api/session/{sessionID}/synthetic': { text: 'note' },
};

describe('route table coverage', () => {
  it('knows the 141 OpenAPI operations of 2.0.24 plus GET /openapi.json', () => {
    expect(OPENCODE_V2_ROUTES_VERSION).toBe('2.0.24');
    expect(OPENCODE_V2_ROUTES).toHaveLength(141);
    expect(OPENCODE_V2_EXTRA_ROUTES.map(keyOf)).toEqual(['GET /openapi.json']);
    const known = listOpenCodeV2KnownRoutes().map(keyOf);
    expect(known).toHaveLength(142);
    expect(new Set(known).size).toBe(142);
  });

  it('classifies every known route explicitly with a valid class and nothing else', () => {
    const known = new Set(listOpenCodeV2KnownRoutes().map(keyOf));
    const classified = Object.keys(OPENCODE_V2_ROUTE_CLASSES);
    expect(classified.filter((key) => !known.has(key))).toEqual([]);
    expect([...known].filter((key) => !Object.hasOwn(OPENCODE_V2_ROUTE_CLASSES, key))).toEqual([]);
    for (const value of Object.values(OPENCODE_V2_ROUTE_CLASSES)) {
      expect([BROWSER, SERVER, PRIVILEGED, DENY]).toContain(value);
    }
  });

  it('matches DESIGN.md C.3 for every route', () => {
    const mismatches = listOpenCodeV2KnownRoutes()
      .map((route) => [keyOf(route), getOpenCodeV2RouteClass(route.method, route.template), expectedClass(keyOf(route))])
      .filter(([, actual, expected]) => actual !== expected);
    expect(mismatches).toEqual([]);
  });

  it('exposes only GET /api/info to the browser initially', () => {
    const browser = Object.entries(OPENCODE_V2_ROUTE_CLASSES).filter(([, value]) => value === BROWSER).map(([key]) => key);
    expect(browser).toEqual(['GET /api/info']);
  });

  it.each(listOpenCodeV2KnownRoutes().map((route) => [keyOf(route), route]))(
    '%s: a concrete request matches its own template and is allowed exactly for its audiences',
    (key, route) => {
      const target = concretePath(route);
      const match = matchOpenCodeV2Route(route.method, target);
      expect(match.ok).toBe(true);
      expect(keyOf(match.route)).toBe(key);
      const routeClass = OPENCODE_V2_ROUTE_CLASSES[key];
      for (const audience of AUDIENCES) {
        const verdict = evaluateOpenCodeV2Request({ audience, method: route.method, path: target, body: BODY_FOR[key] });
        const expected = routeClass !== DENY && RANK[routeClass] <= RANK[audience];
        expect({ audience, allowed: verdict.allowed }).toEqual({ audience, allowed: expected });
        if (routeClass === DENY) expect(verdict.reason).toBe('route_denied');
      }
    },
  );
});

describe('unknown routes and methods are denied', () => {
  it.each([
    ['GET', '/api/nope'],
    ['GET', '/session'],
    ['GET', '/doc'],
    ['GET', '/global/health'],
    ['GET', '/API/INFO'],
    ['GET', '/api/Session/active'],
    ['HEAD', '/api/info'],
    ['OPTIONS', '/api/info'],
    ['TRACE', '/api/info'],
    ['POST', '/api/info'],
    ['GET', '/api/session/not-a-session'], // fails the ^ses pattern
    ['GET', '/api/session/ses_1/message/not-a-message'],
    ['GET', '/api/fs/read'], // the wildcard needs at least one segment
    ['GET', '/api/info/extra'],
    ['GET', '/devryan/ready'],
  ])('%s %s', (method, target) => {
    for (const audience of AUDIENCES) {
      const verdict = evaluateOpenCodeV2Request({ audience, method, path: target });
      expect(verdict).toMatchObject({ allowed: false, routeClass: DENY, reason: 'route_unknown', route: null });
    }
  });

  it('denies a missing or unknown audience', () => {
    expect(evaluateOpenCodeV2Request({ method: 'GET', path: '/api/info' })).toMatchObject({ allowed: false, reason: 'audience_invalid' });
    expect(evaluateOpenCodeV2Request({ audience: 'admin', method: 'GET', path: '/api/info' })).toMatchObject({ allowed: false });
    expect(evaluateOpenCodeV2Request()).toMatchObject({ allowed: false, routeClass: DENY });
  });

  it('treats an unclassified (method, template) as deny', () => {
    expect(getOpenCodeV2RouteClass('GET', '/api/unlisted')).toBe(DENY);
    expect(getOpenCodeV2RouteClass(undefined, '/api/info')).toBe(DENY);
    expect(getOpenCodeV2RouteClass('get', '/api/info')).toBe(BROWSER);
  });
});

describe('path normalization', () => {
  it.each([
    ['/api/info/', '/api/info'],
    ['//api//info', '/api/info'],
    ['/api/./info', '/api/info'],
    ['/api/%2e/info', '/api/info'],
    ['/api/%2E/info/', '/api/info'],
    ['http://127.0.0.1:4096/api/info?x=1#frag', '/api/info'],
    ['/api/session/%73es_1', '/api/session/ses_1'],
  ])('%s normalizes to %s', (target, canonical) => {
    const result = normalizeOpenCodeV2Path(target);
    expect(result).toMatchObject({ ok: true, canonicalPath: canonical });
  });

  it('keeps the query string for forwarding and drops the fragment', () => {
    expect(normalizeOpenCodeV2Path('/api/agent?location%5Bdirectory%5D=%2Fp#x')).toMatchObject({
      ok: true,
      canonicalPath: '/api/agent',
      search: '?location%5Bdirectory%5D=%2Fp',
    });
  });

  it('re-encodes decoded ids so the forwarded path is unambiguous', () => {
    const match = matchOpenCodeV2Route('GET', '/api/agent/a%20b');
    expect(match).toMatchObject({ ok: true, params: { agentID: 'a b' }, canonicalPath: '/api/agent/a%20b' });
  });

  it('matches trailing-slash and double-slash variants to the same (denied) route', () => {
    for (const target of ['/api/pty/', '//api/pty', '/api//pty', '/api/./pty']) {
      const verdict = evaluateOpenCodeV2Request({ audience: 'privileged', method: 'GET', path: target });
      expect(verdict).toMatchObject({ allowed: false, reason: 'route_denied', canonicalPath: '/api/pty' });
      expect(verdict.route.operationId).toBe('pty.list');
    }
    const fork = evaluateOpenCodeV2Request({ audience: 'server', method: 'POST', path: '/api/session/ses_1/fork/' });
    expect(fork).toMatchObject({ allowed: true, canonicalPath: '/api/session/ses_1/fork' });
  });

  it.each([
    ['/api/session/ses_1/../../pty', 'dot_dot_segment'],
    ['/api/session/ses_1/%2e%2e/%2e%2e/pty', 'dot_dot_segment'],
    ['/api/session/ses_1/%2E%2E/x', 'dot_dot_segment'],
    ['/api/session/ses_1%2F..%2F..%2Fpty', 'encoded_separator'],
    ['/api/session/ses_1%2fmessage', 'encoded_separator'],
    ['/api/experimental%2Ffs%2Fwrite', 'encoded_separator'],
    ['/api/fs/read/a%2Fb', 'encoded_separator'],
    ['/api/session/ses_1%5Cx', 'backslash'],
    ['/api\\info', 'backslash'],
    ['/api/info%00', 'control_character'],
    ['/api/in\nfo', 'control_character'],
    ['/api/%zz', 'malformed_encoding'],
    ['api/info', 'path_invalid'],
    ['', 'path_invalid'],
    [`/${'a'.repeat(5000)}`, 'path_too_long'],
  ])('rejects %s (%s)', (target, reason) => {
    expect(normalizeOpenCodeV2Path(target)).toEqual({ ok: false, reason });
    for (const audience of AUDIENCES) {
      expect(evaluateOpenCodeV2Request({ audience, method: 'GET', path: target })).toMatchObject({
        allowed: false,
        routeClass: DENY,
        reason: 'path_rejected',
        detail: reason,
        canonicalPath: null,
      });
    }
  });

  it('rejects non-string targets', () => {
    expect(normalizeOpenCodeV2Path(undefined)).toEqual({ ok: false, reason: 'path_invalid' });
    expect(normalizeOpenCodeV2Path(42)).toEqual({ ok: false, reason: 'path_invalid' });
  });

  it('prefers static segments over parameters', () => {
    expect(matchOpenCodeV2Route('GET', '/api/session/active').route.operationId).toBe('session.active');
    expect(matchOpenCodeV2Route('GET', '/api/experimental/session/stats').route.operationId).toBe('experimental.session.stats');
    expect(matchOpenCodeV2Route('GET', '/api/model/default').route.operationId).toBe('model.default');
  });
});

describe('body rules', () => {
  const patch = (audience, body) => evaluateOpenCodeV2Request({ audience, method: 'PATCH', path: '/api/session/ses_1', body });
  const create = (audience, body) => evaluateOpenCodeV2Request({ audience, method: 'POST', path: '/api/session', body });
  const synthetic = (audience, body) => evaluateOpenCodeV2Request({ audience, method: 'POST', path: '/api/session/ses_1/synthetic', body });

  it('lists the body-dependent operations', () => {
    expect(hasOpenCodeV2BodyRule('PATCH', '/api/session/{sessionID}')).toBe(true);
    expect(hasOpenCodeV2BodyRule('post', '/api/session')).toBe(true);
    expect(hasOpenCodeV2BodyRule('POST', '/api/session/{sessionID}/synthetic')).toBe(true);
    expect(hasOpenCodeV2BodyRule('POST', '/api/session/{sessionID}/prompt')).toBe(false);
  });

  it('PATCH session: title is a server write; permissions and metadata need the privileged client', () => {
    expect(patch('server', { title: 'Renamed' })).toMatchObject({ allowed: true, routeClass: SERVER });
    expect(patch('server', { title: null })).toMatchObject({ allowed: true });
    expect(patch('browser', { title: 'Renamed' })).toMatchObject({ allowed: false, reason: 'audience_insufficient' });
    for (const body of [{ permissions: [] }, { permissions: null }, { metadata: { devryan: {} } }, { title: 'x', metadata: {} }]) {
      expect(patch('server', body)).toMatchObject({ allowed: false, routeClass: PRIVILEGED, reason: 'audience_insufficient', detail: 'body_requires_privileged' });
      expect(patch('browser', body)).toMatchObject({ allowed: false });
      expect(patch('privileged', body)).toMatchObject({ allowed: true, routeClass: PRIVILEGED });
    }
    expect(patch('server', { permissions: [], metadata: {} }).keys).toEqual(['metadata', 'permissions']);
  });

  it('PATCH session: unknown keys, non-object or missing bodies are denied for everyone', () => {
    for (const audience of AUDIENCES) {
      expect(patch(audience, { title: 'x', time: { archived: 1 } })).toMatchObject({ allowed: false, reason: 'body_rejected', detail: 'body_key_not_allowed', keys: ['time'] });
      expect(patch(audience, ['title'])).toMatchObject({ allowed: false, detail: 'body_invalid' });
      expect(patch(audience, 'title')).toMatchObject({ allowed: false, detail: 'body_invalid' });
      expect(patch(audience, undefined)).toMatchObject({ allowed: false, detail: 'body_required' });
    }
  });

  it('POST session: permissions in the body are refused for the browser and the server client (G1)', () => {
    const allowAll = { title: 'x', permissions: [{ action: '*', resource: '*', effect: 'allow' }] };
    expect(create('browser', allowAll)).toMatchObject({ allowed: false });
    expect(create('server', allowAll)).toMatchObject({ allowed: false, reason: 'audience_insufficient', detail: 'body_requires_privileged', keys: ['permissions'] });
    expect(create('privileged', allowAll)).toMatchObject({ allowed: true, routeClass: PRIVILEGED });
    expect(create('server', { id: 'ses_1', title: 'x', agent: 'build', model: { id: 'm', providerID: 'p' }, location: { directory: '/p' } }))
      .toMatchObject({ allowed: true, routeClass: SERVER });
    expect(create('server', { title: 'x', parentID: 'ses_0' })).toMatchObject({ allowed: false, detail: 'body_key_not_allowed', keys: ['parentID'] });
  });

  it('synthetic: privileged only, and never with a caller-supplied subagent source', () => {
    expect(synthetic('server', { text: 'x' })).toMatchObject({ allowed: false, reason: 'audience_insufficient' });
    expect(synthetic('privileged', { text: 'x' })).toMatchObject({ allowed: true });
    expect(synthetic('privileged', { text: 'x', metadata: { source: 'subagent' } })).toMatchObject({
      allowed: false,
      reason: 'body_rejected',
      detail: 'synthetic_subagent_source_reserved',
    });
  });

  it('a body rule never lowers a static class', () => {
    const route = matchOpenCodeV2Route('POST', '/api/session/ses_1/synthetic').route;
    expect(classifyOpenCodeV2Body(route, { text: 'x' }).routeClass).toBe(PRIVILEGED);
    const prompt = matchOpenCodeV2Route('POST', '/api/session/ses_1/prompt').route;
    expect(classifyOpenCodeV2Body(prompt, { anything: true }).routeClass).toBe(SERVER);
  });

  it('browser façade PATCH guard accepts only a title', () => {
    expect(checkBrowserSessionPatchBody({ title: 'x' })).toEqual({ ok: true });
    expect(checkBrowserSessionPatchBody({})).toEqual({ ok: true });
    expect(checkBrowserSessionPatchBody({ title: 'x', permissions: [] })).toEqual({ ok: false, reason: 'body_key_not_allowed', keys: ['permissions'] });
    expect(checkBrowserSessionPatchBody({ metadata: {} })).toMatchObject({ ok: false });
    expect(checkBrowserSessionPatchBody({ title: 1 })).toEqual({ ok: false, reason: 'body_invalid' });
    expect(checkBrowserSessionPatchBody(null)).toEqual({ ok: false, reason: 'body_invalid' });
  });
});

describe('G1 and G4 hardening findings', () => {
  it('GET /api/credential (secret values) is privileged only', () => {
    for (const audience of ['browser', 'server']) {
      expect(evaluateOpenCodeV2Request({ audience, method: 'GET', path: '/api/credential' })).toMatchObject({ allowed: false, routeClass: PRIVILEGED });
    }
    expect(evaluateOpenCodeV2Request({ audience: 'privileged', method: 'GET', path: '/api/credential' }).allowed).toBe(true);
  });

  it('the browser reaches nothing but the info probe', () => {
    const allowed = listOpenCodeV2KnownRoutes()
      .filter((route) => evaluateOpenCodeV2Request({ audience: 'browser', method: route.method, path: concretePath(route), body: BODY_FOR[keyOf(route)] }).allowed)
      .map(keyOf);
    expect(allowed).toEqual(['GET /api/info']);
  });
});

describe('location binding', () => {
  const ROOTS = ['/work/project-a', '/work/project-b/'];
  const bind = (input) => bindOpenCodeV2Location({ allowedRoots: ROOTS, ...input });

  it('accepts a header-mode directory inside a root from the query, Express-parsed query or header', () => {
    expect(bind({ method: 'GET', path: '/api/agent?location%5Bdirectory%5D=%2Fwork%2Fproject-a' }))
      .toEqual({ ok: true, directory: '/work/project-a', mode: 'header' });
    expect(bind({ method: 'GET', path: '/api/agent', query: new URLSearchParams({ 'location[directory]': '/work/project-a/sub' }) }))
      .toEqual({ ok: true, directory: '/work/project-a/sub', mode: 'header' });
    expect(bind({ method: 'GET', path: '/api/agent', query: { location: { directory: '/work/project-b' } } }))
      .toMatchObject({ ok: true, directory: '/work/project-b' });
    expect(bind({ method: 'GET', path: '/api/agent', query: 'location[directory]=/work/project-b/x' }))
      .toMatchObject({ ok: true, directory: '/work/project-b/x' });
    expect(bind({ method: 'GET', path: '/api/agent', headers: { 'X-OpenCode-Directory': encodeURIComponent('/work/project-a/é') } }))
      .toMatchObject({ ok: true, directory: '/work/project-a/é' });
    expect(bind({ method: 'GET', path: '/api/agent', headers: new Headers({ 'x-opencode-directory': '/work/project-a' }) }))
      .toMatchObject({ ok: true });
  });

  it('fails closed when a header-mode operation names no directory (v2 would use the host cwd)', () => {
    expect(bind({ method: 'GET', path: '/api/agent' })).toEqual({ ok: false, code: 'location_required', mode: 'header' });
    expect(bind({ method: 'GET', path: '/api/agent?location%5Bdirectory%5D=' })).toMatchObject({ ok: false, code: 'location_required' });
  });

  it.each([
    ['/work/project-c', 'location_outside_roots'],
    ['/work/project-a-evil', 'location_outside_roots'],
    ['/work', 'location_outside_roots'],
    ['/', 'location_outside_roots'],
    ['/work/project-a/../project-c', 'location_invalid'],
    ['/work/project-a/..', 'location_invalid'],
    ['work/project-a', 'location_invalid'],
    ['./project-a', 'location_invalid'],
    ['/work/project-a/\0x', 'location_invalid'],
  ])('rejects %s (%s)', (directory, code) => {
    expect(bind({ method: 'GET', path: '/api/agent', query: { 'location[directory]': directory } })).toMatchObject({ ok: false, code });
    expect(bind({ method: 'GET', path: '/api/agent', headers: { 'x-opencode-directory': encodeURIComponent(directory) } })).toMatchObject({ ok: false, code });
  });

  it('rejects disagreeing, repeated or malformed location values', () => {
    expect(bind({
      method: 'GET',
      path: '/api/agent',
      query: { 'location[directory]': '/work/project-a' },
      headers: { 'x-opencode-directory': '/work/project-b' },
    })).toMatchObject({ ok: false, code: 'location_ambiguous' });
    expect(bind({ method: 'GET', path: '/api/agent', query: new URLSearchParams([['location[directory]', '/work/project-a'], ['location[directory]', '/work/project-b']]) }))
      .toMatchObject({ ok: false, code: 'location_ambiguous' });
    expect(bind({ method: 'GET', path: '/api/agent', query: { 'location[directory]': ['/work/project-a'] } })).toMatchObject({ ok: false, code: 'location_invalid' });
    expect(bind({ method: 'GET', path: '/api/agent', query: { location: '/work/project-a' } })).toMatchObject({ ok: false, code: 'location_invalid' });
    expect(bind({ method: 'GET', path: '/api/agent', headers: { 'x-opencode-directory': ['/work/project-a'] } })).toMatchObject({ ok: false, code: 'location_invalid' });
    expect(bind({ method: 'GET', path: '/api/agent', headers: { 'x-opencode-directory': '%E0%A4%A' } })).toMatchObject({ ok: false, code: 'location_invalid' });
    // A stray `directory` query on a header-mode route must agree too (v2 ignores it).
    expect(bind({ method: 'GET', path: '/api/agent', query: { 'location[directory]': '/work/project-a', directory: '/elsewhere' } }))
      .toMatchObject({ ok: false, code: 'location_ambiguous' });
    // Same directory spelled with a trailing slash is not ambiguous.
    expect(bind({ method: 'GET', path: '/api/agent', query: { 'location[directory]': '/work/project-a/' }, headers: { 'x-opencode-directory': '/work/project-a' } }))
      .toMatchObject({ ok: true, directory: '/work/project-a' });
  });

  it('binds session create through the body location and requires one', () => {
    expect(bind({ method: 'POST', path: '/api/session', body: { title: 'x', location: { directory: '/work/project-a' } } }))
      .toEqual({ ok: true, directory: '/work/project-a', mode: 'body-location' });
    expect(bind({ method: 'POST', path: '/api/session', body: { title: 'x', location: { directory: '/etc' } } }))
      .toMatchObject({ ok: false, code: 'location_outside_roots' });
    expect(bind({ method: 'POST', path: '/api/session', body: { title: 'x' } })).toMatchObject({ ok: false, code: 'location_required' });
    expect(bind({ method: 'POST', path: '/api/session', body: { title: 'x', location: '/work/project-a' } })).toMatchObject({ ok: false, code: 'location_invalid' });
    expect(bind({
      method: 'POST',
      path: '/api/session',
      body: { location: { directory: '/work/project-a' } },
      headers: { 'x-opencode-directory': '/work/project-b' },
    })).toMatchObject({ ok: false, code: 'location_ambiguous' });
  });

  it('treats the session-list directory as an optional filter that must still be inside a root', () => {
    expect(bind({ method: 'GET', path: '/api/session' })).toEqual({ ok: true, directory: null, mode: 'query-directory' });
    expect(bind({ method: 'GET', path: '/api/session?directory=%2Fwork%2Fproject-b' })).toMatchObject({ ok: true, directory: '/work/project-b' });
    expect(bind({ method: 'GET', path: '/api/session?directory=%2Fother' })).toMatchObject({ ok: false, code: 'location_outside_roots' });
  });

  it('needs no directory on session-scoped routes but still checks one that is sent', () => {
    expect(bind({ method: 'GET', path: '/api/session/ses_1/message' })).toEqual({ ok: true, directory: null, mode: 'session' });
    expect(bind({ method: 'GET', path: '/api/session/ses_1/message', headers: { 'x-opencode-directory': '/other' } }))
      .toMatchObject({ ok: false, code: 'location_outside_roots' });
  });

  it('denies everything when no valid roots are configured, and unknown routes', () => {
    expect(bindOpenCodeV2Location({ method: 'GET', path: '/api/agent', query: { 'location[directory]': '/work/project-a' }, allowedRoots: [] }))
      .toMatchObject({ ok: false, code: 'location_outside_roots' });
    expect(bindOpenCodeV2Location({ method: 'GET', path: '/api/agent', query: { 'location[directory]': '/work/project-a' }, allowedRoots: ['relative'] }))
      .toMatchObject({ ok: false, code: 'location_outside_roots' });
    expect(bind({ method: 'GET', path: '/api/unknown' })).toEqual({ ok: false, code: 'route_unknown', mode: null });
  });

  it('accepts a pre-matched route', () => {
    const { route } = matchOpenCodeV2Route('GET', '/api/fs/read/a.txt');
    expect(bind({ route, query: { location: { directory: '/work/project-a' } } })).toMatchObject({ ok: true, mode: 'header' });
  });
});

describe('diffLiveSpec', () => {
  it('reports no drift for the vendored document, as an object or as text', () => {
    expect(diffLiveSpec(vendoredDoc())).toMatchObject({ ok: true, version: '2.0.24', error: null, added: [], removed: [], changed: [] });
    expect(diffLiveSpec(VENDORED_TEXT).ok).toBe(true);
  });

  it('reports added, removed and changed operations', () => {
    const doc = vendoredDoc();
    doc.paths['/api/brand-new'] = { post: { operationId: 'brand.new', parameters: [], responses: {} } };
    delete doc.paths['/api/vcs/base'];
    doc.paths['/api/session/{sessionID}'].patch.requestBody.content['application/json'].schema.properties.agent = { type: 'string' };
    doc.paths['/api/session/{sessionID}'].get.parameters[0].schema.pattern = '^s';
    doc.paths['/api/info'].get.operationId = 'server.information';
    const drift = diffLiveSpec(doc);
    expect(drift.ok).toBe(false);
    expect(drift.added).toEqual(['POST /api/brand-new']);
    expect(drift.removed).toEqual(['GET /api/vcs/base']);
    expect(drift.changed).toEqual(expect.arrayContaining([
      { route: 'PATCH /api/session/{sessionID}', fields: ['body'] },
      { route: 'GET /api/session/{sessionID}', fields: ['pathParams'] },
      { route: 'GET /api/info', fields: ['operationId'] },
    ]));
    expect(drift.changed).toHaveLength(3);
  });

  it('reports a location-mode change (a route losing its location parameter)', () => {
    const doc = vendoredDoc();
    doc.paths['/api/agent'].get.parameters = [];
    expect(diffLiveSpec(doc).changed).toEqual([{ route: 'GET /api/agent', fields: ['location', 'query'] }]);
  });

  it('fails on documents that are not OpenAPI', () => {
    expect(diffLiveSpec('{not json')).toMatchObject({ ok: false, error: 'openapi_unparseable' });
    expect(diffLiveSpec({})).toMatchObject({ ok: false });
    expect(diffLiveSpec({}).error).toMatch(/^openapi_invalid/);
    expect(diffLiveSpec(null).ok).toBe(false);
    expect(diffLiveSpec({ paths: {} }).error).toMatch(/no operations/);
  });

  it('agrees with a fresh extraction of the vendored document', () => {
    expect(JSON.parse(JSON.stringify(OPENCODE_V2_ROUTES))).toEqual(extractOpenCodeV2Operations(vendoredDoc()));
  });
});
