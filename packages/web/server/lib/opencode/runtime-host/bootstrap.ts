import { runControllerEffect } from './controller-effects.js';
import { createHash, timingSafeEqual } from 'node:crypto';
import path from 'node:path';
import { realpath } from 'node:fs/promises';
import { Effect, Exit, Scope } from 'effect';
import { ServerFetch } from '@opencode/server/fetch';
import type { LayerNode } from '@opencode/util/effect/layer-node';
import { createAdmissionGates, type AdmissionGateOptions } from './admission-gates.js';
import { childSessionRoute } from './child-session-route.js';
import { configurationOverrides, configurationOverridesForSnapshot } from './configuration.js';
import type { NativeConfigurationSnapshot } from './native-configuration-snapshot.js';
import { decodeNativeConfigurationSnapshot } from './native-configuration.js';
import { controllerProcessOverrides, type createControllerHelper } from './controller-processes.js';
import { runWithHostRefusal } from './host-refusal.js';
import { runWithRequestPermit } from './native-admission-contract.js';
import { runWithIntegrationGrant } from './native-integration-context.js';
import type { RegistrationOrigin } from './registration-origin.js';
import { trustedPluginOverride, type ReviewedPlugin } from './trusted-plugins.js';
import { Global } from '@opencode/util/global';
import { Database } from '@opencode/core/database/database';
import { Logger } from 'effect';
import { assertNativeCatalog, type NativeCatalogAssertion } from './startup-catalog.js';
import { nativeModelCatalogOverride } from './native-model-catalog.js';
import { createNativeCatalogDiagnostics } from './native-catalog-diagnostics.js';
import type { NativeGlobalRoots, NativeCatalogRequirements } from './native-process-protocol.js';

export interface NativeRuntimeHostOptions extends AdmissionGateOptions {
  readonly helperText?:(request:Request)=>Promise<Response>;
  readonly databasePath: string;
  readonly token: string;
  readonly configuration: unknown;
  readonly configurationSnapshot?: NativeConfigurationSnapshot;
  readonly cursorCatalog?: import('./native-process-protocol.js').NativeCursorCatalog;
  readonly plugins: readonly ReviewedPlugin[];
  readonly additionalPluginOrigins?: readonly RegistrationOrigin[];
  readonly executionOverrides: LayerNode.Replacements;
  /** Reviewed runtime adapters (e.g. the simulation transport), before mandatory gates. */
  readonly platformOverrides?: LayerNode.Replacements;
  readonly drainExecutions: () => Promise<void>;
  readonly controllerHelper?: ReturnType<typeof createControllerHelper>;
  readonly globals?:NativeGlobalRoots;
  readonly readiness?:{readonly hostVersion:string;readonly buildId:string;readonly migration:'completed'|'not-needed';readonly directories:readonly string[];readonly requirements:NativeCatalogRequirements};
}

export function nativeHostAuthorized(authorization: string | null, token: string): boolean {
  const received = authorization?.startsWith('Bearer ') ? authorization.slice(7) : '';
  return timingSafeEqual(createHash('sha256').update(received).digest(), createHash('sha256').update(token).digest());
}

/** The authenticated host exposes only the current sealed location graph. */
export async function nativeToolCatalogRoute(request: Request,
  catalog: ReturnType<typeof createAdmissionGates>['controls']['catalogToolSnapshot'],
  directories?: readonly string[]): Promise<Response> {
  if (request.method !== 'GET') return Response.json({ code: 'method_not_allowed' }, { status: 405, headers: { allow: 'GET' } });
  const query = new URL(request.url).searchParams;
  if ([...query.keys()].some(key => !['directory', 'providerID', 'modelID'].includes(key))
    || query.getAll('directory').length > 1 || query.getAll('providerID').length > 1 || query.getAll('modelID').length > 1) {
    return Response.json({ code: 'invalid_tool_catalog_query' }, { status: 400 });
  }
  const directory = query.get('directory') ?? '';
  const hasControlCharacter = (value: string) => [...value].some(character => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127);
  if (!path.isAbsolute(directory) || path.resolve(directory) !== directory || hasControlCharacter(directory) || directory.length > 4096) {
    return Response.json({ code: 'invalid_tool_catalog_location' }, { status: 400 });
  }
  if (directories && !directories.includes(directory)) return Response.json({ code: 'tool_catalog_location_forbidden' }, { status: 403 });
  try { if (await realpath(directory) !== directory) return Response.json({ code: 'invalid_tool_catalog_location' }, { status: 400 }); }
  catch { return Response.json({ code: 'invalid_tool_catalog_location' }, { status: 400 }); }
  const providerID = query.get('providerID'), modelID = query.get('modelID');
  const validID = (value: string | null) => value !== null && value.length > 0 && value.length <= 256
    && value.trim() === value && !hasControlCharacter(value);
  if ((providerID !== null || modelID !== null) && (!validID(providerID) || !validID(modelID))) {
    return Response.json({ code: 'invalid_tool_catalog_model' }, { status: 400 });
  }
  const snapshot = await catalog(directory, providerID !== null && modelID !== null ? { providerID, modelID } : undefined);
  return snapshot ? Response.json(snapshot) : Response.json({ code: 'tool_catalog_model_not_found' }, { status: 404 });
}

