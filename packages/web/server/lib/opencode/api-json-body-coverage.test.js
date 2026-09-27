import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import ts from 'typescript';
import { describe, expect, it } from 'vitest';

import { resolveSharedJsonBodyLimit } from './core-routes.js';

// registerCommonRequestMiddleware JSON-parses only allowlisted /api prefixes;
// every other /api path stays raw for the OpenCode proxy. A route outside that
// list that reads req.body must mount its own bounded parser, or its body is
// silently undefined in production while a test with an app-level
// express.json() stays green. This guard scans every server route
// registration for that gap.

const SERVER_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
// GET is excluded: browsers cannot send a GET body, so a GET handler's body
// read is a fallback that never carries data rather than a parsing gap.
const ROUTE_METHODS = new Set(['post', 'put', 'patch', 'delete', 'all', 'use']);
const PARSER_FACTORIES = new Set(['json', 'raw', 'text']);

const isFunctionLike = (node) => ts.isArrowFunction(node)
  || ts.isFunctionExpression(node)
  || ts.isFunctionDeclaration(node);

// express.json(...) / express.raw(...) / express.text(...)
const isParserFactoryCall = (node) => ts.isCallExpression(node)
  && ts.isPropertyAccessExpression(node.expression)
  && ts.isIdentifier(node.expression.expression)
  && node.expression.expression.text === 'express'
  && PARSER_FACTORIES.has(node.expression.name.text);

const bindingKey = (element) => (element.propertyName ?? element.name).getText();

