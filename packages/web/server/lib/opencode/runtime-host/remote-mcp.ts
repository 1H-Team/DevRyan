import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import { Context, Effect, Layer, Option, Schema } from 'effect';
import { Mcp } from '@opencode/core/mcp/index';
import { McpTool } from '@opencode/core/tool/mcp';
import { Mcp as McpSchema } from '@opencode/schema/mcp';
import { Tool } from '@opencode/core/tool';
import { Location } from '@opencode/core/location';
import { Permission } from '@opencode/core/permission';
import { Integration } from '@opencode/core/integration';
import { Credential } from '@opencode/core/credential';
import type { LayerNode } from '@opencode/util/effect/layer-node';
import type { ExecuteOwned, OwnedToolInvocation } from './native-admission-contract.js';
import { RegistrationOriginRef, type RegistrationOrigin } from './registration-origin.js';
import { HostRefusal, refuseHost } from './host-refusal.js';
import { CredentialAuthorizationRef, type WithCredentialMutation } from './credential-mutation-contract.js';

export interface RemoteMcpBinding {
  readonly directory: string; readonly server: string; readonly configurationDigest: string; readonly acquisitionID: string;
}
export interface RemoteMcpToolBinding extends RemoteMcpBinding {
  readonly name: string; readonly toolID: string; readonly schemaDigest: string; readonly catalogRevision: number;
}
export interface RemoteMcpOAuthBinding extends RemoteMcpBinding { readonly integrationID: string; readonly methodID: string }
export interface RemoteMcpOAuthGrant { readonly reauthorize: Effect.Effect<void>; readonly authorizationID?: string }
export interface ReviewedRemoteMcpServer { readonly config: McpSchema.RemoteConfig; readonly configurationDigest: string }
export interface OwnedRemoteMcpOptions {
  readonly reviewedServersByDirectory: ReadonlyMap<string, ReadonlyMap<string, ReviewedRemoteMcpServer>>;
  readonly registrationOrigin: RegistrationOrigin;
  readonly reviewedConfigurationOrigins?: ReadonlyMap<string, RegistrationOrigin>;
  readonly controllerInstanceID: string;
  readonly withCredentialMutation: WithCredentialMutation;
  readonly executeOwnedFallback: ExecuteOwned;
  readonly authorizeCall: <A, E, R>(invocation: OwnedToolInvocation, binding: RemoteMcpToolBinding, action: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>;
  readonly authorizeControl: <A, E, R>(binding: RemoteMcpBinding, operation: string, action: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>;
  readonly captureOAuthGrant: (binding: RemoteMcpOAuthBinding) => Effect.Effect<RemoteMcpOAuthGrant>;
  /** Native connectProvider captures this separately from interactive OAuth. */
  readonly captureConnectionGrant: (binding: RemoteMcpOAuthBinding) => Effect.Effect<RemoteMcpOAuthGrant>;
  /** Exact constructor-owned removal of a reviewed native MCP credential. */
  readonly captureRemovalGrant?: (binding: RemoteMcpOAuthBinding & {readonly credentialID:string}) => Effect.Effect<RemoteMcpOAuthGrant>;
}

const canonical = (value: unknown): unknown => Array.isArray(value) ? value.map(canonical)
  : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined)
    .sort(([left], [right]) => left.localeCompare(right)).map(([key, item]) => [key, canonical(item)])) : value;
export const remoteMcpDigest = (value: unknown): string => createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
export const remoteMcpConfigurationDigest = (config: McpSchema.RemoteConfig): string => remoteMcpDigest({ ...config, timeout: config.timeout ?? {} });
const configDigest = remoteMcpConfigurationDigest;
const freeze = <T>(value: T): T => {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const item of Object.values(value)) freeze(item);
    Object.freeze(value);
  }
  return value;
};
const denied = (code: string, operation: string) => refuseHost(new HostRefusal(code, 403, operation));
const sameOrigin = (left: RegistrationOrigin, right: RegistrationOrigin): boolean => remoteMcpDigest(left) === remoteMcpDigest(right);

/** Native service ownership, independent of SDK plugin identity. No local MCP
 * process is admitted. Integration/Credential decorators are composed by the
 * host's single shared owner rather than last-wins graph replacements. */
