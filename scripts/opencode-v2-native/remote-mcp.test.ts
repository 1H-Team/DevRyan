import { expect, test } from 'bun:test';
import { Effect, Schema } from 'effect';
import { Mcp } from '@opencode/core/mcp/index';
import { Mcp as McpSchema } from '@opencode/schema/mcp';
import { Location } from '@opencode/core/location';
import { createOwnedRemoteMcp, remoteMcpConfigurationDigest, type OwnedRemoteMcpOptions } from '../../packages/web/server/lib/opencode/runtime-host/remote-mcp.js';
import { runWithHostRefusal } from '../../packages/web/server/lib/opencode/runtime-host/host-refusal.js';

const directory = '/fixture/remote-mcp';
const location = Schema.decodeUnknownSync(Location.Info)({ directory,
  project: { id: 'global', directory, canonical: directory } });
const config = Schema.decodeUnknownSync(McpSchema.RemoteConfig)({ type: 'remote', url: 'http://127.0.0.1:1/mcp', codemode: false });
function options(servers = new Map([['reviewed', { config, configurationDigest: remoteMcpConfigurationDigest(config) }]])): OwnedRemoteMcpOptions {
  return { reviewedServersByDirectory: new Map([[directory, servers]]),
    registrationOrigin: { kind: 'native', id: 'devryan.remote-mcp', manifestDigest: 'a'.repeat(64), capabilities: ['network'] },
    controllerInstanceID: '00000000-0000-4000-8000-000000000001',
    withCredentialMutation: (_binding, action) => action,
    captureConnectionGrant: () => Effect.succeed({ reauthorize: Effect.void }),
    executeOwnedFallback: invocation => invocation.executeNative(),
    authorizeCall: (_invocation, _binding, action) => action,
    authorizeControl: (_binding, _operation, action) => action,
    captureOAuthGrant: () => Effect.succeed({ reauthorize: Effect.void }) };
}
function native() {
  let called = 0, connected = 0;
  let tools: Mcp.Tool[] = [{ server: Mcp.ServerName.make('reviewed'), name: 'lookup', inputSchema: { type: 'object' } }];
  const service: Mcp.Interface = {
    servers: () => Effect.succeed([{ name: 'reviewed', status: { status: 'connected' } }]),
    tools: () => Effect.succeed(tools), reload: () => Effect.void,
    transform: () => Effect.succeed({ dispose: Effect.void }), add: () => Effect.void,
    remove: () => Effect.void, connect: () => Effect.sync(() => { connected++; }), disconnect: () => Effect.void,
    callTool: input => Effect.sync(() => { called++; return { server: Mcp.ServerName.make(input.server), tool: input.name, content: [], isError: false }; }),
    instructions: () => Effect.succeed([]), prompts: () => Effect.succeed([]), prompt: () => Effect.succeed(undefined),
    resourceCatalog: () => Effect.succeed({ resources: [], templates: [] }),
    resources: () => Effect.succeed({ resources: [], templates: [] }), readResource: () => Effect.succeed(undefined),
  };
  return { service, called: () => called, connected: () => connected, setTools: (value: Mcp.Tool[]) => { tools = value; } };
}

test('reviewed MCP configuration rejects CodeMode, URL credentials, tampering and namespace collisions', () => {
  for (const input of [{ ...config, codemode: true }, { ...config, url: 'http://user:secret@127.0.0.1/mcp' }]) {
    const decoded = Schema.decodeUnknownSync(McpSchema.RemoteConfig)(input);
    expect(() => createOwnedRemoteMcp(options(new Map([['reviewed', { config: decoded, configurationDigest: remoteMcpConfigurationDigest(decoded) }]])))).toThrow();
  }
  expect(() => createOwnedRemoteMcp(options(new Map([['reviewed', { config, configurationDigest: 'b'.repeat(64) }]])))).toThrow('digest mismatch');
  expect(() => createOwnedRemoteMcp(options(new Map(['a.b', 'a_b'].map(server => [server, { config, configurationDigest: remoteMcpConfigurationDigest(config) }]))))).toThrow('colliding');
});

