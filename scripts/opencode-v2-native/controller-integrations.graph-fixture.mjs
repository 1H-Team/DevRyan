import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import http from 'node:http';
import {createHash} from 'node:crypto';
import {Model} from '@opencode/core/model';
import {createNativeProviderCompatibility} from '../../packages/web/server/lib/opencode/runtime-host/native-provider-compat-plugin.ts';
import { once } from 'node:events';
import { AsyncLocalStorage } from 'node:async_hooks';
import { Effect, Layer, Logger, Scope, Exit, Context, ErrorReporter } from 'effect';
import { assertNativeCatalog } from '../../packages/web/server/lib/opencode/runtime-host/startup-catalog.ts';
import { ServerFetch } from '../../packages/web/node_modules/@opencode/server/dist/fetch.js';
import { Global } from '@opencode/util/global';
import { LocationActivity } from '@opencode/core/location-activity';
import { LocationServiceMap } from '@opencode/core/location-service-map';
import { Integration } from '@opencode/core/integration';
import { Location } from '@opencode/core/location';
import { Database } from '@opencode/core/database/database';
import { createControllerIntegrations } from '../../packages/web/server/lib/opencode/runtime-host/controller-integrations.ts';
import { createNativeIntegrationOwner } from '../../packages/web/server/lib/opencode/runtime-host/native-integration-owner.js';
import { createNativeAdmissionOwner } from '../../packages/web/server/lib/opencode/runtime-host/native-admission-owner.js';
import { createRemoteNativeAdmissionBridge } from '../../packages/web/server/lib/opencode/runtime-host/native-admission-bridge.ts';
import { createAdmissionGates } from '../../packages/web/server/lib/opencode/runtime-host/admission-gates.ts';
import { nativeToolCatalogRoute } from '../../packages/web/server/lib/opencode/runtime-host/bootstrap.ts';
import { createReviewedNativePluginRegistry } from '../../packages/web/server/lib/opencode/runtime-host/native-plugin-registry.ts';
import { trustedPluginOverride } from '../../packages/web/server/lib/opencode/runtime-host/trusted-plugins.ts';
import { configurationOverridesForSnapshot } from '../../packages/web/server/lib/opencode/runtime-host/configuration.ts';
import { credentialMutationFingerprint as hash } from '../../packages/web/server/lib/opencode/runtime-host/native-credential-mutation-owner.js';
import { runWithRequestPermit } from '../../packages/web/server/lib/opencode/runtime-host/native-admission-contract.ts';
import { runWithIntegrationGrant } from '../../packages/web/server/lib/opencode/runtime-host/native-integration-context.ts';
import { runWithHostRefusal } from '../../packages/web/server/lib/opencode/runtime-host/host-refusal.ts';
import { createSessionMutationRuntime } from '../../packages/harness-runtime/lib/session-mutations.js';
import { createOpenCodeClient } from '../../packages/web/server/lib/opencode/opencode-client/index.js';
import { createOpenCodeAdmission } from '../../packages/web/server/lib/opencode/v2/admission.js';

const root = process.env.DEVRYAN_INTEGRATION_FIXTURE_ROOT;
assert.ok(root && path.isAbsolute(root) && root.startsWith(path.resolve('.cache/v2-validation') + path.sep));
const directories = [path.join(root, 'one'), path.join(root, 'two')];
for (const directory of directories) { await fs.mkdir(path.join(directory, '.git'), { recursive: true }); }
const globals = { home: process.env.HOME, config: process.env.XDG_CONFIG_HOME, data: process.env.XDG_DATA_HOME,
  state: process.env.XDG_STATE_HOME, cache: process.env.XDG_CACHE_HOME, tmp: process.env.TMPDIR,
  bin: path.join(process.env.HOME, 'bin'), log: path.join(process.env.HOME, 'log'), repos: path.join(process.env.HOME, 'repos') };
