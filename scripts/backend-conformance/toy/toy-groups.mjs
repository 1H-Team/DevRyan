// Toy entries of the group table (groups.mjs shape), for the self-test only.
// The group host loads them with --table=<this file>.
//
// `toy` adds, at the multi-user-routes step (code outside the group's files),
// a handler made by the group's factory (claimed: the group's), one from a
// group file that no factory made (the edge's), and a middleware that sets a
// principal of its own for one path. Its `variants` are planted
// re-statements of the edge: each must be caught by an edge probe
// (edge-probes.mjs), with the composition table unchanged.
import { importFromServer, SERVER_ROOT } from '../edge.mjs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { unclaimedMiddleware } from './toy-factory.mjs';

const TOY = 'scripts/backend-conformance/toy';
const express = await importFromServer('express');
const serverModule = (relative) => import(pathToFileURL(path.join(SERVER_ROOT, relative)).href);

/** express with every json() parser given another limit (a planted body-parser limit). */
const withJsonLimit = (base, limit) => Object.assign(Object.create(base), base, { json: (options = {}) => base.json({ ...options, limit }) });

export const TOY_VARIANTS = Object.freeze({
  'compression-threshold-8192': () => ({ compression: async ({ app }) => { const compression = await importFromServer('compression'); app.use(compression({ threshold: 8192 })); } }),
  'compression-skip-ignored': () => ({ compression: async ({ app }) => { const compression = await importFromServer('compression'); app.use(compression({ threshold: 1024 })); } }),
  'trust-proxy-off': () => ({ 'trust-proxy': async ({ app }) => { app.set('trust proxy', false); } }),
  'no-store-skipped': () => ({ 'no-store': null }),
  'indexing-skipped': () => ({ 'indexing-policy': null }),
  'legacy-path-skipped': () => ({ 'legacy-path': null }),
  'admission-skipped': () => ({ 'bundle-admission': null }),
  'parser-limit-50mb': () => ({ 'base-routes': async (context) => context.original({ ...context, express: withJsonLimit(context.express, '50mb') }) }),
  'tunnel-boundary-skipped': () => ({ 'tunnel-boundary': null }),
  'local-owner-skipped': () => ({ 'local-owner-bootstrap': null }),
  // The server composed with a UI password (the web composition has none).
  'ui-password-planted': () => {
    const withPassword = (context) => context.original({ ...context, values: { ...context.values, uiPassword: 'planted' } });
    return { 'tunnel-auth-initialize': withPassword, 'base-routes': withPassword };
  },
  'readiness-unavailable': () => ({ 'execution-readiness': async ({ app }) => {
    const { executionReadinessMiddleware } = await serverModule('lib/opencode/execution-artifacts.js');
    app.use(executionReadinessMiddleware({ state: 'required_unavailable', diagnostic: { message: 'planted', code: 'planted' } }));
  } }),
});

export const GROUPS = Object.freeze({
  toy: Object.freeze({
    edge: 'web-api',
    registrar: Object.freeze({ module: `${TOY}/toy-routes.mjs`, export: 'registerToyRoutes' }),
    files: Object.freeze([`${TOY}/toy-routes.mjs`, `${TOY}/toy-factory.mjs`]),
    dependencies: ({ hub, absent }) => ({ express, publish: hub('toy'), absentDependency: absent.make('toyAbsent') }),
    handlerFactories: Object.freeze([Object.freeze({ module: `${TOY}/toy-factory.mjs`, export: 'createToyFactoryRuntime' })]),
    edgeReplace: ({ factories }) => ({
      'multi-user-routes': async (context) => {
        await context.original(context);
        context.app.use('/api/toy/factory', factories.createToyFactoryRuntime().middleware);
        context.app.use('/api/toy/unclaimed', unclaimedMiddleware);
        context.app.use('/api/toy/principal', (req, _res, next) => { req.principal = { ...req.principal, scope: 'toy-scope' }; next(); });
      },
    }),
    variants: TOY_VARIANTS,
    declaredBackground: Object.freeze([Object.freeze({ file: `${TOY}/toy-background.mjs`, line: null, reason: 'the toy declares this work as fire-and-forget' })]),
  }),
  // The toy registrar alone, without the edge: a host that starts in a fraction of the time (launcher tests).
  'toy-bare': Object.freeze({
    edge: 'bare',
    registrar: Object.freeze({ module: `${TOY}/toy-routes.mjs`, export: 'registerToyRoutes' }),
    files: Object.freeze([`${TOY}/toy-routes.mjs`]),
    dependencies: ({ hub }) => ({ express, publish: hub('toy') }),
    declaredBackground: Object.freeze([Object.freeze({ file: `${TOY}/toy-background.mjs`, line: null, reason: 'the toy declares this work as fire-and-forget' })]),
  }),
  'toy-unattributed': Object.freeze({
    edge: 'bare',
    registrar: Object.freeze({ module: `${TOY}/toy-routes.mjs`, export: 'registerToyUnattributed' }),
    files: Object.freeze([`${TOY}/toy-routes.mjs`]),
    dependencies: () => ({}),
    declaredBackground: Object.freeze([]),
  }),
  'toy-framework-patch': Object.freeze({
    edge: 'bare',
    registrar: Object.freeze({ module: `${TOY}/toy-routes.mjs`, export: 'registerToyFrameworkPatch' }),
    files: Object.freeze([`${TOY}/toy-routes.mjs`]),
    dependencies: () => ({ express }),
    declaredBackground: Object.freeze([]),
  }),
  'toy-param': Object.freeze({
    edge: 'bare',
    registrar: Object.freeze({ module: `${TOY}/toy-routes.mjs`, export: 'registerToyParam' }),
    files: Object.freeze([`${TOY}/toy-routes.mjs`]),
    dependencies: () => ({}),
    declaredBackground: Object.freeze([]),
  }),
});