test('unscoped MCP calls cannot reach the native client and disabled servers cannot connect', async () => {
  const n = native(), owner = createOwnedRemoteMcp(options());
  const service = owner.decorateMcp(n.service, location);
  expect((await Effect.runPromise(service.tools()))[0]?.codemode).toBe(false);
  const result = await runWithHostRefusal(() => Effect.runPromise(service.callTool({ server: 'reviewed', name: 'lookup', args: {} })));
  expect(result).toMatchObject({ ok: false, refusal: { code: 'native_mcp_call_scope_required' } });
  expect(n.called()).toBe(0);
  const disabled = Schema.decodeUnknownSync(McpSchema.RemoteConfig)({ ...config, disabled: true });
  const closed = createOwnedRemoteMcp(options(new Map([['reviewed', { config: disabled, configurationDigest: remoteMcpConfigurationDigest(disabled) }]]))).decorateMcp(n.service, location);
  expect(await runWithHostRefusal(() => Effect.runPromise(closed.connect('reviewed')))).toMatchObject({ ok: false, refusal: { code: 'native_mcp_server_unreviewed' } });
  expect(n.connected()).toBe(0);
});

test('native catalog collisions and foreign servers fail before tool registration', async () => {
  const n = native(), service = createOwnedRemoteMcp(options()).decorateMcp(n.service, location);
  n.setTools(['a.b', 'a_b'].map(name => ({ server: Mcp.ServerName.make('reviewed'), name, inputSchema: { type: 'object' } })));
  expect(await runWithHostRefusal(() => Effect.runPromise(service.tools()))).toMatchObject({ ok: false, refusal: { code: 'native_mcp_tool_collision' } });
  n.setTools([{ server: Mcp.ServerName.make('foreign'), name: 'lookup', inputSchema: { type: 'object' } }]);
  expect(await runWithHostRefusal(() => Effect.runPromise(service.tools()))).toMatchObject({ ok: false, refusal: { code: 'native_mcp_server_unreviewed' } });
  expect(n.called()).toBe(0);
});


test('closing one acquisition fences old services before reopening the identical catalog', async () => {
  const n = native(), owner = createOwnedRemoteMcp(options());
  const old = owner.decorateMcp(n.service, location);
  await Effect.runPromise(old.tools());
  await Effect.runPromise(owner.closeLocation(directory));
  const next = owner.decorateMcp(n.service, location);
  expect((await Effect.runPromise(next.tools())).map(tool => tool.name)).toEqual(['lookup']);
  await expect(Effect.runPromise(old.tools())).rejects.toThrow('native_mcp_registration_expired');
  await expect(Effect.runPromise(old.connect('reviewed'))).rejects.toThrow('native_mcp_registration_expired');
  expect(n.connected()).toBe(0);
  await Effect.runPromise(owner.closeLocation(directory));
});

test('permission normalization collisions across distinct namespaces fail closed', async () => {
  const n = native();
  n.setTools([{ server: Mcp.ServerName.make('a'), name: 'b_c', inputSchema: { type: 'object' } },
    { server: Mcp.ServerName.make('a_b'), name: 'c', inputSchema: { type: 'object' } }]);
  const servers = new Map(['a', 'a_b'].map(server => [server, { config, configurationDigest: remoteMcpConfigurationDigest(config) }]));
  const service = createOwnedRemoteMcp(options(servers)).decorateMcp(n.service, location);
  expect(await runWithHostRefusal(() => Effect.runPromise(service.tools()))).toMatchObject({ ok: false,
    refusal: { code: 'native_mcp_tool_collision' } });
});