await Promise.all(Object.values(globals).map(value => fs.mkdir(value, { recursive: true })));
const callerContext = new AsyncLocalStorage(), caller = { active: true };
const ownedTokens = new Set(), kinds = new Set(), receipts = [], outstandingSockets = new Set();
const initialPhysicalKinds = new Set();
let releaseInitialPair, rejectInitialPair, initialPairTimer, initialPairFailure;
const initialPair = new Promise((resolve, reject) => { releaseInitialPair = resolve; rejectInitialPair = reject; });
const awaitInitialPhysicalPair = async kind => {
  if (initialPairFailure) throw initialPairFailure;
  if (initialPhysicalKinds.size === 2) return;
  assert.ok(['primary', 'title'].includes(kind), 'Initial physical request must be primary or title');
  assert.equal(initialPhysicalKinds.has(kind), false, 'Initial physical request kind must be unique');
  initialPhysicalKinds.add(kind);
  if (initialPhysicalKinds.size === 2) {
    clearTimeout(initialPairTimer); releaseInitialPair();
  } else initialPairTimer = setTimeout(() => {
    initialPairFailure = new Error('Initial primary and title physical requests did not both arrive');
    rejectInitialPair(initialPairFailure);
  }, 3_000);
  // Native title work is detached from drain. Keep the synthetic primary
  // response open until both real requests have passed original admission.
  await initialPair;
};
let nativeURL, ready = false, handler, map, accountRevision = 1, tokenRevision=0, refreshRequests=0, pollBarrier, pollObserved;
let queue = Promise.resolve();
const withMutationQueue = action => { const result = queue.then(action); queue = result.then(() => undefined, () => undefined); return result; };
const jwt = account => `fixture.${Buffer.from(JSON.stringify({jti:++tokenRevision, 'https://api.openai.com/auth': { chatgpt_account_id: account } })).toString('base64url')}.fixture`;
const nativeFetch = globalThis.fetch, NativeWebSocket=globalThis.WebSocket;
let wsReceipts=0;
const responsesEvents=(number,output)=>{ const message={id:`message_ws_${number}`,type:'message',role:'assistant',status:'completed',content:[{type:'output_text',text:output,annotations:[]}]}; const response={id:`response_ws_${number}`,object:'response',created_at:Math.floor(Date.now()/1000),model:'gpt-5.5',status:'completed',output:[message],usage:{input_tokens:10,output_tokens:5,total_tokens:15,input_tokens_details:{cached_tokens:0},output_tokens_details:{reasoning_tokens:0}}};return [{type:'response.created',response:{...response,status:'in_progress',output:[]}},{type:'response.output_item.added',output_index:0,item:{...message,content:[],status:'in_progress'}},{type:'response.content_part.added',item_id:message.id,output_index:0,content_index:0,part:{type:'output_text',text:'',annotations:[]}},{type:'response.output_text.delta',item_id:message.id,output_index:0,content_index:0,delta:output},{type:'response.output_text.done',item_id:message.id,output_index:0,content_index:0,text:output},{type:'response.output_item.done',output_index:0,item:message},{type:'response.completed',response}]; };
const wsServer=Bun.serve({hostname:'127.0.0.1',port:0,fetch(request,listener){assert.equal(new URL(request.url).pathname,'/backend-api/codex/responses');const headers=request.headers; if(listener.upgrade(request,{data:{authorization:headers.get('authorization'),account:headers.get('chatgpt-account-id')}}))return; return new Response(null,{status:400});},websocket:{message(socket,text){const frame=JSON.parse(String(text));assert.equal(frame.type,'response.create');wsReceipts++;receipts.push({route:'/backend-api/codex/responses',authorization:socket.data.authorization,account:socket.data.account,websocket:true,reasoningSummary:frame.reasoning?.summary});for(const event of responsesEvents(wsReceipts,'Owned native integration completion'))socket.send(JSON.stringify(event));}}});
globalThis.WebSocket=class extends NativeWebSocket {constructor(url,options){const target=new URL(url);assert.equal(target.protocol,'wss:');assert.equal(target.hostname,'chatgpt.com');super(`ws://127.0.0.1:${wsServer.port}${target.pathname}${target.search}`,options);}};
const transport = http.createServer(async (request, response) => {
  try {
    const chunks = []; let bytes = 0;
    for await (const chunk of request) { bytes += chunk.length; assert.ok(bytes <= 1024 * 1024); chunks.push(chunk); }
    const text = Buffer.concat(chunks).toString();
    const json = value => { response.writeHead(200, { 'content-type': 'application/json' }); response.end(JSON.stringify(value)); };
    if (request.url === '/api/accounts/deviceauth/usercode') return json({ device_auth_id: 'owned-device', user_code: 'owned-code', interval: '1' });
    if (request.url === '/api/accounts/deviceauth/token') { pollObserved?.(); if(pollBarrier)await pollBarrier; return json({ authorization_code: 'owned-authorized', code_verifier: 'owned-verifier' }); }
    if (request.url === '/oauth/token') { const form=new URLSearchParams(text), refresh=form.get('grant_type')==='refresh_token'; if(refresh)refreshRequests++; const revision=refresh?Number(form.get('refresh_token').split('-').at(-1)):accountRevision; return json({ access_token:jwt(`account-${revision}`), refresh_token:`owned-refresh-${revision}`, id_token:jwt(`account-${revision}`), expires_in:refresh?3600:1,token_type:'Bearer' }); }
    if (request.url?.endsWith('/responses')) {
      const body = JSON.parse(text); assert.equal(body.stream, true);
      const kind = request.headers['x-devryan-fixture-provider-kind'];
      receipts.push({ route: request.url, kind, authorization: request.headers.authorization, account: request.headers['chatgpt-account-id'],reasoningSummary:body.reasoning?.summary });
      const receiptNumber = receipts.length;
      try { await awaitInitialPhysicalPair(kind); }
      catch (error) { initialPairFailure ??= error; response.writeHead(500); response.end(); return; }
      const output = JSON.stringify(body).includes('structured summary') ? '## Objective\n- Owned fixture objective.\n\n## Requirements\n- Preserve native ownership.\n\n## Decisions\n- Use owned loopback.\n\n## Work State\n### Completed\n- Owned primary.\n### Active\n- Qualification.\n### Blocked\n- (none)\n\n## Next Move\n1. Continue.\n\n## Relevant Files\n- (none)\n\n## Important Context\n- (none)' : 'Owned native integration completion';
      const message = { id: `message_${receiptNumber}`, type: 'message', role: 'assistant', status: 'completed',
        content: [{ type: 'output_text', text: output, annotations: [] }] };
      const result = { id: `response_${receiptNumber}`, object: 'response', created_at: Math.floor(Date.now() / 1000), model: 'gpt-5.5', status: 'completed', output: [message],
        usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15, input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 0 } } };
      const events = [{ type: 'response.created', response: { ...result, status: 'in_progress', output: [] } },
        { type: 'response.output_item.added', output_index: 0, item: { ...message, content: [], status: 'in_progress' } },
        { type: 'response.content_part.added', item_id: message.id, output_index: 0, content_index: 0, part: { type: 'output_text', text: '', annotations: [] } },
        { type: 'response.output_text.delta', item_id: message.id, output_index: 0, content_index: 0, delta: output },
        { type: 'response.output_text.done', item_id: message.id, output_index: 0, content_index: 0, text: output },
        { type: 'response.output_item.done', output_index: 0, item: message }, { type: 'response.completed', response: result }];
      response.writeHead(200, { 'content-type': 'text/event-stream' }); response.end(events.map(value => `data: ${JSON.stringify(value)}\n\n`).join('')); return;
    }
    response.writeHead(404); response.end();
  } catch (error) { response.writeHead(500); response.end(); throw error; }
});
transport.on('connection', socket => { outstandingSockets.add(socket); socket.once('close', () => outstandingSockets.delete(socket)); });
transport.listen(0, '127.0.0.1'); await once(transport, 'listening');
const loopback = `http://127.0.0.1:${transport.address().port}`;
// Only the final physical transport is redirected. Native providers, hooks,
// official endpoint checks and original authorization remain unchanged.
globalThis.fetch = async (input, init) => {
  const request = new Request(input, init), url = new URL(request.url);
  if (['auth.openai.com', 'api.openai.com', 'chatgpt.com'].includes(url.hostname)) {
    assert.equal(url.protocol, 'https:');
    return nativeFetch(new Request(loopback + url.pathname + url.search, request));
  }
  if (url.hostname !== '127.0.0.1') throw new Error('external_network_forbidden');
  return nativeFetch(request);
};
const nativePlugins = createReviewedNativePluginRegistry('b'.repeat(64), { hostDigest: 'c'.repeat(64) });
const configuration = { model: 'openai/gpt-5.5', providers: { openai: { package: '@opencode/ai/providers/openai', env: [], headers: {authorization:'Bearer wrong-owned', 'chatgpt-account-id':'wrong-owned-account'}, settings: { transport: 'http' },
  models: { 'gpt-5.5': { capabilities: { tools: true, input: ['text'], output: ['text'] }, limit: { context: 32768, input: 16384, output: 4096 },settings:{reasoningEffort:'high',reasoningSummary:'auto'} },
  ...Object.fromEntries(['gpt-5.6-sol','gpt-5.6-luna-fast','gpt-5.3-codex-spark'].map(id=>[id,{capabilities:{tools:true,input:['text'],output:['text']},limit:{context:400000,input:272000,output:32000},settings:{reasoningEffort:'high',reasoningSummary:'auto'},variants:[{id:'none',settings:{reasoningEffort:'none'}},{id:'high',settings:{reasoningEffort:'high',reasoningSummary:'auto'}}]}])) } } },
  agents: { build: { mode: 'primary', model: 'openai/gpt-5.5' }, title: { model: 'openai/gpt-5.5' } } };
