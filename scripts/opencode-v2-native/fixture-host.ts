import {Effect} from 'effect';
// This executable is started only after the parent has installed an owned
// HOME/XDG/TMP environment. Static native imports must never see app state.
import fs from 'node:fs/promises';
import assert from 'node:assert/strict';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { createNativeRuntimeHost } from '../../packages/web/server/lib/opencode/runtime-host/bootstrap.ts';
import { createExecutionRouting } from '../../packages/web/server/lib/opencode/runtime-host/execution-routing.ts';
import { createControllerHelper } from '../../packages/web/server/lib/opencode/runtime-host/controller-processes.ts';
import { createRemoteNativeAdmissionBridge } from '../../packages/web/server/lib/opencode/runtime-host/native-admission-bridge.ts';
import { createReviewedNativePluginRegistry } from '../../packages/web/server/lib/opencode/runtime-host/native-plugin-registry.ts';
import { managedTaskPlugin, withManagedTaskExecution } from '../../packages/web/server/lib/opencode/runtime-host/managed-task.ts';
import { primaryStepOverride } from '../../packages/web/server/lib/opencode/runtime-host/primary-step.ts';
import { runWithRequestPermit, requestPermit } from '../../packages/web/server/lib/opencode/runtime-host/native-admission-contract.ts';
import { makeNativeSimulation } from './simulation.ts';
import { attachDriveController, type DriveController, type DriveRequest, type DriveReply } from './drive-controller.mjs';
import { toolTurn, parallelWriterTurn, managedTaskTurn, backgroundShellTurn } from './assertions.mjs';
import { sameFileWriterTurn } from './writer-edge-cases.mjs';
import { backgroundRestartTurn } from './background-restart-turn.mjs';

