import fs from 'node:fs/promises';
import { timingSafeEqual } from 'node:crypto';
import { Effect, Exit, Layer, Logger, Schema, SchemaRepresentation, Scope } from 'effect';
import { LLM, LLMClient } from '@opencode/ai';
import { ServerFetch } from '@opencode/server/fetch';
import { llmClient } from '@opencode/core/effect/app-node-platform';
import { Credential } from '@opencode/core/credential';
import { Integration } from '@opencode/core/integration';
import { Location } from '@opencode/core/location';
import { ModelResolver } from '@opencode/core/model-resolver';
import { Permission } from '@opencode/core/permission';
import { SdkPlugins } from '@opencode/core/plugin/sdk';
import { Plugin as CorePlugin } from '@opencode/core/plugin';
import { Model } from '@opencode/schema/model';
import { PromptInput } from '@opencode/schema/prompt-input';
import { Session } from '@opencode/schema/session';
import { SessionMessage } from '@opencode/schema/session-message';
import { Tool } from '@opencode/schema/tool';
import { Plugin } from '@opencode/plugin/effect';
import { tool } from '@opencode-ai/plugin/tool';
import { __test as gateway } from '../../../../bots-runtime/opencode/devryan-bot-tools.mjs';
import oauthPlugin from '../../default-config/plugins/devryan-openai-oauth.mjs';
import { projectNativeSetupCredentials } from '../opencode/runtime-host/native-setup-credential-data.js';
import { nativeModelCatalogOverride } from '../opencode/runtime-host/native-model-catalog.ts';
import { installNativeBotToolPolicy } from './native-tool-policy.js';
import { createBotNativeImageTool } from './native-image-tool.mjs';

const REQUEST_LIMIT = 512 * 1024;
const invalid = () => Object.assign(new Error('bot_native_request_invalid'), { status: 400 });
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const decode = (schema, input) => Schema.decodeUnknownSync(schema)(input, { onExcessProperty: 'error' });
const promptSchema = Schema.Struct({ sessionID: Session.ID, model: Model.Ref, prompt: Schema.Struct({
  ...PromptInput.Prompt.fields, id: SessionMessage.ID, delivery: Schema.Literal('queue'),
  metadata: Schema.Record(Schema.String, Schema.Unknown),
}) });

async function readJson(request) {
  if (!request.body) throw invalid();
  const reader = request.body.getReader(), chunks = [];
  let size = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > REQUEST_LIMIT) throw invalid();
      chunks.push(value);
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } finally { await reader.cancel().catch(() => {}); }
}

export function botNativeAuthorized(header, token) {
  const expected = Buffer.from(`Bearer ${token}`), supplied = Buffer.from(header || '');
  return supplied.length === expected.length && timingSafeEqual(supplied, expected);
}