const snapshot = { schema: 1, revision: 1, sourceStamp: 'a'.repeat(64), digest: 'd'.repeat(64), registrationManifestDigest: 'c'.repeat(64),
  locations: directories.map((directory,index) => ({ directory, configuration:index===0?configuration:{...configuration,providers:{openai:{...configuration.providers.openai,settings:{transport:'websocket'}}}}, skills: [], instructions: [], textReferences: [], aliases: [], activePlugins: [],
    compatibility: { legacy: {}, agents: {}, commands: {}, slim: {}, mcp: {} }, requiredCatalogs: { agents: [], plugins: [], tools: [], models: [], skills: [], commands: [], mcp: [] } })) };
const runtime = createSessionMutationRuntime({ directory: path.join(root, 'ledger') });
const locks = new Map();
const lock = (id, action) => { const previous = locks.get(id) ?? Promise.resolve(); const result = previous.then(action); const settled = result.then(() => undefined, () => undefined); locks.set(id, settled); settled.finally(() => { if (locks.get(id) === settled) locks.delete(id); }); return result; };
const admissionOwner = createNativeAdmissionOwner({ runtime, directory: directories[0], ownerID: 'owned-integration-server',
  getSession: async id => { if (!nativeURL) return undefined; const response = await nativeFetch(`${nativeURL}/api/session/${id}`); if (!response.ok) return undefined;
    const responseBody = await response.json(); const session = responseBody.data ?? responseBody; return { ...session, directory: session.location.directory }; },
  withSessionLock: lock,
  captureWebAuthorization: async () => { const original = callerContext.getStore(); assert.equal(original, caller); return async () => { assert.equal(original.active, true); }; },
  authorizeOperation: async (request, session) => { assert.equal(caller.active, true); if (session) assert.ok(directories.includes(session.directory));
    if (request.operation === 'session.create') assert.ok(directories.includes(request.input.location.directory)); } });