const record = (input: unknown): input is Record<string, unknown> => !!input && typeof input === 'object' && !Array.isArray(input);
const string = (value: unknown, field: string): string => { if (typeof value !== 'string' || !value) throw new Error(`Missing ${field}`); return value; };
interface NativeErrorEvidence { readonly name: string; readonly message: string; readonly code?: string; readonly causes?: readonly NativeErrorEvidence[] }
const nativeErrorEvidence = (error: unknown, depth = 0): NativeErrorEvidence => {
  const causes = error instanceof AggregateError ? error.errors : error instanceof Error && error.cause !== undefined ? [error.cause] : [];
  return { name: error instanceof Error ? error.name : 'NativeFixtureError',
    message: (error instanceof Error ? error.message : 'native_fixture_failed').slice(0, 8192),
    ...(record(error) && typeof error.code === 'string' ? { code: error.code } : {}),
    ...(depth < 5 && causes.length ? { causes: causes.slice(0, 8).map(cause => nativeErrorEvidence(cause, depth + 1)) } : {}) };
};
const trace = (event: string, fields: Record<string, unknown>) => process.stderr.write(`${JSON.stringify({ event, at: Date.now(), ...fields })}\n`);
const tracedResponder = (caseID: string, marker: string, responder: (request: DriveRequest) => DriveReply | Promise<DriveReply>) => async (request: DriveRequest): Promise<DriveReply> => {
  trace('model_request', { caseID, requestID: request.id, markerPresent: JSON.stringify(request.body).includes(marker) });
  try {
    assert.ok(record(request.body) && Array.isArray(request.body.tools), 'Native model catalog missing');
    const forbidden = request.body.tools.some(tool => record(tool) && record(tool.function)
      && ['execute', 'subagent'].includes(String(tool.function.name)));
    assert.equal(forbidden, false, 'Native model catalog exposed an unowned executor');
    const reply = await responder(request);
    trace('model_response', { caseID, requestID: request.id, reason: reply.reason });
    return reply;
  } catch (error) { trace('model_responder_failed', { caseID, requestID: request.id, nativeError: nativeErrorEvidence(error) }); throw error; }
};
const settings: unknown = JSON.parse(await fs.readFile(string(process.argv[2], 'fixture file'), 'utf8'));
if (!record(settings)) throw new Error('Invalid fixture file');
const root = await fs.realpath(string(settings.root, 'root'));
for (const name of ['HOME', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_STATE_HOME', 'XDG_CACHE_HOME', 'TMPDIR']) {
  const value = await fs.realpath(string(process.env[name], name));
  if (!value.startsWith(`${root}${path.sep}`)) throw new Error('Native fixture environment escaped owned root');
}
const rpc = async (method: string, input: unknown, options?: { readonly signal?: AbortSignal }): Promise<unknown> => {
  if (method === 'native.primary-step') trace('primary_step_rpc_start', { method });
  const response = await fetch(string(settings.bridgeUrl, 'bridgeUrl'), { method: 'POST',
    // The Node private host explicitly closes every response connection. Bun
    // can otherwise reuse the closing socket before its FIN is observed.
    headers: { authorization: `Bearer ${string(settings.bridgeToken, 'bridgeToken')}`, 'content-type': 'application/json', connection: 'close' },
    body: JSON.stringify({ method, params: input }), signal: options?.signal ?? AbortSignal.timeout(30_000) });
  const value: unknown = await response.json();
  if (!response.ok || !record(value) || value.ok !== true) {
    const code = record(value) && record(value.error) && typeof value.error.code === 'string' ? value.error.code : 'private_rpc_failed';
    if (method === 'native.primary-step') trace('primary_step_rpc_failed', { method, code });
    throw Object.assign(new Error(code), { code, status: response.status });
  }
  if (method === 'native.primary-step') trace('primary_step_rpc_completed', { method });
  return value.result;
};
const bridge = createRemoteNativeAdmissionBridge({ rpc });
const routing = createExecutionRouting({ rpc, bridge, directory: string(settings.directory, 'directory'),
  readRoots: [string(settings.directory, 'directory')], protectedRoots: [path.join(root, 'home'), path.join(root, 'web-data')] });
const origin = { kind: 'plugin' as const, id: 'opencode.simulation.tools',
  manifestDigest: string(settings.simulationDigest, 'simulationDigest'), capabilities: ['provider'] as const };
const simulation = makeNativeSimulation(string(settings.simulationEndpoint, 'simulationEndpoint'), origin);
const managedOrigin = { kind: 'plugin' as const, id: 'devryan.managed-task',
  manifestDigest: string(settings.managedDigest, 'managedDigest'), capabilities: ['managed-task'] as const };
let driver: DriveController | undefined;
let current: { complete: () => unknown; cancelled?: () => unknown; holding?: () => unknown } | undefined;
let host: Awaited<ReturnType<typeof createNativeRuntimeHost>> | undefined;
let closing: Promise<void> | undefined;
const close = () => closing ??= (async () => {
  const failures: unknown[] = [];
  try { await host?.close(); } catch (error) { failures.push(error); }
  try { await driver?.close(); } catch (error) { failures.push(error); }
  if (failures.length) throw new AggregateError(failures, 'Native fixture drain failed');
})();
const write = (input: unknown) => process.stdout.write(`DEVRYAN_NATIVE_ACCEPTANCE ${JSON.stringify(input)}\n`);
try {
  host = await createNativeRuntimeHost({ databasePath: string(settings.databasePath, 'databasePath'),
    token: string(settings.token, 'token'), configuration: settings.configuration, plugins: [{ plugin: managedTaskPlugin, origin: managedOrigin }], additionalPluginOrigins: [origin],
    bridge, executeOwned: withManagedTaskExecution({ origin: managedOrigin, directory: string(settings.directory, 'directory'), rpc,
      executeOwned: routing.executeOwned }), nativePlugins: createReviewedNativePluginRegistry(string(settings.coreDigest, 'coreDigest')),
    executionOverrides: [...routing.overrides, primaryStepOverride(rpc,undefined,event=>host?host.wakeQueuedParents(event):Effect.void,undefined,undefined,undefined,undefined,events=>host?host.prepareQueuedPublication(events):Effect.succeed([]),event=>host?host.assertQueuedPublication(event):Effect.void)], platformOverrides: simulation.overrides, controllerHelper: createControllerHelper({ rpc }),
    drainExecutions: routing.close });
  driver = await attachDriveController(simulation.endpoint, () => { throw new Error('Model inference occurred outside an acceptance case'); });
  write({ type: 'ready', url: host.url });
  const lines = createInterface({ input: process.stdin });
  for await (const line of lines) {
    if (Buffer.byteLength(line) > 64 * 1024) throw new Error('Fixture command exceeded bound');
    const command: unknown = JSON.parse(line);
    if (!record(command) || !Number.isSafeInteger(command.id)) throw new Error('Invalid fixture command');
    try {
      if (command.action === 'open') { await host.openStartup(); write({ id: command.id, ok: true }); }
      else if(command.action==='queued-primary-idle-owned'){const input=command;await runWithRequestPermit(new Headers({'x-devryan-native-permit':JSON.stringify(input.permit)}),async()=>{const permit=requestPermit();if(!permit)throw Error('fixture_permit_required');await host!.queuedPrimaryIdleOwned({sessionID:string(input.sessionID,'sessionID'),messageID:input.messageID===undefined?undefined:string(input.messageID,'messageID'),permit});});write({id:command.id,ok:true});}
      else if (command.action === 'scenario') {
        const caseID = string(command.caseID, 'caseID');
        const turn = command.backgroundRestart === true ? backgroundRestartTurn(caseID, command.input)
          : command.parallel === true ? parallelWriterTurn(caseID) : command.sameFile === true ? sameFileWriterTurn(caseID)
          : command.background === true ? backgroundShellTurn(caseID, command.input)
            : toolTurn(string(command.tool, 'tool'), command.input, caseID, { deniedInventory: command.deniedInventory === true });
        await driver.setResponder(tracedResponder(caseID, turn.marker, turn.responder)); current = turn;
        write({ id: command.id, ok: true, marker: turn.marker });
      } else if (command.action === 'resume-background-restart') {
        const caseID = string(command.caseID, 'caseID');
        const turn = backgroundRestartTurn(caseID, undefined, { resumeShellID: string(command.shellID, 'shellID') });
        await driver.setResponder(tracedResponder(caseID, turn.marker, turn.responder)); current = turn;
        write({ id: command.id, ok: true });
      } else if (command.action === 'background-restart-state') {
        if (!current?.holding) throw new Error('Background restart scenario missing');
        write({ id: command.id, ok: true, result: current.holding() });
      } else if (command.action === 'scenario-managed') {
        const turn = managedTaskTurn(string(command.caseID, 'caseID'), string(command.agent, 'agent'));
        await driver.setResponder(tracedResponder(string(command.caseID, 'caseID'), turn.marker, turn.responder)); current = turn;
        write({ id: command.id, ok: true, marker: turn.marker, childMarker: turn.childMarker, callIDs: turn.callIDs });
      } else if (command.action === 'complete') {
        driver.check(); if (!current) throw new Error('Missing acceptance scenario');
        write({ id: command.id, ok: true, result: current.complete(), requestCount: driver.requests.length });
      } else if (command.action === 'cancelled') {
        driver.check(); if (!current?.cancelled) throw new Error('Missing cancellable acceptance scenario');
        write({ id: command.id, ok: true, result: current.cancelled() });
      } else if (command.action === 'wake-owned') {
        const wakeHost = host;
        await runWithRequestPermit(new Headers({ 'x-devryan-native-permit': JSON.stringify(command.permit) }), async () => {
          const permit = requestPermit(); if (!permit) throw new Error('Owned wake permit required');
          await wakeHost.wakeOwned({ sessionID: string(command.sessionID, 'sessionID'), permit });
        });
        write({ id: command.id, ok: true });
      } else if (command.action === 'wake-deferred-owned') {
        const wakeHost = host;
        const result = await runWithRequestPermit(new Headers({ 'x-devryan-native-permit': JSON.stringify(command.permit) }), async () => {
          const permit = requestPermit(); if (!permit) throw new Error('Owned deferred wake permit required');
          return wakeHost.wakeDeferredOwned({ sessionID: string(command.sessionID, 'sessionID'), permit });
        });
        write({ id: command.id, ok: true, result });
      } else if (command.action === 'reconcile-shell-owned') {
        const reconcileHost = host;
        const result = await runWithRequestPermit(new Headers({ 'x-devryan-native-permit': JSON.stringify(command.permit) }), async () => {
          const permit = requestPermit(); if (!permit) throw new Error('Owned reconciliation permit required');
          return reconcileHost.reconcileShellOwned({ sessionID: string(command.sessionID, 'sessionID'),
            messageID: string(command.messageID, 'messageID'), permit });
        });
        write({ id: command.id, ok: true, result });
      } else if (command.action === 'recover-shell-owned') {
        await host.recoverShellOwned({ sessionID: string(command.sessionID, 'sessionID'), jobID: string(command.jobID, 'jobID') });
        write({ id: command.id, ok: true });
      } else if (command.action === 'inspect-removal-owned' || command.action === 'remove-leaf-owned') {
        const removalHost = host;
        const result = await runWithRequestPermit(new Headers({ 'x-devryan-native-permit': JSON.stringify(command.permit) }), async () => {
          const permit = requestPermit(); if (!permit) throw new Error('Owned removal permit required');
          const sessionID = string(command.sessionID, 'sessionID');
          return command.action === 'inspect-removal-owned'
            ? removalHost.inspectRemovalOwned({ sessionID, permit })
            : removalHost.removeLeafOwned({ sessionID, intentID: string(command.intentID, 'intentID'), permit });
        });
        write({ id: command.id, ok: true, result });
      } else if (command.action === 'hold') { await host.holdAndStop(string(command.sessionID, 'sessionID')); write({ id: command.id, ok: true }); }
      else if (command.action === 'release') { await host.release(string(command.sessionID, 'sessionID')); write({ id: command.id, ok: true }); }
      else if (command.action === 'close') { await close(); write({ id: command.id, ok: true }); lines.close(); process.stdin.destroy(); break; }
      else throw new Error('Unknown fixture command');
    } catch (error) { write({ id: command.id, ok: false, error: error instanceof Error ? error.message : 'fixture_command_failed', nativeError: nativeErrorEvidence(error) }); }
  }
} catch (error) {
  write({ type: 'failed', error: error instanceof Error ? error.message : 'native_boot_failed', nativeError: nativeErrorEvidence(error) }); process.exitCode = 1;
} finally { try { await close(); } catch (error) { write({ type: 'cleanup_failed', error: error instanceof Error ? error.message : 'native_cleanup_failed', nativeError: nativeErrorEvidence(error) }); process.exitCode = 1; } }