const analyzeRouteSource = (fileName, text) => {
  const source = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const strings = new Map();
  const functions = new Map();
  const parsers = new Set();
  const index = (node) => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
      if (ts.isStringLiteralLike(node.initializer)) strings.set(node.name.text, node.initializer.text);
      if (isFunctionLike(node.initializer)) functions.set(node.name.text, node.initializer);
      if (isParserFactoryCall(node.initializer)) parsers.add(node.name.text);
    }
    if (ts.isFunctionDeclaration(node) && node.name) functions.set(node.name.text, node);
    ts.forEachChild(node, index);
  };
  index(source);

  const resolvePath = (node) => {
    if (ts.isStringLiteralLike(node)) return node.text;
    if (ts.isIdentifier(node)) return strings.get(node.text) ?? null;
    if (!ts.isTemplateExpression(node)) return null;
    let value = node.head.text;
    for (const span of node.templateSpans) {
      const constant = ts.isIdentifier(span.expression) ? strings.get(span.expression.text) : undefined;
      value += (constant ?? ':dynamic') + span.literal.text;
    }
    return value;
  };

  // Local name that holds the request inside fn, given how a caller passed it:
  // positionally, or as property `key` of an object argument.
  const requestBinding = (fn, { position, key }) => {
    const parameter = fn?.parameters?.[position];
    if (!parameter) return null;
    let target = parameter.name;
    if (key !== undefined) {
      if (!ts.isObjectBindingPattern(target)) return null;
      const element = target.elements.find((candidate) => bindingKey(candidate) === key);
      if (!element) return null;
      target = element.name;
    }
    if (ts.isObjectBindingPattern(target)) {
      return { destructuresBody: target.elements.some((element) => bindingKey(element) === 'body') };
    }
    return ts.isIdentifier(target) ? { name: target.text } : null;
  };

  // Does fn read the request body, directly or through same-file helpers?
  const readsBody = (fn, via = { position: 0 }, seen = new Set()) => {
    const marker = `${fn?.pos}:${via.position}:${via.key ?? ''}`;
    if (!fn || seen.has(marker)) return false;
    seen.add(marker);
    const binding = requestBinding(fn, via);
    if (!binding) return false;
    if (binding.destructuresBody) return true;
    const name = binding.name;
    const isRequest = (node) => ts.isIdentifier(node) && node.text === name;
    let found = false;
    const walk = (node) => {
      if (found) return;
      if ((ts.isPropertyAccessExpression(node) && isRequest(node.expression) && node.name.text === 'body')
        || (ts.isElementAccessExpression(node) && isRequest(node.expression)
          && ts.isStringLiteralLike(node.argumentExpression) && node.argumentExpression.text === 'body')
        || ((ts.isVariableDeclaration(node) || ts.isBindingElement(node))
          && ts.isObjectBindingPattern(node.name) && node.initializer && isRequest(node.initializer)
          && node.name.elements.some((element) => bindingKey(element) === 'body'))) {
        found = true;
        return;
      }
      if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) {
        const callee = functions.get(node.expression.text);
        node.arguments.forEach((argument, position) => {
          if (found || !callee) return;
          if (isRequest(argument)) {
            found = readsBody(callee, { position }, seen);
            return;
          }
          if (!ts.isObjectLiteralExpression(argument)) return;
          for (const property of argument.properties) {
            const passesRequest = (ts.isShorthandPropertyAssignment(property) && isRequest(property.name))
              || (ts.isPropertyAssignment(property) && isRequest(property.initializer));
            if (passesRequest && readsBody(callee, { position, key: property.name.getText() }, seen)) {
              found = true;
              return;
            }
          }
        });
      }
      ts.forEachChild(node, walk);
    };
    // Parameters too: `({ req, body = req.body })` reads through a default.
    fn.parameters.forEach(walk);
    if (fn.body) walk(fn.body);
    return found;
  };

  // Does fn run a body parser itself (a wrapper middleware or in-handler parse)?
  const invokesParser = (fn, seen = new Set()) => {
    if (!fn || seen.has(fn)) return false;
    seen.add(fn);
    let found = false;
    const walk = (node) => {
      if (found) return;
      if (ts.isCallExpression(node)) {
        const callee = node.expression;
        if (isParserFactoryCall(callee)
          || (ts.isIdentifier(callee) && (parsers.has(callee.text) || invokesParser(functions.get(callee.text), seen)))) {
          found = true;
          return;
        }
      }
      ts.forEachChild(node, walk);
    };
    if (fn.body) walk(fn.body);
    return found;
  };

  const inspectHandler = (node) => {
    if (isParserFactoryCall(node)) return { parsed: true, readsBody: false };
    if (ts.isIdentifier(node)) {
      if (parsers.has(node.text)) return { parsed: true, readsBody: false };
      const fn = functions.get(node.text);
      return { parsed: invokesParser(fn), readsBody: readsBody(fn) };
    }
    if (isFunctionLike(node)) return { parsed: invokesParser(node), readsBody: readsBody(node) };
    // Wrappers, spreads, and conditionals: inspect what they contain.
    const nested = [];
    const collect = (child) => {
      if (isParserFactoryCall(child) || isFunctionLike(child)
        || (ts.isIdentifier(child) && (parsers.has(child.text) || functions.has(child.text)))) {
        nested.push(child);
        return;
      }
      ts.forEachChild(child, collect);
    };
    ts.forEachChild(node, collect);
    return nested.map(inspectHandler).reduce((acc, info) => ({
      parsed: acc.parsed || info.parsed,
      readsBody: acc.readsBody || info.readsBody,
    }), { parsed: false, readsBody: false });
  };

  const routes = [];
  const find = (node) => {
    if (ts.isCallExpression(node) && node.arguments.length >= 2) {
      const callee = node.expression;
      const method = ts.isPropertyAccessExpression(callee) ? callee.name.text
        : ts.isElementAccessExpression(callee) ? 'computed' : null;
      const routePath = method && (method === 'computed' || ROUTE_METHODS.has(method))
        ? resolvePath(node.arguments[0])
        : null;
      if (routePath === '/api' || routePath?.startsWith('/api/')) {
        const handlers = node.arguments.slice(1).map(inspectHandler);
        routes.push({
          file: fileName,
          line: source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1,
          method,
          path: routePath,
          parsed: handlers.some((handler) => handler.parsed),
          readsBody: handlers.some((handler) => handler.readsBody),
        });
      }
    }
    ts.forEachChild(node, find);
  };
  find(source);
  return routes;
};

const sharedParserCovers = (routePath) => (
  resolveSharedJsonBodyLimit(routePath.replace(/:[A-Za-z_]+/g, 'x')) !== null
);

const unparsedBodyReaders = (routes) => routes.filter((route) => (
  route.readsBody && !route.parsed && !sharedParserCovers(route.path)
));

const listServerSources = (directory) => fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
  const fullPath = path.join(directory, entry.name);
  if (entry.isDirectory()) return entry.name === 'node_modules' ? [] : listServerSources(fullPath);
  return /\.m?js$/.test(entry.name) && !/\.test\.m?js$/.test(entry.name) ? [fullPath] : [];
});

const scanServerRoutes = () => listServerSources(SERVER_ROOT).flatMap((file) => (
  analyzeRouteSource(path.relative(SERVER_ROOT, file), fs.readFileSync(file, 'utf8'))
));