export function createOwnedRemoteMcp(options: OwnedRemoteMcpOptions) {
  let credentialStore:Credential.Interface|undefined;
  const originalIntegrations=new WeakMap<Integration.Interface,Integration.Interface>();
  if (!options.controllerInstanceID || typeof options.withCredentialMutation !== 'function' ||
    typeof options.captureConnectionGrant !== 'function') throw new Error('MCP credential owner is required');
  const origin = Object.freeze({ ...options.registrationOrigin, capabilities: Object.freeze([...options.registrationOrigin.capabilities]) });
  if (origin.kind !== 'native' || !origin.capabilities.includes('network') || !/^[a-f0-9]{64}$/.test(origin.manifestDigest)) throw new Error('Invalid reviewed MCP service origin');
  const configurationOrigins = new Map<string, RegistrationOrigin>();
  // 2.0.26 configuration policy only removes servers its `integration.use` policy denies.
  const policyID = 'opencode.config.policy';
  const configurationIDs = new Set(['opencode.config.mcp', 'opencode.mcp.codemode.defaults', 'opencode.provider.opencode', policyID]);
  for (const [id, value] of options.reviewedConfigurationOrigins ?? []) {
    if (!configurationIDs.has(id) || value.id !== id || value.kind !== 'native' || !/^[a-f0-9]{64}$/.test(value.manifestDigest))
      throw new Error('Invalid reviewed MCP configuration origin');
    configurationOrigins.set(id, freeze(structuredClone(value)));
  }
  const reviewed = new Map<string, ReadonlyMap<string, ReviewedRemoteMcpServer>>();
  for (const [directory, servers] of options.reviewedServersByDirectory) {
    if (!path.isAbsolute(directory) || servers.size > 128) throw new Error('Invalid reviewed MCP location');
    const names = new Set<string>(), copy = new Map<string, ReviewedRemoteMcpServer>();
    for (const [server, value] of servers) {
      const config = Schema.decodeUnknownSync(McpSchema.ServerConfig)(structuredClone(value.config));
      if (config.type !== 'remote' || config.codemode !== false) throw new Error('Only reviewed direct remote MCP is supported');
      const url = new URL(config.url);
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || !server || server.length > 256
        || Array.from(server).some(character=>character<' ') || names.has(McpTool.namespace(server))) throw new Error('Invalid or colliding reviewed MCP server');
      names.add(McpTool.namespace(server));
      if (configDigest(config) !== value.configurationDigest) throw new Error('Reviewed MCP configuration digest mismatch');
      copy.set(server, Object.freeze({ config: freeze(config), configurationDigest: value.configurationDigest }));
    }
    reviewed.set(directory, copy);
  }
  interface Catalog { readonly acquisitionID: string; readonly location: Readonly<Location.Info>; inner?: Mcp.Interface; closed: boolean; revision: number;
    digest: string; tools: Map<string, RemoteMcpToolBinding> }
  const catalogs = new Map<string, Catalog>();
  const serviceCatalogs = new WeakMap<Mcp.Interface, Catalog>();
  const integrationAcquisitions = new WeakMap<Integration.Interface, string>();
  const integrationBindings = new Map<string, Map<string, RemoteMcpBinding>>();
  const attempts = new Map<string, { readonly binding: RemoteMcpOAuthBinding; readonly grant: RemoteMcpOAuthGrant; readonly inner: Integration.Interface }>();
  const ownedIntegrationIDs = new Set<string>();
  const ActiveCall = Context.Reference<{ readonly invocation: OwnedToolInvocation; readonly binding: RemoteMcpToolBinding } | undefined>('DevRyan/RemoteMcpCall', { defaultValue: () => undefined });
  const RegistrationBinding = Context.Reference<RemoteMcpToolBinding | undefined>('DevRyan/RemoteMcpRegistration', { defaultValue: () => undefined });
  interface CredentialScope { readonly binding: RemoteMcpOAuthBinding; readonly grant: RemoteMcpOAuthGrant;
    readonly mode: 'interactive' | 'connection'; readonly credentialID?: Credential.ID; readonly expectedFingerprint?: string }
  const OAuthGrant = Context.Reference<CredentialScope | undefined>('DevRyan/RemoteMcpOAuth', { defaultValue: () => undefined });
  const openCatalog = (directory: string, acquisitionID?: string): Catalog => {
    const catalog = catalogs.get(directory);
    if (!catalog || catalog.closed || (acquisitionID !== undefined && catalog.acquisitionID !== acquisitionID))
      throw new HostRefusal('native_mcp_registration_expired', 403, 'mcp.binding');
    return catalog;
  };
  const bindingFor = (directory: string, server: string, acquisitionID?: string): RemoteMcpBinding => {
    const catalog = openCatalog(directory, acquisitionID);
    const serverInfo = reviewed.get(directory)?.get(server);
    if (!serverInfo || serverInfo.config.disabled) throw new HostRefusal('native_mcp_server_unreviewed', 403, 'mcp.binding');
    return Object.freeze({ directory, server, configurationDigest: serverInfo.configurationDigest, acquisitionID: catalog.acquisitionID });
  };
  const refresh = (catalog: Catalog) => Effect.gen(function* () {
    openCatalog(catalog.location.directory, catalog.acquisitionID);
    if (!catalog.inner) return yield* denied('native_mcp_catalog_unavailable', 'mcp.catalog');
    const native = yield* catalog.inner.tools();
    openCatalog(catalog.location.directory, catalog.acquisitionID);
    const next = new Map<string, RemoteMcpToolBinding>(), permissions = new Set<string>();
    for (const tool of native) {
      const binding = bindingFor(catalog.location.directory, tool.server, catalog.acquisitionID);
      const toolID = `${McpTool.namespace(tool.server)}.${tool.name}`, permission = McpTool.name(tool.server, tool.name);
      if (next.has(toolID) || permissions.has(permission)) return yield* denied('native_mcp_tool_collision', 'mcp.catalog');
      permissions.add(permission);
      next.set(toolID, { ...binding, toolID, name: tool.name, schemaDigest: remoteMcpDigest({ input: tool.inputSchema,
        output: tool.outputSchema, description: tool.description }), catalogRevision: 0 });
    }
    const digest = remoteMcpDigest([...next]);
    if (catalog.digest !== digest) { catalog.digest = digest; catalog.revision++; }
    catalog.tools = new Map([...next].map(([id, value]) => [id, Object.freeze({ ...value, catalogRevision: catalog.revision })]));
    const servers = yield* catalog.inner.servers();
    openCatalog(catalog.location.directory, catalog.acquisitionID);
    for (const server of servers) if (server.integrationID) {
      const value = reviewed.get(catalog.location.directory)?.get(server.name);
      if (value && !value.config.disabled) {
        const locations = integrationBindings.get(server.integrationID) ?? new Map<string, RemoteMcpBinding>();
        locations.set(catalog.location.directory, bindingFor(catalog.location.directory, server.name, catalog.acquisitionID));
        ownedIntegrationIDs.add(server.integrationID);
        integrationBindings.set(server.integrationID, locations);
      }
    }
    return native.map(tool => ({ ...tool, codemode: false }));
  });
  const current = (binding: RemoteMcpToolBinding) => Effect.gen(function* () {
    const catalog = openCatalog(binding.directory, binding.acquisitionID);
    yield* refresh(catalog);
    const actual = catalog.tools.get(binding.toolID);
    if (!actual || remoteMcpDigest(actual) !== remoteMcpDigest(binding)) return yield* denied('native_mcp_registration_expired', 'mcp.call');
  });
  const newCatalog = (location: Readonly<Location.Info>): Catalog => ({ acquisitionID: randomUUID(),
    location: Object.freeze({ ...location, project: Object.freeze({ ...location.project }) }),
    closed: false, revision: 0, digest: '', tools: new Map() });
  const closeCatalog = (catalog: Catalog) => Effect.gen(function* () {
    // Cleanup can retry retained cancellation failures from an earlier finalizer.
    // Invalidate first. Cleanup may await an OAuth attempt while replacement opens.
    catalog.closed = true; catalog.tools.clear();
    if (catalogs.get(catalog.location.directory) === catalog) catalogs.delete(catalog.location.directory);
    for (const [id, locations] of integrationBindings) {
      if (locations.get(catalog.location.directory)?.acquisitionID === catalog.acquisitionID)
        locations.delete(catalog.location.directory);
      if (!locations.size) integrationBindings.delete(id);
    }
    const owned = [...attempts].filter(([, value]) => value.binding.acquisitionID === catalog.acquisitionID);
    const failures = [];
    for (const [attemptID, attempt] of owned) {
      const result = yield* attempt.inner.oauth.cancel({ integrationID: Integration.ID.make(attempt.binding.integrationID),
        attemptID: Integration.AttemptID.make(attemptID) }).pipe(Effect.exit);
      if (result._tag === 'Success' && attempts.get(attemptID) === attempt) attempts.delete(attemptID);
      if (result._tag === 'Failure') failures.push(result.cause);
    }
    if (failures.length) return yield* Effect.die(new AggregateError(failures, 'Native MCP acquisition cleanup failed'));
  });
  const decorateMcp = (inner: Mcp.Interface, location: Readonly<Location.Info>, acquisition?: Catalog): Mcp.Interface => {
    const catalog = acquisition ?? newCatalog(location);
    const previous = catalogs.get(location.directory);
    if (previous && previous !== catalog) throw new HostRefusal('native_mcp_acquisition_active', 409, 'mcp.acquire');
    catalog.inner = inner; catalogs.set(location.directory, catalog);
    const live = <A, E, R>(action: Effect.Effect<A, E, R>) => Effect.gen(function* () {
      openCatalog(location.directory, catalog.acquisitionID); const value = yield* action;
      openCatalog(location.directory, catalog.acquisitionID); return value;
    });
    const service = Mcp.Service.of({ ...inner,
      servers: () => live(inner.servers()), instructions: () => live(inner.instructions()),
      prompts: () => live(inner.prompts()), resourceCatalog: () => live(inner.resourceCatalog()),
      tools: () => refresh(catalog),
      reload: () => Effect.suspend(() => { openCatalog(location.directory, catalog.acquisitionID); return inner.reload(); }),
      add: () => denied('native_mcp_configuration_sealed', 'mcp.add'), remove: () => denied('native_mcp_configuration_sealed', 'mcp.remove'),
      connect: server => Effect.suspend(() => options.authorizeControl(bindingFor(location.directory, server, catalog.acquisitionID), 'mcp.connect', inner.connect(server))),
      disconnect: server => Effect.suspend(() => options.authorizeControl(bindingFor(location.directory, server, catalog.acquisitionID), 'mcp.disconnect', inner.disconnect(server))),
      callTool: input => Effect.gen(function* () {
        const active = yield* ActiveCall, registered = yield* RegistrationBinding;
        if (!active || !registered || input.server !== registered.server || input.name !== registered.name
          || input.sessionID !== active.invocation.nativeContext.sessionID || remoteMcpDigest(input.args ?? {}) !== remoteMcpDigest(active.invocation.input ?? {})
          || remoteMcpDigest(registered) !== remoteMcpDigest(active.binding)) return yield* denied('native_mcp_call_scope_required', 'mcp.call');
        yield* current(registered); yield* active.invocation.recheckPermit();
        const result = yield* inner.callTool(input);
        yield* active.invocation.recheckPermit(); yield* current(registered);
        return result;
      }),
      prompt: () => denied('native_mcp_prompt_scope_required', 'mcp.prompt'),
      resources: () => denied('native_mcp_resource_scope_required', 'mcp.resources'),
      readResource: () => denied('native_mcp_resource_scope_required', 'mcp.readResource'),
      transform: callback => Effect.gen(function* () {
        openCatalog(location.directory, catalog.acquisitionID);
        const registration = yield* RegistrationOriginRef;
        const approved = registration && configurationOrigins.get(registration.id);
        if (!registration || !approved || !sameOrigin(registration, approved)) return yield* denied('native_mcp_configuration_sealed', 'mcp.transform');
        const registrationResult = yield* inner.transform(editor => callback({ ...editor,
          list: () => editor.list().map(([server, config]) => [server, structuredClone(config)] as const),
          get: server => { const config = editor.get(server); return config ? structuredClone(config) : undefined; },
          set: (server, config) => {
            const expected = reviewed.get(location.directory)?.get(server);
            if (!expected || config.type !== 'remote' || config.codemode !== false || configDigest(config) !== expected.configurationDigest) throw new HostRefusal('native_mcp_configuration_sealed', 403, 'mcp.transform');
            editor.set(server, expected.config);
          },
          update: () => { throw new HostRefusal('native_mcp_configuration_sealed', 403, 'mcp.transform'); },
          // Removal only narrows the reviewed catalog; only the policy origin may do it.
          remove: server => { if (registration.id !== policyID) throw new HostRefusal('native_mcp_configuration_sealed', 403, 'mcp.transform'); editor.remove(server); },
        }));
        openCatalog(location.directory, catalog.acquisitionID);
        return registrationResult;
      }),
    });
    serviceCatalogs.set(service, catalog); return service;
  };
  // Mcp.layer captures Credential/Integration during acquisition. Bind its
  // concrete credential proxy BEFORE acquiring the original layer, so native
  // background token refresh cannot borrow an interactive OAuth grant.
  const mcpNode = Mcp.node.mapLayer(<R>(layer: Layer.Layer<Mcp.Service, never, R>) => Layer.unwrap(Effect.gen(function* () {
    const context = yield* Effect.context<R>();
    const location = Option.getOrUndefined(Context.getOption(context, Location.Service));
    const credentials = Option.getOrUndefined(Context.getOption(context, Credential.Service));
    const integrations = Option.getOrUndefined(Context.getOption(context, Integration.Service));
    if (!location || !credentials || !integrations) return yield* denied('native_mcp_location_required', 'mcp.acquire');
    const catalog = newCatalog(location);
    const previous = catalogs.get(location.directory);
    if (previous) yield* closeCatalog(previous);
    catalogs.set(location.directory, catalog);
    integrationAcquisitions.set(integrations, catalog.acquisitionID);
    yield* Effect.addFinalizer(() => closeCatalog(catalog));
    const scopedCredentials = connectionCredentials(credentials, integrations, catalog);
    const original = layer.pipe(Layer.provide(Layer.succeedContext(Context.add(context, Credential.Service, scopedCredentials))));
    return Layer.effect(Mcp.Service, Effect.gen(function* () {
      const inner = yield* Mcp.Service;
      // Register after the original service acquired its resources: LIFO Scope
      // disposal fences our binding before the native cleanup can await I/O.
      yield* Effect.addFinalizer(() => closeCatalog(catalog));
      openCatalog(location.directory, catalog.acquisitionID);
      const service = decorateMcp(inner, location, catalog);
      const servers = reviewed.get(location.directory);
      if (!servers) return yield* denied('native_mcp_location_required', 'mcp.acquire');
      if (servers.size) {
        const configurationOrigin = configurationOrigins.get('opencode.config.mcp');
        if (!configurationOrigin) return yield* denied('native_mcp_configuration_origin_required', 'mcp.acquire');
        // Compatibility data stays outside Config discovery. Install only this
        // acquisition's sealed servers through the original native transformer.
        // A later ConfigMcpPlugin pass sees these exact entries and skips them.
        yield* service.transform(editor => {
          for (const [name, value] of servers) {
            const existing = editor.get(name);
            if (existing && (existing.type !== 'remote' || configDigest(existing) !== value.configurationDigest)) {
              throw new HostRefusal('native_mcp_configuration_sealed', 403, 'mcp.register');
            }
            if (!existing) editor.set(name, value.config);
          }
        }).pipe(Effect.provideService(RegistrationOriginRef, configurationOrigin));
        openCatalog(location.directory, catalog.acquisitionID);
      }
      return service;
    })).pipe(Layer.provide(original));
  })));
  const toolNode = McpTool.node.mapLayer(<R>(layer: Layer.Layer<McpTool.Service, never, R>) => Layer.unwrap(Effect.contextWith((context: Context.Context<R>) => {
    const mcp = Option.getOrUndefined(Context.getOption(context, Mcp.Service));
    const toolService = Option.getOrUndefined(Context.getOption(context, Tool.Service));
    const permission = Option.getOrUndefined(Context.getOption(context, Permission.Service));
    const catalog = mcp && serviceCatalogs.get(mcp);
    if (!catalog || !toolService || !permission) throw new HostRefusal('native_mcp_registration_context_required', 403, 'mcp.acquire');
    const tools = Tool.Service.of({ ...toolService, transform: callback => toolService.transform(editor => callback({ ...editor,
      add: tool => {
        const toolID = tool.options?.namespace ? `${tool.options.namespace}.${tool.name}` : tool.name;
        const binding = catalog.tools.get(toolID);
        if (!binding) throw new HostRefusal('native_mcp_registration_unreviewed', 403, 'mcp.register');
        const { pinned: _pinned, ...directOptions } = tool.options ?? {};
        void _pinned;
        editor.add({ ...tool, options: { ...directOptions, codemode: false },
          execute: (input, nativeContext) => current(binding).pipe(Effect.andThen(tool.execute(input, nativeContext)),
            Effect.provideService(RegistrationBinding, binding)) });
      },
    })) });
    const provided = Context.add(Context.add(Context.add(Context.add(context, RegistrationOriginRef, origin), Location.Service, catalog.location),
      Permission.Service, permission), Tool.Service, tools);
    return Effect.succeed(layer.pipe(Layer.provide(Layer.succeedContext(provided))));
  })));
  const executeOwned: ExecuteOwned = invocation => {
    if (invocation.provenance.id !== origin.id) return options.executeOwnedFallback(invocation);
    if (!sameOrigin(invocation.provenance, origin)) return denied('native_mcp_registration_unreviewed', 'mcp.execute');
    return Effect.gen(function* () {
      const binding = catalogs.get(invocation.location.directory)?.tools.get(invocation.toolID);
      if (!binding) return yield* denied('native_mcp_registration_unreviewed', 'mcp.execute');
      yield* current(binding); yield* invocation.recheckPermit();
      return yield* options.authorizeCall(invocation, binding, invocation.executeNative().pipe(Effect.provideService(ActiveCall, { invocation, binding })));
    });
  };
  const oauthBinding = (inner: Integration.Interface, location: Readonly<Location.Info>, integrationID: Integration.ID, methodID: Integration.MethodID) => Effect.gen(function* () {
    const catalog = openCatalog(location.directory);
    if (catalog.inner) yield* refresh(catalog);
    const binding = integrationBindings.get(integrationID)?.get(location.directory), info = yield* inner.get(integrationID);
    if (!binding || binding.directory !== location.directory || info?.metadata?.source !== 'mcp' || info.name !== binding.server
      || !info.methods.some(method => method.type === 'oauth' && method.id === methodID)) return yield* denied('native_mcp_integration_unreviewed', 'mcp.oauth');
    return Object.freeze({ ...binding, integrationID, methodID });
  });
  const decorateIntegration = (inner: Integration.Interface, location: Readonly<Location.Info>): Integration.Interface => {
    const acquisition = () => {
      const id = integrationAcquisitions.get(service);
      if (!id) throw new HostRefusal('native_mcp_acquisition_required', 403, 'mcp.oauth');
      return openCatalog(location.directory, id);
    };
    const service: Integration.Interface = Integration.Service.of({ ...inner,
    oauth: { ...inner.oauth,
      connect: input => Effect.gen(function* () {
        const info = yield* inner.get(input.integrationID);
        if (info?.metadata?.source !== 'mcp') return yield* inner.oauth.connect(input);
        acquisition();
        const binding = yield* oauthBinding(inner, location, input.integrationID, input.methodID);
        acquisition();
        const grant = yield* options.captureOAuthGrant(binding); yield* grant.reauthorize;
        const attempt = yield* inner.oauth.connect(input).pipe(Effect.provideService(OAuthGrant, { binding, grant, mode: 'interactive' }));
        let retained = false;
        return yield* Effect.gen(function* () {
          yield* grant.reauthorize; openCatalog(binding.directory, binding.acquisitionID);
          attempts.set(attempt.attemptID, { binding, grant, inner }); retained = true; return attempt;
        }).pipe(Effect.ensuring(Effect.suspend(() => retained ? Effect.void : inner.oauth.cancel({
          integrationID: input.integrationID, attemptID: attempt.attemptID }))));
      }),
      complete: input => Effect.gen(function* () {
        const attempt = attempts.get(input.attemptID);
        if (!attempt) {
          const info = yield* inner.get(input.integrationID);
          if (info?.metadata?.source === 'mcp') return yield* denied('native_mcp_attempt_scope_required', 'mcp.oauth');
          return yield* inner.oauth.complete(input);
        }
        if (attempt.binding.integrationID !== input.integrationID || attempt.binding.directory !== location.directory) return yield* denied('native_mcp_attempt_scope_required', 'mcp.oauth');
        acquisition();
        const actual = yield* oauthBinding(inner, location, input.integrationID, Integration.MethodID.make(attempt.binding.methodID));
        if (remoteMcpDigest(actual) !== remoteMcpDigest(attempt.binding)) return yield* denied('native_mcp_attempt_scope_required', 'mcp.oauth');
        yield* attempt.grant.reauthorize; acquisition();
        return yield* inner.oauth.complete(input).pipe(Effect.provideService(OAuthGrant, { ...attempt, mode: 'interactive' }));
      }),
      cancel: input => Effect.gen(function* () {
        const attempt = attempts.get(input.attemptID), info = yield* inner.get(input.integrationID);
        if (!attempt) {
          if (info?.metadata?.source === 'mcp' || ownedIntegrationIDs.has(input.integrationID))
            return yield* denied('native_mcp_attempt_scope_required', 'mcp.oauth');
          return yield* inner.oauth.cancel(input);
        }
        if (attempt.binding.integrationID !== input.integrationID || attempt.binding.directory !== location.directory)
          return yield* denied('native_mcp_attempt_scope_required', 'mcp.oauth');
        acquisition(); openCatalog(location.directory, attempt.binding.acquisitionID);
        yield* attempt.grant.reauthorize; acquisition();
        yield* inner.oauth.cancel(input);
        if (attempts.get(input.attemptID) === attempt) attempts.delete(input.attemptID);
      }),
    },
    });
    originalIntegrations.set(inner,service);return service;
  };
  const credentialScope = (integrationID: Integration.ID) => Effect.gen(function* () {
    const active = yield* OAuthGrant;
    if (!active || active.binding.integrationID !== integrationID) {
      if (ownedIntegrationIDs.has(integrationID)) return yield* denied('native_mcp_credential_scope_required', 'mcp.credential');
      return undefined;
    }
    const binding = bindingFor(active.binding.directory, active.binding.server, active.binding.acquisitionID);
    if (remoteMcpDigest(binding) !== remoteMcpDigest({ directory: active.binding.directory, server: active.binding.server,
      configurationDigest: active.binding.configurationDigest, acquisitionID: active.binding.acquisitionID }))
      return yield* denied('native_mcp_credential_scope_required', 'mcp.credential');
    yield* active.grant.reauthorize;
    openCatalog(binding.directory, binding.acquisitionID);
    return active;
  });
  const mutate = <A, E, R>(active: CredentialScope, operation: 'create' | 'update' | 'activate' | 'remove',
    input: unknown, action: Effect.Effect<A, E, R>, credentialID?: Credential.ID) => Effect.gen(function* () {
    yield* credentialScope(Integration.ID.make(active.binding.integrationID));
    if (active.mode === 'connection' && (!credentialID || credentialID !== active.credentialID || !active.expectedFingerprint))
      return yield* denied('native_mcp_selected_credential_required', 'mcp.credential');
    const binding = { ...active.binding, kind: 'mcp' as const, valueType: 'oauth' as const,
      controllerInstanceID: options.controllerInstanceID, operation, requestedFingerprint: remoteMcpDigest(input),
      ...(credentialID ? { credentialID } : {}), ...(active.expectedFingerprint ? { expectedFingerprint: active.expectedFingerprint } : {}) };
    return yield* options.withCredentialMutation(binding, Effect.gen(function* () {
      yield* credentialScope(Integration.ID.make(active.binding.integrationID));
      if(credentialID){
        if(!credentialStore||!binding.expectedFingerprint)return yield* denied('native_mcp_selected_credential_required','mcp.credential');
        const current=yield* credentialStore.get(credentialID);
        if(!current||remoteMcpDigest(current)!==binding.expectedFingerprint)return yield* denied('native_credential_changed','mcp.credential');
        yield* credentialScope(Integration.ID.make(active.binding.integrationID));
      }
      if (remoteMcpDigest(input) !== binding.requestedFingerprint)
        return yield* denied('native_mcp_mutation_input_changed', 'mcp.credential');
      return yield* action;
    })).pipe(Effect.provideService(CredentialAuthorizationRef, active.grant.authorizationID));
  });
  const decorateCredential = (inner: Credential.Interface): Credential.Interface => {
    credentialStore=inner;
    return Credential.Service.of({ ...inner,
    create: input => Effect.gen(function* () {
      const active = yield* credentialScope(input.integrationID);
      if (!active) return yield* inner.create(input);
      if (active.mode !== 'interactive' || input.value.type !== 'oauth' || input.value.methodID !== active.binding.methodID)
        return yield* denied('native_mcp_credential_scope_required', 'mcp.credential');
      return yield* mutate(active, 'create', input, inner.create(input));
    }),
    update: (id, updates) => Effect.gen(function* () {
      const info = yield* inner.get(id);
      if (!info) return yield* inner.update(id, updates);
      const active = yield* credentialScope(info.integrationID);
      if (!active) return yield* inner.update(id, updates);
      if (info.value.type !== 'oauth' || info.value.methodID !== active.binding.methodID ||
        (updates.value && (updates.value.type !== 'oauth' || updates.value.methodID !== active.binding.methodID)))
        return yield* denied('native_mcp_credential_scope_required', 'mcp.credential');
      return yield* mutate({ ...active, expectedFingerprint: active.expectedFingerprint ?? remoteMcpDigest(info) },
        'update', { id, updates }, inner.update(id, updates), id);
    }),
    activate: id => Effect.gen(function* () {
      const info = yield* inner.get(id);
      if (!info) return yield* inner.activate(id);
      const active = yield* credentialScope(info.integrationID);
      if (!active) return yield* inner.activate(id);
      if (active.mode !== 'interactive' || info.value.type !== 'oauth' || info.value.methodID !== active.binding.methodID)
        return yield* denied('native_mcp_credential_scope_required', 'mcp.credential');
      return yield* mutate({ ...active, expectedFingerprint: remoteMcpDigest(info) }, 'activate', { id }, inner.activate(id), id);
    }),
    remove: id => Effect.gen(function* () {
      const info = yield* inner.get(id);
      if (!info) return yield* inner.remove(id);
      const active = yield* credentialScope(info.integrationID);
      if (!active) return yield* inner.remove(id);
      if (info.value.type !== 'oauth' || info.value.methodID !== active.binding.methodID)
        return yield* denied('native_mcp_credential_scope_required', 'mcp.credential');
      return yield* mutate({ ...active, expectedFingerprint: active.expectedFingerprint ?? remoteMcpDigest(info) },
        'remove', { id }, inner.remove(id), id);
    }),
  });
  };
  const connectionCredentials = (inner: Credential.Interface, integrations: Integration.Interface, catalog: Catalog): Credential.Interface => {
    const grants = new Map<string, { binding: RemoteMcpOAuthBinding; grant: RemoteMcpOAuthGrant }>();
    const selected = new Map<Credential.ID, { binding: RemoteMcpOAuthBinding; grant: RemoteMcpOAuthGrant; fingerprint: string }>();
    const authority = (integrationID: Integration.ID) => Effect.gen(function* () {
      openCatalog(catalog.location.directory, catalog.acquisitionID);
      const info = yield* integrations.get(integrationID);
      openCatalog(catalog.location.directory, catalog.acquisitionID);
      if (info?.metadata?.source !== 'mcp') return yield* denied('native_mcp_integration_unreviewed', 'mcp.credential');
      const server = bindingFor(catalog.location.directory, info.name, catalog.acquisitionID);
      const methods = info.methods.filter(method => method.type === 'oauth');
      if (methods.length !== 1) return yield* denied('native_mcp_integration_unreviewed', 'mcp.credential');
      const binding = Object.freeze({ ...server, integrationID, methodID: methods[0].id });
      const locations = integrationBindings.get(integrationID) ?? new Map();
      locations.set(binding.directory, server); integrationBindings.set(integrationID, locations); ownedIntegrationIDs.add(integrationID);
      let stored = grants.get(integrationID);
      if (stored && remoteMcpDigest(stored.binding) !== remoteMcpDigest(binding))
        return yield* denied('native_mcp_integration_unreviewed', 'mcp.credential');
      if (!stored) {
        const grant = yield* options.captureConnectionGrant(binding);
        stored = { binding, grant }; grants.set(integrationID, stored);
      }
      yield* stored.grant.reauthorize; openCatalog(binding.directory, binding.acquisitionID);
      return stored;
    });
    const scoped = <A, E, R>(id: Credential.ID, action: Effect.Effect<A, E, R>) => Effect.gen(function* () {
      const value = selected.get(id);
      if (!value) return yield* denied('native_mcp_selected_credential_required', 'mcp.credential');
      yield* value.grant.reauthorize; openCatalog(value.binding.directory, value.binding.acquisitionID);
      return yield* action.pipe(Effect.provideService(OAuthGrant, { ...value, mode: 'connection', credentialID: id,
        expectedFingerprint: value.fingerprint }));
    });
    return Credential.Service.of({ ...inner,
      all: () => denied('native_mcp_credential_scope_required', 'mcp.credential'),
      list: integrationID => Effect.gen(function* () {
        const value = yield* authority(integrationID);
        const rows = yield* inner.list(integrationID);
        openCatalog(value.binding.directory, value.binding.acquisitionID); yield* value.grant.reauthorize;
        const last = rows.at(-1);
        if (!last) return [];
        if (last.integrationID !== integrationID || last.value.type !== 'oauth' || last.value.methodID !== value.binding.methodID)
          return yield* denied('native_mcp_selected_credential_required', 'mcp.credential');
        selected.set(last.id, { ...value, fingerprint: remoteMcpDigest(last) });
        return [last];
      }),
      get: id => scoped(id, Effect.gen(function* () {
        const value = selected.get(id);
        if (!value) return yield* denied('native_mcp_selected_credential_required', 'mcp.credential');
        const rows = yield* inner.list(Integration.ID.make(value.binding.integrationID));
        const current = rows.at(-1);
        if (current?.id !== id || current.value.type !== 'oauth' || current.value.methodID !== value.binding.methodID)
          return yield* denied('native_mcp_selected_credential_required', 'mcp.credential');
        const info = yield* inner.get(id);
        yield* value.grant.reauthorize; openCatalog(value.binding.directory, value.binding.acquisitionID);
        if (info) selected.set(id, { ...value, fingerprint: remoteMcpDigest(info) });
        return info;
      })),
      create: () => denied('native_mcp_credential_scope_required', 'mcp.credential'),
      activate: () => denied('native_mcp_credential_scope_required', 'mcp.credential'),
      update: (id, updates) => scoped(id, inner.update(id, updates)),
      remove: id => scoped(id, inner.remove(id)),
    });
  };
  const removeCredentialOwned=(inner:Integration.Interface,location:Readonly<Location.Info>,credentials:Credential.Interface,id:Credential.ID)=>Effect.gen(function*(){
    if(!options.captureRemovalGrant)return yield* denied('native_mcp_credential_scope_required','mcp.credential');
    const service=originalIntegrations.get(inner),acquisitionID=service&&integrationAcquisitions.get(service);
    if(!acquisitionID)return yield* denied('native_mcp_acquisition_required','mcp.credential');
    openCatalog(location.directory,acquisitionID);
    const record=yield* credentials.get(id);
    openCatalog(location.directory,acquisitionID);
    if(!record||record.value.type!=='oauth')return yield* denied('native_mcp_credential_scope_required','mcp.credential');
    const binding=yield* oauthBinding(inner,location,record.integrationID,record.value.methodID);
    const grant=yield* options.captureRemovalGrant({...binding,credentialID:id});
    yield* grant.reauthorize;openCatalog(binding.directory,binding.acquisitionID);
    yield* credentials.remove(id).pipe(Effect.provideService(OAuthGrant,{binding,grant,mode:'interactive'}));
  });
  return { overrides: [Mcp.node.replace(mcpNode), McpTool.node.replace(toolNode)] satisfies LayerNode.Replacements,
    executeOwned, decorateMcp, decorateIntegration, decorateCredential,
    ownsCredentialIntegration: (id: string) => ownedIntegrationIDs.has(Integration.ID.make(id)),
    removeCredentialOwned,
    closeLocation: (directory: string) => Effect.suspend(() => {
      const catalog = catalogs.get(directory); return catalog ? closeCatalog(catalog) : Effect.void;
    }) };
}
