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
import { sendOpenCodeFacadeError, validateFacadeBody } from '../../packages/web/server/lib/opencode/v2/facade-routes.js';
import { createV2AudienceRequester } from '../../packages/web/server/lib/opencode/opencode-client/requester.js';
import { createGlobalMessageStreamHub } from '../../packages/web/server/lib/event-stream/global-hub.js';
import { registerOpenCodeProxy } from '../../packages/web/server/lib/opencode/proxy.js';
import { registerSessionPlanRoutes } from '../../packages/web/server/lib/plans/routes.js';
import { registerConfigEntityRoutes } from '../../packages/web/server/lib/opencode/config-entity-routes.js';
import { listConfigAgents } from '../../packages/web/server/lib/opencode/agents.js';
import { isOwnedScratchPath } from './run-root.mjs';

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
const featureConfig = pathname => /^\/api\/config\//.test(pathname) && !['/api/config/providers', '/api/config/agents'].includes(pathname);
const providerReadFeature = req => req.method === 'GET'
  && (req.path === '/api/provider/auth' || /^\/api\/provider\/[^/]+\/source$/.test(req.path));

/** Disposable UI transport only. Original native binding and local host still
 * boot normally; no fixture ID, permit or receipt is offered to that owner. */
export async function createQaFixtureHostFacade({ fixture, realOrigin, workspace, dataDirectory, userConfigPath, runScope, sessionChanges }) {
  const upstream = loopback(realOrigin); loopback(fixture.origin);
  const cache=path.join(await fs.realpath(fileURLToPath(new URL('../../',import.meta.url))),'.cache');
  for (const directory of [workspace, dataDirectory, path.dirname(userConfigPath)]) {
    assert.equal(await fs.realpath(directory), directory);
    const relative=path.relative(cache,directory);
    assert.ok(relative && relative!=='..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)
      || isOwnedScratchPath(directory, { scope: runScope }));
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
  if (sessionChanges) {
    assert.ok(sessionChanges.host && typeof sessionChanges.host.handleRequest === 'function' && Array.isArray(sessionChanges.sessionIDs));
    sessionChanges.setPublisher?.((payload, directory) => hub.publishSyntheticEvent({ payload, directory }));
    const ownedSessions = new Set(sessionChanges.sessionIDs);
    app.use('/api/devryan/session/:sessionID/changes', express.json({ limit: '16kb' }), async (req, res) => {
      if (!ownedSessions.has(req.params.sessionID) || req.query.directory !== workspace)
        return res.status(403).json({ code: 'qa_fixture_scope_refused' });
      const result = await sessionChanges.host.handleRequest(req.method, req.originalUrl, req.body ?? {});
      return res.status(result.status).json(result.body);
    });
  }
  const features = express.Router();
  // This scoped identity is fixture evidence only, never a native settlement proof.
  registerSessionPlanRoutes(features, { dataDirectory, fsPromises: fs, path,
    readCanonicalPlanIdentity: async ({ sessionID, sourceMessageID, directory }) => {
      const plan = fixture.qaPlan;
      if (!plan) throw Object.assign(new Error('qa_fixture_plan_authority_unavailable'), { statusCode: 409, code: 'qa_fixture_plan_authority_unavailable' });
      if (directory !== workspace || sessionID !== plan.sessionID || sourceMessageID !== plan.sourceMessageID)
        throw Object.assign(new Error('qa_fixture_plan_scope_refused'), { statusCode: 404 });
      const [session, message] = await Promise.all([client.sessions.get(sessionID, { directory }), client.sessions.message(sessionID, sourceMessageID, { directory })]);
      if (session.id !== sessionID || message.info.id !== sourceMessageID || message.info.sessionID !== sessionID
        || message.info.role !== 'assistant' || message.info.parentID !== plan.wakeID || !message.info.time?.completed)
        throw Object.assign(new Error('qa_fixture_plan_source_changed'), { statusCode: 409 });
      const content = message.parts.filter(part => part.type === 'text').map(part => part.text).join('');
      const marker = '<!--plan-->'; const at = content.indexOf(marker);
      if (at < 0 || content.slice(at + marker.length).trim() !== plan.markdown.trim())
        throw Object.assign(new Error('qa_fixture_plan_source_changed'), { statusCode: 409 });
      return { sessionCreated: session.time.created, sessionSlug: session.slug, content: plan.markdown,
        sourceIdentity: { sessionID, sourceMessageID, rootUserMessageID: plan.rootUserID,
          memberUserMessageIDs: [...new Set([plan.rootUserID, plan.wakeID])], memberAssistantMessageIDs: [plan.sourceMessageID],
          currentSourceMessageID: sourceMessageID, successful: true, settled: true, current: true } };
    }, publishEvent: (payload, { directory }) => hub.publishSyntheticEvent({ payload, directory }) });
  // Archive uses the product client's serialized metadata/native-index contract,
  // but only for records actually owned by this disposable wire fixture.
  features.patch('/api/session/:sessionID', async (req, res, next) => {
    if (req.body?.time === undefined) return next();
    try {
      validateFacadeBody(req.body, ['time']);
      validateFacadeBody(req.body.time, ['archived']);
      const at = req.body.time.archived;
      if (!Number.isSafeInteger(at) || at < 0) return res.status(400).json({ code: 'qa_fixture_archive_invalid' });
      const session = fixture.wireSession(req.params.sessionID);
      if (!session) return res.status(404).json({ code: 'qa_fixture_session_not_found' });
      if (session.id !== req.params.sessionID || session.location?.directory !== workspace) return res.status(403).json({ code: 'qa_fixture_session_scope_invalid' });
      return res.json(await client.sessions.archive(req.params.sessionID, at, { directory: resolveDirectory(req) }));
    } catch (error) { return sendOpenCodeFacadeError(res, error); }
  });
  registerConfigEntityRoutes(features, { resolveProjectDirectory: async req => ({ directory: resolveDirectory(req) }),
    listConfigAgents: directory => listConfigAgents(directory, { userConfigPath, env: {},
      readOpenCodeConfig: () => JSON.parse(require('node:fs').readFileSync(userConfigPath, 'utf8')) }) });
  app.use((req, res, next) => {
    if (/^\/api\/session\/[^/]+\/plan-revisions\/[^/]+$/.test(req.path)
      || req.method === 'PATCH' && /^\/api\/session\/[^/]+$/.test(req.path)
      || req.path === '/api/config/agents') {
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
      if (sessionChanges) await sessionChanges.host.drain();
      assert.deepEqual(unexpected, [], 'Unexpected targeted wire facade routes'); } };
}