const flagged = (text) => unparsedBodyReaders(analyzeRouteSource('fixture.js', text))
  .map((route) => `${route.method} ${route.path}`);

describe('API JSON body coverage scanner', () => {
  it('flags an unlisted /api route that reads the body without a parser', () => {
    expect(flagged(`
      app.post('/api/example', async (req, res) => res.json(req.body));
      app.patch('/api/example/destructured', ({ body }, res) => res.json(body));
      app.put('/api/example/local', (request, res) => { const { body } = request; res.json(body); });
    `)).toEqual(['post /api/example', 'patch /api/example/destructured', 'put /api/example/local']);
  });

  it('follows the request through same-file helpers, object arguments, and defaults', () => {
    expect(flagged(`
      const readDirectory = (req) => req.body?.directory;
      const forward = async ({ req, body = req.body }) => fetch('/upstream', { body });
      function handleStop(req, res) { res.json({ at: readDirectory(req) }); }
      app.post('/api/helper', (req, res) => res.json(readDirectory(req)));
      app.post('/api/forward', async (req, res) => res.json(await forward({ req, path: '/x' })));
      app.post('/api/named', handleStop);
    `)).toEqual(['post /api/helper', 'post /api/forward', 'post /api/named']);
  });

  it('resolves constant and template paths, including computed registrations', () => {
    expect(flagged(`
      const BASE = '/api/example-leases';
      app.post(BASE, (req, res) => res.json(req.body));
      app.delete(\`\${BASE}/:leaseId\`, (req, res) => res.json(req.body));
      const route = (verb) => app[verb](\`/api/example/\${verb}\`, (req, res) => res.json(req.body));
    `)).toEqual(['post /api/example-leases', 'delete /api/example-leases/:leaseId', 'computed /api/example/:dynamic']);
  });

  it('accepts inline, named, conditional, wrapper, and in-handler parsers', () => {
    expect(flagged(`
      const json = express.json({ limit: '8kb' });
      const parseJson = (req, res, next) => json(req, res, next);
      const readInline = (req, res, next) => express.json({ limit: '4kb' })(req, res, () => next());
      app.post('/api/inline', express.json({ limit: '4kb' }), (req, res) => res.json(req.body));
      app.post('/api/named', json, (req, res) => res.json(req.body));
      app.put('/api/conditional', ...(true ? [json] : []), (req, res) => res.json(req.body));
      app.post('/api/wrapped', parseJson, run(async (request) => request.body));
      app.post('/api/in-handler', (req, res) => readInline(req, res, () => res.json(req.body)));
      app.post('/api/raw', express.raw({ type: 'application/octet-stream' }), (req, res) => res.send(req.body));
    `)).toEqual([]);
  });

  it('accepts shared-allowlist paths and ignores routes that never read the body', () => {
    expect(flagged(`
      app.post('/api/bots/:botId/pause', (req, res) => res.json(req.body));
      app.post('/api/session/:sessionID/abort', (req, res) => res.json(req.body));
      app.post('/api/example/ping', (_req, res) => res.json({ ok: true }));
      app.post('/auth/example', (req, res) => res.json(req.body));
      upstream.post('/api/example', payload);
    `)).toEqual([]);
  });
});

describe('API JSON body coverage', () => {
  const routes = scanServerRoutes();

  it('sees the real route registrations, including previously broken body routes', () => {
    // A scanner regression that stops recognizing registrations must fail loudly.
    expect(routes.length).toBeGreaterThan(250);
    const find = (method, routePath) => routes.find((route) => route.method === method && route.path === routePath);
    expect(find('patch', '/api/system/supabase-connection')).toMatchObject({ readsBody: true, parsed: true });
    expect(find('post', '/api/runtime-service/desktop-host')).toMatchObject({ readsBody: true, parsed: true });
  });

  it('parses the JSON body of every /api route that reads req.body', () => {
    const offenders = unparsedBodyReaders(routes)
      .map((route) => `${route.file}:${route.line} ${route.method.toUpperCase()} ${route.path}`);
    expect(
      offenders,
      'These routes read req.body, but the shared parser skips their path. Mount a bounded '
        + 'express.json({ limit }) on each route (preferred) or add the prefix to '
        + 'resolveSharedJsonBodyLimit in core-routes.js.',
    ).toEqual([]);
  });
});