/** A Bot container has one immutable revision, one workspace, and one run capability. */
export async function createBotNativeServer({
  directory = '/workspace', configDirectory = '/runtime-config', databasePath = '/data/opencode/bot-v2.db',
  authPath = '/data/opencode/auth.json', environment = process.env, imageToolFactory,
  // Deterministic tests substitute native graph services, never live credentials/providers.
  overrides: testOverrides = [],
} = {}) {
  const capability = gateway.validateEnvironment(environment);
  const rawAuth = await fs.readFile(authPath, 'utf8');
  if (Buffer.byteLength(rawAuth) > 256 * 1024) throw invalid();
  const auth = JSON.parse(rawAuth);
  const openaiOAuth = record(auth?.openai) && auth.openai.type === 'oauth';
  const access = oauthPlugin.testing.createAccessClient(environment);
  if (openaiOAuth) {
    if (auth.openai.refresh !== '' || typeof auth.openai.accountId !== 'string' || !auth.openai.accountId) throw invalid();
    const ready = await access('ready');
    if (!ready.oauth) throw new Error('bot_opencode_provider_authentication');
    const current = await access('access');
    if (current.accountId !== auth.openai.accountId) throw new Error('bot_opencode_provider_authentication');
    auth.openai = { ...auth.openai, access: current.accessToken, expires: current.expiresAt };
  }
  const projected = projectNativeSetupCredentials(auth);
  const tools = (await gateway.createPlugin({ toolApi: tool, environment,
    imageToolFactory: imageToolFactory ?? (() => createBotNativeImageTool({ directory, access })),
  })).tool;
  let context, resolver, client, nativePlugins, nativePermission, ready = false, closing;
  const managedOpenaiCredentials = new Set();
  const scope = await Effect.runPromise(Scope.make());
  const pending = new Set();
  const run = (effect, signal) => {
    const result = Effect.runPromise(effect, { signal });
    pending.add(result);
    void result.finally(() => pending.delete(result)).catch(() => {});
    return result;
  };
  const plugin = Plugin.define({ id: 'devryan.bot', effect: current => Effect.gen(function* () {
    if (current.location.directory !== directory) return yield* Effect.die(invalid());
    context = current;
    yield* Effect.addFinalizer(() => Effect.sync(() => { if (context === current) context = undefined; }));
    if (!nativePermission) return yield* Effect.die(new Error('bot_native_permission_unavailable'));
    const permission = nativePermission;
    yield* current.tool.transform(editor => {
      installNativeBotToolPolicy(editor, permission);
      for (const [name, original] of Object.entries(tools)) editor.add({ name, description: original.description,
        input: tool.schema.object(original.args), options: { codemode: false },
        execute: (input, native) => permission.assert({ action: name, resources: ['*'], save: ['*'],
          sessionID: native.sessionID, agent: native.agent,
          source: { type: 'tool', messageID: native.messageID, id: native.id },
        }).pipe(Effect.andThen(() => Effect.callback((resume, signal) => {
          const work = Promise.resolve().then(() => original.execute(input, {
            abort: signal, callID: native.id, sessionID: native.sessionID, messageID: native.messageID,
            agent: native.agent, directory, worktree: directory,
          }));
          work.then(value => resume(Effect.succeed(value)), error => resume(Effect.fail(new Tool.Error({
            message: error instanceof Error ? error.message : 'bot_tool_failed',
          }))));
          // Native interruption waits for the gateway/image transport to release its resources.
          return Effect.promise(() => work.then(() => {}, () => {}));
        })))
          .pipe(Effect.map(value => typeof value === 'string' ? { content: value }
            : record(value) && typeof value.output === 'string'
              ? { content: value.output, ...(record(value.metadata) ? { metadata: value.metadata } : {}) }
              : { content: JSON.stringify(value) })),
      });
    });
  }) });
  const overrides = [
    nativeModelCatalogOverride(),
    Permission.node.replace(Permission.node.mapLayer(layer => Layer.effect(Permission.Service, Effect.gen(function* () {
      const service = yield* Permission.Service;
      nativePermission = service;
      yield* Effect.addFinalizer(() => Effect.sync(() => { if (nativePermission === service) nativePermission = undefined; }));
      return service;
    })).pipe(Layer.provide(layer)))),
    CorePlugin.node.replace(CorePlugin.node.mapLayer(layer => Layer.effect(CorePlugin.Service, Effect.gen(function* () {
      nativePlugins = yield* CorePlugin.Service;
      return nativePlugins;
    })).pipe(Layer.provide(layer)))),
    SdkPlugins.node.replace(SdkPlugins.node.mapLayer(layer => Layer.effect(SdkPlugins.Service, Effect.gen(function* () {
      const service = yield* SdkPlugins.Service;
      yield* service.register(plugin);
      return service;
    })).pipe(Layer.provide(layer)))),
    Credential.node.replace(Credential.node.mapLayer(layer => Layer.effect(Credential.Service, Effect.gen(function* () {
      const service = yield* Credential.Service;
      for (const row of projected.credentials) {
        const value = decode(Credential.Value, row.value);
        const existing = yield* service.list(row.integrationID);
        // The mount is the run owner's selected credential; container restart reuses its native row.
        if (existing.length > 1) return yield* Effect.die(new Error('bot_native_credential_conflict'));
        if (existing.length) { yield* service.update(existing[0].id, { value }); yield* service.activate(existing[0].id); }
        const created = existing[0] ?? (yield* service.create({ ...row, value, activate: true }));
        if (row.integrationID === 'openai' && value.type === 'oauth') managedOpenaiCredentials.add(created.id);
      }
      return service;
    })).pipe(Layer.provide(layer)))),
    Integration.node.replace(Integration.node.mapLayer(layer => Layer.effect(Integration.Service, Effect.gen(function* () {
      const service = yield* Integration.Service;
      return { ...service, connection: { ...service.connection, resolve: connection => {
        if (!openaiOAuth || connection.type !== 'credential' || !managedOpenaiCredentials.has(connection.id)) return service.connection.resolve(connection);
        // Refresh remains exclusively owned by the host coordinator, including after native restart.
        return Effect.tryPromise({ try: signal => access('access', { signal }),
          catch: () => new Integration.AuthorizationError({ cause: new Error('bot_opencode_provider_authentication') }) })
          .pipe(Effect.map(value => ({ type: 'oauth', methodID: 'chatgpt-browser', access: value.accessToken,
            refresh: '', expires: value.expiresAt, metadata: { accountID: value.accountId } })));
      } } };
    })).pipe(Layer.provide(layer)))),
    ModelResolver.node.replace(ModelResolver.node.mapLayer(layer => Layer.effect(ModelResolver.Service, Effect.gen(function* () {
      const service = yield* ModelResolver.Service, location = yield* Location.Service;
      if (location.directory !== directory) return yield* Effect.die(invalid());
      resolver = service;
      yield* Effect.addFinalizer(() => Effect.sync(() => { if (resolver === service) resolver = undefined; }));
      return service;
    })).pipe(Layer.provide(layer)))),
    llmClient.replace(llmClient.mapLayer(layer => Layer.effect(LLMClient.Service, Effect.gen(function* () {
      client = yield* LLMClient.Service;
      return client;
    })).pipe(Layer.provide(layer)))),
    ...testOverrides,
  ];
  const lifetime = new AbortController();
  const close = () => closing ??= (async () => {
    ready = false;
    lifetime.abort();
    await Promise.allSettled([...pending]);
    await Effect.runPromise(Scope.close(scope, Exit.void));
  })();
  try {
    const handler = await Effect.runPromise(ServerFetch.make({ database: { path: databasePath },
      config: { directory: configDirectory, file: `${configDirectory}/opencode.json`, project: false },
      models: { fetch: false, snapshot: false }, events: { persist: true },
      fs: { fff: false, filewatcher: false }, app: { name: 'DevRyan Bot', version: '2.0.20' },
    }, { overrides }).pipe(Scope.provide(scope), Effect.provide(Logger.layer([], { mergeWithExisting: false }))));
    const agentProbe = await handler(new Request('http://localhost/api/agent', { headers: { 'x-opencode-directory': encodeURIComponent(directory) } }));
    if (!agentProbe.ok) throw new Error('bot_native_agent_unavailable');
    await agentProbe.body?.cancel();
    if (!nativePlugins) throw new Error('bot_native_plugins_unavailable');
    await run(nativePlugins.awaitActivation, lifetime.signal);
    const probe = await handler(new Request('http://localhost/api/model', { headers: { 'x-opencode-directory': encodeURIComponent(directory) } }));
    if (!probe.ok || !context || !resolver || !client) throw new Error('bot_native_catalog_unavailable');
    await probe.body?.cancel();
    ready = true;
    return { close, async fetch(request) {
      if (!botNativeAuthorized(request.headers.get('authorization'), capability.runtimeToken)) return Response.json({ code: 'unauthorized' }, { status: 401 });
      const url = new URL(request.url);
      if (!ready) return Response.json({ code: 'bot_native_unavailable' }, { status: 503 });
      if (url.pathname === '/devryan/ready' && request.method === 'GET') return Response.json({ ready: true, generation: 2, opencode: { version: '2.0.20' } });
      const signal = AbortSignal.any([request.signal, lifetime.signal]);
      try {
        if (url.pathname === '/devryan/bot/prompt' && request.method === 'POST') {
          const input = decode(promptSchema, await readJson(request));
          if (input.prompt.agents?.length || input.prompt.skills?.length) throw invalid();
          await run(Effect.gen(function* () {
            const session = yield* context.session.get({ sessionID: input.sessionID });
            if (session.location.directory !== directory) return yield* Effect.die(invalid());
            yield* context.session.switchAgent({ sessionID: input.sessionID, agent: 'bot' });
            yield* context.session.switchModel({ sessionID: input.sessionID, model: input.model });
            yield* context.session.prompt({ sessionID: input.sessionID, ...input.prompt });
          }), signal);
          return Response.json({ accepted: true });
        }
        if (url.pathname === '/devryan/bot/structured' && request.method === 'POST') {
          const input = await readJson(request);
          if (!record(input) || Object.keys(input).some(key => !['model', 'prompt', 'schema', 'title', 'system'].includes(key))
            || typeof input.prompt !== 'string' || !input.prompt || typeof input.system !== 'string' || !record(input.schema)) throw invalid();
          const selected = decode(Model.Ref, input.model);
          const schema = SchemaRepresentation.fromJsonSchemaDocument({ dialect: 'draft-2020-12', schema: input.schema, definitions: {} });
          const output = await run(Effect.gen(function* () {
            const resolved = yield* resolver.resolve(selected);
            if (!resolved || resolved.ref.providerID !== selected.providerID || resolved.ref.id !== selected.id
              || selected.variant !== undefined && resolved.ref.variant !== selected.variant) return yield* Effect.die(invalid());
            // Native's forced output-schema call has no executable tools and creates no session or inbox row.
            return (yield* LLM.generateObject({ model: resolved.model, prompt: input.prompt, system: input.system, schema })
              .pipe(Effect.provideService(LLMClient.Service, client))).object;
          }), signal);
          if (Buffer.byteLength(JSON.stringify(output)) > 128 * 1024) throw invalid();
          return Response.json({ output });
        }
        // Expose only the native surfaces consumed by the run client; all are fixed to its workspace.
        if (!(request.method === 'GET' && /^\/api\/(?:info|event|provider|model(?:\/default)?|session(?:\/[^/]+(?:\/message|\/state|\/event)?)?)$/.test(url.pathname)
          || request.method === 'POST' && /^\/api\/session(?:\/[^/]+\/interrupt)?$/.test(url.pathname))) return new Response(null, { status: 404 });
        for (const [key, value] of url.searchParams) {
          if ((key === 'directory' || key === 'location[directory]') && value !== directory
            || key.startsWith('location') && key !== 'location[directory]'
            || key === 'workspace') throw invalid();
        }
        const headers = new Headers(request.headers);
        if (headers.has('x-opencode-directory') && decodeURIComponent(headers.get('x-opencode-directory')) !== directory) throw invalid();
        if (headers.has('x-opencode-workspace')) throw invalid();
        headers.set('x-opencode-directory', encodeURIComponent(directory));
        url.searchParams.set('directory', directory);
        url.searchParams.set('location[directory]', directory);
        let body = request.body;
        if (url.pathname === '/api/session' && request.method === 'POST') {
          const input = await readJson(request);
          if (!record(input) || Object.keys(input).some(key => !['id', 'title', 'agent', 'model', 'location'].includes(key))
            || input.agent !== undefined && input.agent !== 'bot'
            || input.location !== undefined && (!record(input.location) || input.location.directory !== directory
              || Object.keys(input.location).some(key => key !== 'directory'))) throw invalid();
          body = JSON.stringify({ ...input, agent: 'bot', location: { directory } });
        }
        return await handler(new Request(url, { method: request.method, headers, body, signal, ...(body ? { duplex: 'half' } : {}) }));
      } catch (error) {
        return Response.json({ code: error?.status === 400 || error?._tag === 'SchemaError' ? 'bot_native_request_invalid' : 'bot_native_operation_failed' },
          { status: error?.status === 400 || error?._tag === 'SchemaError' ? 400 : 502 });
      }
    } };
  } catch (error) { await close(); throw error; }
}

if (import.meta.main) {
  const runtime = await createBotNativeServer();
  const server = Bun.serve({ hostname: '0.0.0.0', port: 4096, idleTimeout: 120, fetch: runtime.fetch });
  for (const name of ['SIGINT', 'SIGTERM']) process.once(name, () => {
    void runtime.close().then(() => server.stop(true)).then(() => process.exit(0), () => process.exit(1));
  });
}