const controller = { instanceID: 'owned_controller', call: async input => {
  if (input.action === 'credential-commit-owned') return factory.commitCredentialOwned(input);
  if (input.action === 'credential-operation-owned') return factory.credentialOwned(input);
  if (input.action === 'credential-metadata-owned') return factory.credentialMetadataOwned(input);
  if (input.action === 'openai-read-selected-owned') return factory.readSelectedOwned(input);
  if (input.action === 'openai-cas-selected-owned') return factory.compareAndSwapSelectedOwned(input);
  throw new Error('Unexpected owned controller action');
}, killAndWaitForExit: async () => { throw new Error('Transport failures require actual ServerFetch cleanup'); } };
const integrationOwner = createNativeIntegrationOwner({ instanceID: controller.instanceID, snapshot, stateDirectory: globals.state,
  controller: () => controller, isReady: () => ready, withMutationQueue, admissionOwner,
  captureWebAuthorization: async operation => { const original = callerContext.getStore(); assert.equal(original, caller); assert.ok(directories.includes(operation.directory));
    return async () => { if (!original.active) throw Object.assign(new Error('fixture_original_caller_revoked'), {code:'fixture_original_caller_revoked',statusCode:403}); }; } });
const rpc = async (method, input, context) => {
  if (method.startsWith('native.admission.')) { await fs.appendFile(path.join(root,'admissions.jsonl'),JSON.stringify({method,operation:input?.operation,sessionID:input?.sessionID})+'\n'); let result; try { result = await admissionOwner.handleRpc(method, input); } catch(error){ await fs.appendFile(path.join(root,'rpc-errors.jsonl'),JSON.stringify({method,operation:input?.operation,code:error.code,message:error.message})+'\n'); throw error; } if (method === 'native.admission.authorize') ownedTokens.add(result.token); return result; }
  if (method === 'openai.attempt' || method === 'openai.access') { assert.ok(ownedTokens.has(input.permit.token)); kinds.add(input.kind); }
  try { return await integrationOwner.handleRpc(method, input, context); } catch (error) { await fs.appendFile(path.join(root, 'rpc-errors.jsonl'), JSON.stringify({method, kind:input?.kind, code:error.code, message:error.message})+'\n'); throw error; }
};
const bridge = createRemoteNativeAdmissionBridge({ rpc });
const factory = createControllerIntegrations({ controllerInstanceID: controller.instanceID, configurationSnapshot: snapshot, rpc,
  registrationOrigin: nativePlugins.get('devryan.remote-mcp'), reviewedConfigurationOrigins: new Map([...nativePlugins].filter(([id]) => ['opencode.config.mcp', 'opencode.mcp.codemode.defaults', 'opencode.provider.opencode'].includes(id))),
  isBound: () => Boolean(nativeURL), isExecutionReady: () => ready, executeOwnedFallback: () => Effect.die(new Error('Unexpected executable tool')),
  authorizeMcpCall: (_invocation, _binding, action) => action });
const gates = createAdmissionGates({ bridge, nativePlugins, providerHooks: inner => { const actual=factory.providerHooks(inner); return {...actual,trigger:(domain,name,event)=>actual.trigger(domain,name,event).pipe(Effect.tap(result=>Effect.promise(async()=>{
  if(domain==='session'&&name==='http.request'){
    assert.ok(['primary','title','compaction','generate'].includes(result.kind));
    const headers=new Headers(result.request.headers);headers.set('x-devryan-fixture-provider-kind',result.kind);
    result.request=new Request(result.request,{headers});
  }
  await fs.appendFile(path.join(root,'hooks.jsonl'),JSON.stringify({domain,name,...typeof result?.kind==='string'?{kind:result.kind}:{}})+'\n');
})),Effect.onError(cause=>Effect.promise(()=>fs.appendFile(path.join(root,'hooks.jsonl'),JSON.stringify({domain,name,failed:true,reasons:cause.reasons.map(reason=>({tag:reason._tag,code:(reason.error??reason.defect)?.code,name:(reason.error??reason.defect)?.name}))})+'\n'))))}; },
  executeOwned: () => Effect.die(new Error('Unexpected executable tool')) });
