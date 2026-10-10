import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createServer } from 'node:http';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { hasForwardingHeaders } from '../../packages/web/server/lib/security/forwarded-request.js';
import { createOpenCodeClient } from '../../packages/web/server/lib/opencode/opencode-client/index.js';
import { createOpenCodeAdmission } from '../../packages/web/server/lib/opencode/v2/admission.js';
import { createV2AudienceRequester } from '../../packages/web/server/lib/opencode/opencode-client/requester.js';
import { createGlobalMessageStreamHub } from '../../packages/web/server/lib/event-stream/global-hub.js';
import { registerOpenCodeProxy } from '../../packages/web/server/lib/opencode/proxy.js';
import { registerSessionPlanRoutes } from '../../packages/web/server/lib/plans/routes.js';
import { createHarnessTaskContextHost } from '../../packages/web/server/lib/opencode/harness-task-context.js';
import { registerConfigEntityRoutes } from '../../packages/web/server/lib/opencode/config-entity-routes.js';
import { listConfigAgents } from '../../packages/web/server/lib/opencode/agents.js';
import { readAgentRuntimeSettings, writeAgentRuntimeSettings } from '../../packages/web/server/lib/opencode/agent-runtime-settings.js';

const require = createRequire(new URL('../../packages/web/package.json', import.meta.url));
const express = require('express');
const loopback = value => {
  const url = new URL(value);
  assert.equal(url.protocol, 'http:'); assert.equal(url.hostname, '127.0.0.1');
  assert.equal(url.pathname, '/'); assert.equal(url.search, ''); assert.equal(url.hash, '');
  assert.equal(url.username, ''); assert.equal(url.password, '');
  return url.origin;
};
const core = pathname => /^\/api\/(?:session(?:\/|$)|experimental\/(?:session|tool)(?:\/|$)|question(?:\/|$)|permission(?:\/|$)|(?:agent|provider|command|config|global\/config|skill|mcp|path|project|vcs|lsp)(?:\/|$)|(?:global\/)?event$)/.test(pathname);
const featureConfig = pathname => /^\/api\/config\//.test(pathname) && !['/api/config/providers', '/api/config/agents', '/api/config/agent-runtime'].includes(pathname);
const providerReadFeature = req => req.method === 'GET'
  && (req.path === '/api/provider/auth' || /^\/api\/provider\/[^/]+\/source$/.test(req.path));

/** Disposable UI transport only. Original native binding and local host still
 * boot normally; no fixture ID, permit or receipt is offered to that owner. */