test('only exact reviewed native configuration origins can perform sealed no-op transforms', async () => {
  const { provideRegistrationOrigin } = await import('../../packages/web/server/lib/opencode/runtime-host/registration-origin.js');
  const { createReviewedNativePluginRegistry } = await import('../../packages/web/server/lib/opencode/runtime-host/native-plugin-registry.js');
  const registry = createReviewedNativePluginRegistry('b'.repeat(64));
  const defaults = registry.get('opencode.mcp.codemode.defaults');
  if (!defaults) throw new Error('Pinned defaults origin required');
  let transformed = 0;
  const n = native();
  const value: Mcp.Interface = { ...n.service, transform: callback => Effect.sync(() => {
    callback({ list: () => [[Mcp.ServerName.make('reviewed'), config]], get: name => name === 'reviewed' ? config : undefined,
      set: () => { transformed++; }, update: () => { transformed++; }, remove: () => { transformed++; } });
    return { dispose: Effect.void };
  }) };
  const owner = createOwnedRemoteMcp({ ...options(), reviewedConfigurationOrigins: new Map([[defaults.id, defaults]]) });
  const service = owner.decorateMcp(value, location);
  await Effect.runPromise(Effect.scoped(provideRegistrationOrigin(defaults, service.transform(editor => {
    expect(editor.list()[0]?.[1].codemode).toBe(false);
  }))));
  expect(transformed).toBe(0);
  expect(await runWithHostRefusal(() => Effect.runPromise(Effect.scoped(provideRegistrationOrigin({ ...defaults, manifestDigest: 'c'.repeat(64) },
    service.transform(() => {})))))).toMatchObject({ ok: false, refusal: { code: 'native_mcp_configuration_sealed' } });
  await expect(Effect.runPromise(Effect.scoped(provideRegistrationOrigin(defaults, service.transform(editor => {
    editor.set('reviewed', { ...config, url: 'http://127.0.0.1:2/forged' });
  }))))).rejects.toThrow('native_mcp_configuration_sealed');
  expect(transformed).toBe(0);
});


test('credential ownership accessor never trusts a credential metadata source or plausible MCP name', () => {
  const owner=createOwnedRemoteMcp(options());
  for(const id of ['mcp_foreign','reviewed','xai','openai','cursor-acp']) expect(owner.ownsCredentialIntegration(id)).toBe(false);
});

test('sealed configuration transform rechecks acquisition after asynchronous registration settles', async () => {
  const { provideRegistrationOrigin } = await import('../../packages/web/server/lib/opencode/runtime-host/registration-origin.js');
  const { createReviewedNativePluginRegistry } = await import('../../packages/web/server/lib/opencode/runtime-host/native-plugin-registry.js');
  const approved = createReviewedNativePluginRegistry('b'.repeat(64)).get('opencode.config.mcp');
  if (!approved) throw new Error('Pinned configuration origin required');
  let release: (() => void) | undefined, entered: (() => void) | undefined;
  const waiting = new Promise<void>(resolve => { release = resolve; });
  const started = new Promise<void>(resolve => { entered = resolve; });
  const n = native();
  const service: Mcp.Interface = { ...n.service, transform: () => Effect.promise(async () => {
    entered?.(); await waiting; return { dispose: Effect.void };
  }) };
  const owner = createOwnedRemoteMcp({ ...options(), reviewedConfigurationOrigins: new Map([[approved.id, approved]]) });
  const decorated = owner.decorateMcp(service, location);
  const pending = Effect.runPromise(Effect.scoped(provideRegistrationOrigin(approved, decorated.transform(() => {}))));
  // Observe rejection without eagerly waiting on Bun's matcher before releasing the held operation.
  void pending.catch(() => {});
  await started; await Effect.runPromise(owner.closeLocation(directory)); release?.();
  await expect(pending).rejects.toThrow('native_mcp_registration_expired');
  await expect(Effect.runPromise(Effect.scoped(provideRegistrationOrigin(approved, decorated.transform(() => {})))))
    .rejects.toThrow('native_mcp_registration_expired');
});