/** The web owner and its authenticated bridge must exist before this is called. */
export async function createNativeRuntimeHost(options: NativeRuntimeHostOptions) {
  if (!path.isAbsolute(options.databasePath) || options.databasePath.includes('\0')) {
    throw new Error('Native runtime requires an explicit absolute database path');
  }
  if (!/^[a-zA-Z0-9_-]{32,256}$/.test(options.token)) throw new Error('Native runtime requires a private bridge token');
  const configurationLocations = options.configurationSnapshot ? decodeNativeConfigurationSnapshot(options.configurationSnapshot) : undefined;
  const gates = createAdmissionGates({ ...options, ...(configurationLocations ? {
    reviewedConfigurationForDirectory: directory => configurationLocations.find(location => location.directory === directory)?.configuration,
    reviewedSkillsForDirectory: directory => options.configurationSnapshot?.locations.find(location => location.directory === directory)?.skills ?? [],
  } : {}) });
  const overrides: LayerNode.Replacements = [
    ...(options.globals ? [Global.node.replace(Global.layerWith(options.globals))] : []),
    ...(options.platformOverrides ?? []),
    ...options.executionOverrides,
    ...(options.configurationSnapshot ? configurationOverridesForSnapshot(options.configurationSnapshot) : configurationOverrides(options.configuration)),
    ...controllerProcessOverrides({ helper: options.controllerHelper }),
    trustedPluginOverride({ plugins: options.plugins, additionalOrigins: options.additionalPluginOrigins ?? [],
      nativePlugins: options.nativePlugins }),
    // LayerNode is last-wins. Only this combined gate may own Tool.node.
    ...gates.overrides,
    nativeModelCatalogOverride(),
    Database.node.replace(Database.configured({ path: options.databasePath }).mapLayer(gates.captureDatabase)),
  ];
  const scope = Effect.runSync(Scope.make());
  let server: ReturnType<typeof Bun.serve> | undefined;
  let closePromise: Promise<void> | undefined;
  let opened = false;
  let catalog: NativeCatalogAssertion = { asserted:false,missing:options.readiness?.requirements ?? { agents:[],plugins:[],tools:[],models:[] },availability:{selections:[]} };
  const close = () => closePromise ??= (async () => {
    opened = false;gates.controls.closePermanently();
    const failures: unknown[] = [];
    // The web owner resolves canonical identities over this read listener
    // while settling native fibers. Keep it alive until their scope closes.
    try { await gates.controls.quiesce(); } catch (error) { failures.push(error); }
    try { await runControllerEffect(Scope.close(scope, Exit.void)); } catch (error) { failures.push(error); }
    try { await server?.stop(true); } catch (error) { failures.push(error); }
    try { await options.drainExecutions(); } catch (error) { failures.push(error); }
    if (failures.length) throw new AggregateError(failures, 'Native host settlement failed');
  })();
  try {
    const diagnostics = createNativeCatalogDiagnostics();
    const handler = await Effect.runPromise(ServerFetch.make({
      database: { path: options.databasePath },
      config: { project: false },
      events: { persist: false },
      fs: { filewatcher: false, fff: false },
      models: { fetch: false, snapshot: false },
      simulation: false,
      app: { name: 'DevRyan', version: '2.0.26', channel: 'native-candidate' },
    }, { overrides }).pipe(Scope.provide(scope), Effect.provide(diagnostics.context), Effect.onError(cause => Effect.sync(() => diagnostics.capture(cause))), Effect.provide(Logger.layer([Logger.withConsoleError(Logger.formatLogFmt)], { mergeWithExisting:false })))).catch(() => {
      throw new Error(`native_catalog_construction_failed_${diagnostics.cause() ?? 'cause_unavailable'}`);
    });
    if (options.readiness) catalog = await assertNativeCatalog({ directories:options.readiness.directories,
      requirements:options.readiness.requirements,
      ...(options.configurationSnapshot ? { requirementsForDirectory:(directory:string)=>options.configurationSnapshot?.locations.find(location=>location.directory===directory)?.requiredCatalogs } : {}),
      cursorCatalog:options.cursorCatalog,handler,tools:gates.controls.catalogTools });
    server = Bun.serve({
      hostname: '127.0.0.1', port: 0, idleTimeout: 60,
      async fetch(request, listener) {
        const peer = listener.requestIP(request)?.address;
        if (!['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(peer ?? '')) {
          return Response.json({ code: 'forbidden' }, { status: 403 });
        }
        if (!nativeHostAuthorized(request.headers.get('authorization'), options.token)) {
          return Response.json({ code: 'unauthorized' }, { status: 401 });
        }
        if (new URL(request.url).pathname === '/devryan/ready' && options.readiness) {
          if (request.method !== 'GET') return new Response(null,{status:405});
          if (!opened || !catalog.asserted || closePromise) return Response.json({ready:false,phase:closePromise?'stopping':!catalog.asserted?'catalog_mismatch':'booting',retryAfterMs:100}, {status:503});
          return Response.json({ready:true,generation:2,opencode:{version:'2.0.26'},host:{version:options.readiness.hostVersion,buildId:options.readiness.buildId},migration:{v1:options.readiness.migration},catalog:{asserted:true,availability:catalog.availability}});
        }
        const result = await runWithHostRefusal(() => runWithIntegrationGrant(request.headers, () => runWithRequestPermit(request.headers, () =>
          ['/devryan/helper-text','/devryan/helper-text/cancel','/devryan/helper-title'].includes(new URL(request.url).pathname) && options.helperText
            ? options.helperText(request)
            : new URL(request.url).pathname === '/devryan/session'
            ? childSessionRoute(request, gates.controls.createChild)
            : new URL(request.url).pathname === '/devryan/tools'
              ? nativeToolCatalogRoute(request, gates.controls.catalogToolSnapshot,
                options.configurationSnapshot?.locations.map(location => location.directory) ?? options.readiness?.directories)
              : handler(request))));
        return result.ok ? result.value : Response.json({ code: result.refusal.code,
          operation: result.refusal.operation }, { status: result.refusal.status });
      },
    });
    return { url: `http://127.0.0.1:${server.port}`, port: server.port,
      catalog,openStartup: async ({announceReady=true}:{announceReady?:boolean}={}) => { if(options.readiness && !catalog.asserted) throw new Error('native_catalog_mismatch'); await gates.controls.openStartup(); opened=announceReady; },
      closeStartup: () => { opened=false;gates.controls.closeStartup(); },quiesce:gates.controls.quiesce,holdAndStop: gates.controls.holdAndStop,
      interruptStoppedHandoff:gates.controls.interruptStoppedHandoff,
      release: gates.controls.release, wakeOwned: gates.controls.wakeOwned, wakeDeferredOwned: gates.controls.wakeDeferredOwned,
      reconcileShellOwned: gates.controls.reconcileShellOwned,
      reconcilePrimaryOwned: gates.controls.reconcilePrimaryOwned,
      queuedPrimaryIdleOwned:gates.controls.queuedPrimaryIdleOwned,prepareQueuedPublication:gates.controls.prepareQueuedPublication,assertQueuedPublication:gates.controls.assertQueuedPublication,
      wakeQueuedParents:gates.controls.wakeQueuedParents,
      observeRecoveredPublication:gates.controls.observeRecoveredPublication,
    persistRecoveredCancellation:gates.controls.persistRecoveredCancellation,
    dropRecoveredCancellationReceipts:gates.controls.dropRecoveredCancellationReceipts,
      cancelRecoveredInputOwned:gates.controls.cancelRecoveredInputOwned,
      recoverShellOwned: gates.controls.recoverShellOwned,
      retentionOwned:gates.controls.retentionOwned, inspectRemovalOwned: gates.controls.inspectRemovalOwned, removeLeafOwned: gates.controls.removeLeafOwned,
      recoverPendingShellOwned: gates.controls.recoverPendingShellOwned,
      interviewActionOwned:gates.controls.interviewActionOwned,
      assertHelperTitleCAS:gates.controls.assertHelperTitleCAS,renameHelperTitleOwned:gates.controls.renameHelperTitleOwned,
      assertReviewedCommand: gates.controls.assertReviewedCommand, executeReviewedCommand: gates.controls.executeReviewedCommand, close };
  } catch (error) {
    try { await close(); } catch (cleanupError) { throw new AggregateError([error, cleanupError], 'Native host boot and cleanup failed'); }
    throw error;
  }
}