export async function createQaFixtureHostFacade({ fixture, realOrigin, workspace, dataDirectory, userConfigPath }) {
  const upstream = loopback(realOrigin); loopback(fixture.origin);
  const cache=path.join(await fs.realpath(fileURLToPath(new URL('../../',import.meta.url))),'.cache');
  for (const directory of [workspace, dataDirectory, path.dirname(userConfigPath)]) {
    assert.equal(await fs.realpath(directory), directory);
    const relative=path.relative(cache,directory);
    assert.ok(relative && relative!=='..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
  }
  assert.equal(fixture.generation, 2);
  const getRuntime = () => ({ generation: 2, version: '2.0.20', baseUrl: fixture.origin, epoch: 1 });
  const getAuthHeaders = () => fixture.authHeaders;
  const deps={getRuntime,getAuthHeaders};
  const fixtureWire=createV2AudienceRequester(deps,{audience:'server'});
  // Same explicit wire-only delegation as the original admission fixture.
  // The actual native owner never receives these synthetic IDs or writes.
  deps.withNativeWebOperation=async(_scope,action)=>action();
  deps.removeNativeSession=async(sessionID,options)=>{await fixtureWire({method:'DELETE',path:`/api/session/${encodeURIComponent(sessionID)}`,directory:options.directory});return true;};
  let admission;
  const client = createOpenCodeClient({ ...deps,getAdmission:()=>admission });
  admission=createOpenCodeAdmission(deps,{client});
  const hub = createGlobalMessageStreamHub({ openCodeClient: client, getOpenCodeRuntime: getRuntime, getOpenCodeAuthHeaders: getAuthHeaders });
  const context = createHarnessTaskContextHost({ openCodeClient: client, dataDirectory, isManaged: () => false,
    getRegisteredProjects: async () => [{ path: workspace }] });
  const app = express(), server = createServer(app), active = new Set(), unexpected = [];
  let origin, closed = false;
  const resolveDirectory = req => {
    const directory = req.query?.directory ?? req.headers['x-opencode-directory'] ?? workspace;
    if (typeof directory !== 'string' || decodeURIComponent(directory) !== workspace) throw Object.assign(new Error('qa_fixture_directory_refused'), { statusCode: 403 });
    return workspace;
  };
  app.use((req, res, next) => {
    if (req.headers.host !== new URL(origin).host || hasForwardingHeaders(req) || req.headers.origin && req.headers.origin !== origin) return res.status(403).end();
    if(req.headers.referer)try{if(new URL(req.headers.referer).origin!==origin)return res.status(403).end();}catch{return res.status(403).end();}
    if(core(req.path)&&!featureConfig(req.path))try{resolveDirectory(req);}catch{return res.status(403).end();}
    next();
  });
  const features = express.Router();
  registerSessionPlanRoutes(features, { dataDirectory, fsPromises: fs, path,
    readCanonicalPlanIdentity: context.readCanonicalPlanIdentity,
    publishEvent: (payload, options) => hub.publishSyntheticEvent({ payload, directory: options.directory }) });
  registerConfigEntityRoutes(features, { resolveProjectDirectory: async req => ({ directory: resolveDirectory(req) }),
    listConfigAgents: directory => listConfigAgents(directory, { userConfigPath, env: {},
      readOpenCodeConfig: () => JSON.parse(require('node:fs').readFileSync(userConfigPath, 'utf8')) }),
    readAgentRuntimeSettings: () => readAgentRuntimeSettings({ userConfigPath }),
    writeAgentRuntimeSettings: input => writeAgentRuntimeSettings(input, { userConfigPath }),
    getAgentRuntimeApplicationState: () => ({ runtimeMode: 'external', appliedLsp: null }) });
  app.use((req, res, next) => {
    if (/^\/api\/session\/[^/]+\/plan-revisions\/[^/]+$/.test(req.path)
      || ['/api/config/agents', '/api/config/agent-runtime'].includes(req.path)) {
      return express.json({ limit: '1mb' })(req, res, error => error ? next(error) : features(req, res, next));
    }
    next();
  });
  const proxy = express();
  registerOpenCodeProxy(proxy, { openCodeClient: client, getOpenCodeRuntime: getRuntime,
    getOpenCodeAuthHeaders: getAuthHeaders, globalMessageStreamHub: hub, resolveRequestDirectory: resolveDirectory,
    OPEN_CODE_READY_GRACE_MS: 0, getRuntime: () => ({ openCodePort: new URL(fixture.origin).port, isOpenCodeReady: true }),
    buildOpenCodeUrl: route => fixture.origin + route });
  app.use((req, res, next) => {
    if (!core(req.path) || featureConfig(req.path) || providerReadFeature(req) || /^\/api\/session\/[^/]+\/recovery(?:\/|$)/.test(req.path)
      || /^\/api\/session\/[^/]+\/context-usage$/.test(req.path)) return next();
    res.once('finish', () => { if (res.statusCode === 404) unexpected.push({ method: req.method, path: req.path,
      pathSegments: req.path.split('/').filter(Boolean).slice(0,8).map(segment=>segment.slice(0,128)),
      routeShape: typeof req.route?.path === 'string' ? req.route.path.slice(0,128) : 'unmatched-core-route' }); });
    return proxy(req, res, next);
  });
  // Preserve actual product assets, authentication, settings, filesystem, Git
  // and diagnostics. Browser credentials never flow to the synthetic runtime.
  app.use(async (req, res) => {
    const controller = new AbortController(); active.add(controller);
    const abort = () => { if (!res.writableEnded) controller.abort(); };
    res.once('close', abort);
    try {
      const headers = { ...req.headers }; delete headers.host; delete headers.connection;
      // The incoming browser origin was checked above. The unchanged product
      // security middleware must see the actual loopback host on this hop.
      if(headers.origin)headers.origin=upstream;
      if(headers.referer){const referer=new URL(headers.referer);headers.referer=upstream+referer.pathname+referer.search;}
      let body;
      if(!['GET','HEAD'].includes(req.method)){
        const chunks=[];let bytes=0;
        for await(const chunk of req){bytes+=chunk.byteLength;if(bytes>50*1024*1024){res.status(413).end();return;}chunks.push(chunk);}
        body=Buffer.concat(chunks);
        delete headers['content-length'];delete headers['transfer-encoding'];
      }
      const response = await fetch(upstream + req.originalUrl, { method: req.method, headers, redirect: 'manual', signal: controller.signal,
        ...(body!==undefined?{body}:{}) });
      res.status(response.status);
      // Fetch exposes decoded bytes, so upstream compression/framing no longer
      // describes this response. Preserve the other product/security headers.
      for (const [key, value] of response.headers) if (!['content-encoding', 'content-length', 'transfer-encoding', 'connection', 'set-cookie'].includes(key)) res.setHeader(key, value);
      const cookies = response.headers.getSetCookie(); if (cookies.length) res.setHeader('set-cookie', cookies);
      if (response.body) await pipeline(Readable.fromWeb(response.body), res); else res.end();
    } catch (error) { if (!res.headersSent && !res.destroyed) res.status(502).json({ error: error.message, code: 'qa_fixture_host_unavailable' }); }
    finally { active.delete(controller); res.off('close', abort); }
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  origin = `http://127.0.0.1:${server.address().port}`;
  return { origin, client, unexpected, evidence: { mode: 'native-host-with-wire-facade', fixtureGeneration: 2,
    productionRouteConstructors: true, nativeExecution: 'not-tested', localElectronIPC: 'not-qualified-remote-facade' },
    close: async () => { if (closed) return; closed = true; hub.stop(); for (const controller of active) controller.abort();
      const done = new Promise(resolve => server.close(resolve)); server.closeAllConnections(); await done;
      assert.deepEqual(unexpected, [], 'Unexpected targeted wire facade routes'); } };
}