const reportCause=ErrorReporter.make(({cause})=>{ const rows=cause.reasons.map(reason=>{const error=reason.error??reason.defect;return {tag:reason._tag,name:error?.name,code:error?.code,message:typeof error?.message==='string'?error.message.replace(/fixture\.[A-Za-z0-9_-]+\.fixture/g,'[fixture-token]').replace(/owned-refresh-[0-9]+/g,'[fixture-refresh]'):undefined,frames:error?.stack?.split('\n').slice(1)};}); fs.appendFile(path.join(root,'reported-causes.jsonl'),JSON.stringify(rows)+'\n'); });
const httpContext=Context.make(ErrorReporter.CurrentErrorReporters,new Set([reportCause])).pipe(Context.add(Logger.CurrentLoggers,new Set()));
const scope = Effect.runSync(Scope.make()); let server;
const options = { database: { path: path.join(globals.data, 'native.db') }, config: { project: false }, events: { persist: false }, fs: { filewatcher: false, fff: false }, models: { fetch: false, snapshot: false }, simulation: false };
const compatibility=createNativeProviderCompatibility({policyForDirectory:()=>({compactionReserved:7500})});
const compatibilityOrigin={kind:'plugin',id:'devryan.provider-compat',manifestDigest:createHash('sha256').update(await fs.readFile(new URL('../../packages/web/server/lib/opencode/runtime-host/native-provider-compat-plugin.ts',import.meta.url))).digest('hex'),capabilities:['provider']};
let result, primaryFailure;
try {
  handler = await Effect.runPromise(ServerFetch.make(options, { overrides: [Global.node.replace(Global.layerWith(globals)), ...configurationOverridesForSnapshot(snapshot),
    Database.node.replace(Database.configured({ path: options.database.path }).mapLayer(gates.captureDatabase)),
    ...factory.overrides,...compatibility.overrides, trustedPluginOverride({ plugins: [{plugin:compatibility.plugin,origin:compatibilityOrigin}], additionalOrigins: [], nativePlugins }), ...gates.overrides,
    LocationActivity.node.replace(LocationActivity.node.mapLayer(original => Layer.effect(LocationActivity.Service, Effect.gen(function* () {
      const value = yield* LocationActivity.Service; map = yield* LocationServiceMap.Service; return value;
    })).pipe(Layer.provide(original))))] }).pipe(Scope.provide(scope),Effect.provideService(ErrorReporter.CurrentErrorReporters,new Set([reportCause])), Effect.provide(Logger.layer([Logger.make(entry => {
      const summary=value=>{ if(!value||typeof value!== 'object')return undefined; return {keys:Object.keys(value),tag:value._tag,name:value.name,code:value.code,cause:summary(value.cause),error:summary(value.error),event:summary(value.event),data:summary(value.data),type:value.type,
        message:typeof value.message==='string'?value.message.replace(/fixture\.[A-Za-z0-9_-]+\.fixture/g,'[fixture-token]').replace(/owned-refresh-[0-9]+/g,'[fixture-refresh]'):undefined,
        reasons:value.reasons?.map(reason=>summary(reason.error??reason.defect))}; };
      const rows={cause:summary(entry.cause),messages:Array.isArray(entry.message)?entry.message.map(summary):summary(entry.message)};
      if(rows.cause?.reasons?.length||rows.messages)fs.appendFile(path.join(root,'native-causes.jsonl'),JSON.stringify(rows)+'\n');
    })], { mergeWithExisting: false }))));
  const catalog = await assertNativeCatalog({ directories, requirements: { agents: ['build'], plugins: [], tools: [], models: [{ providerID: 'openai', id: 'gpt-5.5' }] }, handler, tools: gates.controls.catalogTools });
  assert.equal(catalog.asserted, true);
  const savedSelections = [
    { source: { kind: 'agent', id: 'builder' }, providerID: 'openai', modelID: 'missing-saved-model', variant: 'high' },
    { source: { kind: 'backup', id: 'builder' }, providerID: 'openai', modelID: 'gpt-5.5', variant: 'unsupported' },
    { source: { kind: 'councillor', id: 'council', index: 0 }, providerID: 'cursor-acp', modelID: 'composer-2.5', variant: 'high' },
  ];
  const routeAvailability = await assertNativeCatalog({ directories,
    requirements: { agents: ['build'], plugins: [], tools: [], models: [], selections: savedSelections },
    handler, tools: gates.controls.catalogTools,
    cursorCatalog: { id: 'cursor-acp', models: [{ id: 'composer-2.5', variants: [] }] },
  });
  assert.equal(routeAvailability.asserted, true, 'Saved route availability must not invalidate native startup integrity');
  assert.deepEqual(routeAvailability.availability.selections, directories.flatMap(directory => [
    { directory, ...savedSelections[0], status: 'unavailable', reason: 'model_missing' },
    { directory, ...savedSelections[1], status: 'unavailable', reason: 'variant_missing' },
    { directory, ...savedSelections[2], status: 'unknown', reason: 'catalog_unavailable' },
  ]));
  const brokenIntrinsic = await assertNativeCatalog({ directories,
    requirements: { agents: ['missing-intrinsic-agent'], plugins: ['missing-intrinsic-plugin'], tools: ['missing-intrinsic-tool'], models: [] },
    handler, tools: gates.controls.catalogTools,
  });
  assert.equal(brokenIntrinsic.asserted, false);
  assert.deepEqual(brokenIntrinsic.missing.agents, ['missing-intrinsic-agent']);
  assert.deepEqual(brokenIntrinsic.missing.plugins, ['missing-intrinsic-plugin']);
  assert.deepEqual(brokenIntrinsic.missing.tools, ['missing-intrinsic-tool']);

  server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: async request => { const outcome = await runWithHostRefusal(() => runWithRequestPermit(request.headers,
    () => runWithIntegrationGrant(request.headers, () => new URL(request.url).pathname === '/devryan/tools'
      ? nativeToolCatalogRoute(request,gates.controls.catalogToolSnapshot,directories) : handler(request,httpContext)))); return outcome.ok ? outcome.value : Response.json({code:outcome.refusal.code}, {status:outcome.refusal.status}); } }); nativeURL = `http://127.0.0.1:${server.port}`;
  await gates.controls.openStartup(); ready = true; integrationOwner.markReady();
  const call = async (directory, route, method = 'GET', body, headers = {}) => {
    const response = await nativeFetch(nativeURL + route, { method, headers: { 'x-opencode-directory': encodeURIComponent(directory),
      'content-type': 'application/json', ...headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const text=await response.text(), value=text?JSON.parse(text):null; assert.ok(response.ok, `${route}: ${response.status} ${JSON.stringify(value)}`); return value?.location && Object.hasOwn(value, 'data') ? value.data : value;
  };
  const info = await call(directories[0], '/api/integration/openai');
  const methodID = info.methods.find(method => method.id === 'chatgpt-headless').id;
  const operation = (directory, action, attemptID) => ({ kind: 'openai', directory, integrationID: 'openai', configurationDigest: hash(snapshot.locations.find(row=>row.directory===directory).configuration.providers.openai),
    operation: `openai.oauth.${action}`, method: 'POST', path: `/api/integration/openai/connect/oauth${attemptID ? `/${attemptID}/complete` : ''}`,
    ...(action === 'start' ? { methodID, body: { methodID } } : { attemptID, methodID, body: {} }) });
  const start = directory => callerContext.run(caller, () => integrationOwner.withCallerOperation(operation(directory, 'start'), () => call(directory,
    '/api/integration/openai/connect/oauth', 'POST', { methodID }, integrationOwner.requestHeaders())));
  const complete = (directory, attemptID) => callerContext.run(caller, () => integrationOwner.withCallerOperation(operation(directory, 'complete', attemptID), () => call(directory,
    `/api/integration/openai/connect/oauth/${attemptID}/complete`, 'POST', {}, integrationOwner.requestHeaders())));
  const waitOAuth = async (directory, attemptID) => { const end=Date.now()+10_000; while(Date.now()<end){ const value=await call(directory, `/api/integration/openai/connect/oauth/${attemptID}`); if(value.status === 'complete') return; assert.notEqual(value.status,'failed'); await new Promise(resolve=>setTimeout(resolve,10)); } throw new Error('Native OAuth callback did not commit'); };
  const first = await start(directories[0]); await waitOAuth(directories[0],first.attemptID); await complete(directories[0], first.attemptID);
  assert.equal((await call(directories[0], '/api/integration/openai')).connections.some(row => row.method === 'oauth'), true);
  await call(directories[1], '/api/integration/openai');
  const second = await start(directories[1]); await waitOAuth(directories[1],second.attemptID); await complete(directories[1], second.attemptID);
  result = { integrationLocations: 2, nativeOAuthCommit: true, revokedAttemptRefused: false, closedHandlesRefused: false,
    providerKinds: [], physicalReceipts: 0, permitsWereOwned: true };
  // Provider lanes are added only through actual native Session services below.
  const deps = { getRuntime: () => ({ generation: 2, version: '2.0.20', baseUrl: nativeURL, epoch: 1 }), getAuthHeaders: () => admissionOwner.requestHeaders(),
    withNativeWebOperation: (spec, action) => admissionOwner.withWebOperation(spec, action) };
  const admission = createOpenCodeAdmission(deps, { nativeOwner: admissionOwner });
  const client = createOpenCodeClient({ ...deps, getAdmission: () => admission });
  const session = await callerContext.run(caller, () => client.sessions.create({ model: { providerID: 'openai', modelID: 'gpt-5.5' } }, { directory: directories[0] }));
  await callerContext.run(caller, () => client.prompts.prompt(session.id, { agent: 'build', model: { providerID: 'openai', modelID: 'gpt-5.5' }, parts: [{ type: 'text', text: 'Owned native primary prompt' }] }, { directory: directories[0] }));
  const end = Date.now() + 20_000;
  let completed=false;
  while(Date.now()<end){ const page=await client.sessions.messages(session.id,{directory:directories[0]}); completed=page.records.some(row=>row.info.role==='assistant'&&row.info.time.completed); if(completed)break; await new Promise(resolve=>setTimeout(resolve,10)); }
  assert.equal(completed,true,'Actual primary assistant did not settle');
  if (initialPairFailure) throw initialPairFailure;
  const messages = await client.sessions.messages(session.id, {directory: directories[0]}); await fs.writeFile(path.join(root,'messages.json'), JSON.stringify(messages));
  await fs.writeFile(path.join(root,'receipt-count.json'), JSON.stringify({receipts:receipts.length,kinds:[...kinds]}));
  assert.ok(kinds.has('primary'), 'Actual primary physical transport did not run');
  const titleEnd=Date.now()+3_000; while(Date.now()<titleEnd&&receipts.length<2)await new Promise(resolve=>setTimeout(resolve,10));
  assert.equal(receipts.length,2,'Native title and primary must both reach actual physical transport');
  assert.deepEqual(receipts.map(receipt=>receipt.kind).sort(),['primary','title']);
  const current=await factory.readSelectedOwned({directory:directories[0]});
  assert.equal(current.value.type,'oauth'); assert.ok(refreshRequests>=1,'Physical attempt must refresh expiring credential through the actual shared queue');
  for(const receipt of receipts){assert.equal(receipt.authorization,`Bearer ${current.value.access}`);assert.equal(receipt.account,current.value.metadata.accountID);assert.equal(receipt.route,'/backend-api/codex/responses');}
  const generatePermit=await admissionOwner.handleRpc('native.admission.authorize',{operation:'execution.resume',sessionID:session.id});ownedTokens.add(generatePermit.token);
  const generateBefore=receipts.length;
  try { const generated=await call(directories[0],`/api/session/${session.id}/generate`,'POST',{prompt:'Owned native generation'},{'x-devryan-native-permit':JSON.stringify(generatePermit)});assert.equal(generated.data.text,'Owned native integration completion'); }
  finally { await admissionOwner.handleRpc('native.admission.release',generatePermit); }
  assert.equal(receipts.length,generateBefore+1);assert.ok(kinds.has('generate'));
  const compactBefore=receipts.length;
  await callerContext.run(caller,()=>client.prompts.compact(session.id,{}, {directory:directories[0]}));
  const compactEnd=Date.now()+10_000;while(Date.now()<compactEnd&&(!kinds.has('compaction')||receipts.length===compactBefore))await new Promise(resolve=>setTimeout(resolve,10));
  assert.ok(kinds.has('compaction'));assert.equal(receipts.length,compactBefore+1);
  let compactCommitted=false;const summaryEnd=Date.now()+10_000;while(Date.now()<summaryEnd){const page=await client.sessions.messages(session.id,{directory:directories[0]});const summary=page.records.find(row=>row.info.summary&&row.info.time.completed);if(summary){assert.equal(summary.info.finish,'stop');assert.equal(summary.info.error,undefined);assert.ok(summary.parts.some(part=>part.type==='text'&&part.text.includes('## Objective')));compactCommitted=true;break;}await new Promise(resolve=>setTimeout(resolve,10));}assert.equal(compactCommitted,true);
  const wsSession=await callerContext.run(caller,()=>client.sessions.create({model:{providerID:'openai',modelID:'gpt-5.5'}},{directory:directories[1]}));
  await callerContext.run(caller,()=>client.prompts.prompt(wsSession.id,{agent:'build',model:{providerID:'openai',modelID:'gpt-5.5'},parts:[{type:'text',text:'Owned native WS primary'}]},{directory:directories[1]}));
  let wsCompleted=false;const wsEnd=Date.now()+10_000;while(Date.now()<wsEnd){const page=await client.sessions.messages(wsSession.id,{directory:directories[1]});if(page.records.some(row=>row.info.role==='assistant'&&row.info.time.completed)){wsCompleted=true;break;}await new Promise(resolve=>setTimeout(resolve,10));}assert.equal(wsCompleted,true);assert.ok(wsReceipts>0,'Actual native WebSocket physical frame required');
  const wsCurrent=await factory.readSelectedOwned({directory:directories[1]});for(const receipt of receipts.filter(row=>row.websocket)){assert.equal(receipt.authorization,`Bearer ${wsCurrent.value.access}`);assert.equal(receipt.account,wsCurrent.value.metadata.accountID);}
  // Actual global account activation must supersede stale location provider headers.
  accountRevision=2;
  const changed=await start(directories[0]);await waitOAuth(directories[0],changed.attemptID);
  const changeBefore=receipts.length;
  const changePermit=await admissionOwner.handleRpc('native.admission.authorize',{operation:'execution.resume',sessionID:session.id});ownedTokens.add(changePermit.token);
  try {await call(directories[0],`/api/session/${session.id}/generate`,'POST',{prompt:'Owned changed account'},{'x-devryan-native-permit':JSON.stringify(changePermit)});}finally{await admissionOwner.handleRpc('native.admission.release',changePermit);}
  assert.equal(receipts.length,changeBefore+1);const changedReceipt=receipts.at(-1),changedCredential=await factory.readSelectedOwned({directory:directories[0]});
  assert.equal(changedReceipt.account,'account-2');assert.equal(changedReceipt.authorization,`Bearer ${changedCredential.value.access}`);
  // Revoke the original browser principal while native automatic OAuth awaits the issuer.
  let releasePoll,observedPoll;pollBarrier=new Promise(resolve=>{releasePoll=resolve;});const observed=new Promise(resolve=>{observedPoll=resolve;});pollObserved=observedPoll;
  const countBefore=(await factory.credentialMetadataOwned({directory:directories[0],integrationID:'openai'})).length;
  const revoked=await start(directories[0]);await observed;caller.active=false;releasePoll();pollBarrier=undefined;pollObserved=undefined;
  const revokedEnd=Date.now()+5_000;let revokedSeen=false;while(Date.now()<revokedEnd){const failures=(await fs.readFile(path.join(root,'rpc-errors.jsonl'),'utf8')).trim().split('\n').filter(Boolean).map(row=>JSON.parse(row));if(failures.some(row=>row.method==='integration.reauthorize'&&row.code==='fixture_original_caller_revoked')){revokedSeen=true;break;}await new Promise(resolve=>setTimeout(resolve,10));}
  assert.equal(revokedSeen,true,'Original grant must be rechecked after issuer response');
  assert.equal((await factory.credentialMetadataOwned({directory:directories[0],integrationID:'openai'})).length,countBefore);result.revokedAttemptRefused=true;caller.active=true;
  // Capture real location services, reload the HTTP application, then exercise the old handle.
  const at=(directory,effect)=>Effect.runPromise(effect.pipe(Effect.provide(map.get({directory})),Effect.provideService(LocationServiceMap.Service,map),Effect.provide(Logger.layer([],{mergeWithExisting:false}))));
  const verifyModels=async()=>{for(const directory of directories){const models=await at(directory,Effect.gen(function*(){const service=yield* Model.Service;return yield* service.all();}));const sol=models.find(model=>model.id==='gpt-5.6-sol');assert.ok(sol);assert.equal(sol.limit.context,1050000);assert.equal(sol.limit.input,263500);assert.ok(sol.variants.some(variant=>variant.id==='max'));assert.ok(sol.variants.some(variant=>variant.id==='ultra'));assert.equal(sol.variants.some(variant=>variant.id==='none'),false);const spark=models.find(model=>model.id==='gpt-5.3-codex-spark');assert.ok(spark);assert.equal(Object.hasOwn(spark.settings??{},'reasoningSummary'),false);}};
  const verifyToolModel = async (directory,providerID,modelID) => {
    const catalog=await call(directory,'/devryan/tools?'+new URLSearchParams({directory,providerID,modelID}));
    assert.ok(Array.isArray(catalog.ids));assert.ok(Array.isArray(catalog.definitions));
    assert.deepEqual(catalog.definitions.map(row=>row.id),catalog.ids);
  };
  for(const directory of directories)await verifyToolModel(directory,'openai','gpt-5.6-sol');
  await verifyModels();
  const old=await at(directories[0],Integration.Service);
  const oldModels=await at(directories[0],Model.Service);
  await call(directories[0],'/api/location/reload','POST');
  await assert.rejects(Effect.runPromise(oldModels.all()),/native_provider_location_expired/);
  await assert.rejects(Effect.runPromise(oldModels.get('openai','missing-model')),/native_provider_location_expired/);
  await assert.rejects(()=>Effect.runPromise(old.oauth.status({integrationID:'openai',attemptID:first.attemptID})),/native_openai_location_expired/);
  const freshCatalog=await assertNativeCatalog({directories,requirements:{agents:['build'],plugins:[],tools:[],models:[{providerID:'openai',id:'gpt-5.5'}]},handler,tools:gates.controls.catalogTools});assert.equal(freshCatalog.asserted,true);
  assert.equal((await call(directories[0],'/api/integration/openai')).connections.length,countBefore);result.closedHandlesRefused=true;
  const afterReload=await start(directories[1]);await waitOAuth(directories[1],afterReload.attemptID);
  await verifyModels();
  assert.ok(receipts.some(receipt=>receipt.reasoningSummary==='detailed'),'Actual final provider payload must contain the preserved detailed-summary policy');
  result.providerCompatibility=true;
  result.providerKinds = [...kinds].sort(); result.physicalReceipts = receipts.length;
  result.websocketReceipts=wsReceipts;result.refreshedCredential=true;result.accountChange=true;
  assert.deepEqual(result.providerKinds,['compaction','generate','primary','title']);
} catch (error) { primaryFailure = error; throw error; } finally {
  clearTimeout(initialPairTimer);
  const failures = [];
  const cleanup = async action => { try { await action(); } catch (error) { failures.push(error); } };
  await cleanup(() => gates.controls.quiesce());
  ready = false;
  await cleanup(() => Effect.runPromise(Scope.close(scope, Exit.void)));
  await cleanup(() => server?.stop(true));
  await cleanup(() => factory.close()); await cleanup(() => integrationOwner.invalidate());
  await cleanup(() => runtime.drain()); await cleanup(() => admissionOwner.invalidateController());
  await cleanup(() => admissionOwner.dispose());
  for (const socket of outstandingSockets) socket.destroy();
  await cleanup(() => new Promise(resolve => transport.close(resolve)));await cleanup(()=>wsServer.stop(true));
  if (failures.length) throw new AggregateError([...(primaryFailure ? [primaryFailure] : []), ...failures], 'Owned fixture and cleanup failures');
}
console.log(JSON.stringify(result));
