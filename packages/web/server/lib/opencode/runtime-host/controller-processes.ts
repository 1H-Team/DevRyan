import { Pty } from '@opencode/core/pty';
import { PersistentPty } from '@opencode/core/persistent-pty';
import type { LayerNode } from '@opencode/util/effect/layer-node';
import { AppProcess } from '@opencode/util/process';
import { Duration, Effect, Layer, Schema, Stream } from 'effect';
import { ChildProcessSpawner } from 'effect/unstable/process';
import { HostRefusal, refuseHost } from './host-refusal.js';
import type { ExecutionRpc } from './worker-protocol.js';
import { TerminationReceipt } from './worker-protocol.js';
import { isReviewedControllerGitArgs } from '../execution-helper-policy.js';

export type ControllerHelper = AppProcess.Interface['run'];
const HelperResult = Schema.Struct({ exitCode: Schema.Int, stdout: Schema.String, stderr: Schema.String, receipt: TerminationReceipt });
/** Discovery runs through the web supervisor, with no agent/control lease. */
export function createControllerHelper({ rpc }: { readonly rpc: ExecutionRpc }): ControllerHelper {
  return (command, options) => Effect.gen(function* () {
    if (command._tag !== 'StandardCommand' || !['git', 'git.exe'].includes(command.command.split(/[\\/]/).at(-1) ?? '')
      || !isReviewedControllerGitArgs(command.args) || !command.options.cwd || options?.stdin !== undefined)
      return yield* refuseHost(new HostRefusal('controller_helper_denied', 403, 'controller_process'));
    const value = yield* Effect.tryPromise({ try: (signal) => rpc('execution.native.helper', {
      command: command.command, args: [...command.args], cwd: command.options.cwd,
      maxOutputBytes: options?.maxOutputBytes, maxErrorBytes: options?.maxErrorBytes,
      timeoutMs: options?.timeout === undefined ? 10_000 : Duration.toMillis(Duration.fromInputUnsafe(options.timeout)),
    }, { signal: options?.signal ? AbortSignal.any([signal, options.signal]) : signal }),
    catch: () => new HostRefusal('controller_helper_unavailable', 503, 'controller_process') })
      .pipe(Effect.catch((refusal) => refuseHost(refusal)));
    const result = yield* Effect.try({ try: () => Schema.decodeUnknownSync(HelperResult)(value),
      catch: () => new HostRefusal('mutation_termination_unconfirmed', 503, 'controller_process') })
      .pipe(Effect.catch((refusal) => refuseHost(refusal)));
    if (!result.receipt.terminated || !result.receipt.confined || result.receipt.cancelled || result.exitCode !== result.receipt.exitCode)
      return yield* refuseHost(new HostRefusal('mutation_termination_unconfirmed', 503, 'controller_process'));
    const stdout = Buffer.from(result.stdout, 'base64'), stderr = Buffer.from(result.stderr, 'base64');
    return { command: command.command, exitCode: result.exitCode, stdout, stderr,
      ...(options?.combineOutput ? { output: Buffer.concat([stdout, stderr]), outputTruncated: false } : {}),
      stdoutTruncated: false, stderrTruncated: false };
  });
}

/** Native subprocess helpers must acquire an owned execution view first. */
export function controllerProcessOverrides({ helper }: { readonly helper?: ControllerHelper } = {}): LayerNode.Replacements {
  const denied = () => refuseHost(new HostRefusal('owned_execution_required', 403, 'controller_process'));
  const processService: AppProcess.Interface = {
    ...ChildProcessSpawner.make(denied),
    run: helper ?? denied,
    runStream: () => Stream.fromEffect(denied()),
  };
  // PTYs bypass AppProcess and cannot produce the supervisor's termination receipt.
  const pty: Pty.Interface = {
    list: () => Effect.succeed([]), get: denied, create: denied, update: denied,
    remove: denied, write: denied, attach: denied,
  };
  const persistentPty: PersistentPty.Interface = {
    list: denied, get: denied, create: denied, write: denied, resize: denied,
    control: denied, input: denied, snapshot: denied, read: denied, remove: denied,
    shutdown: () => Effect.void, handoff: denied, attach: denied,
  };
  return [
    AppProcess.node.replace(Layer.succeed(AppProcess.Service, processService)),
    Pty.node.replace(Layer.succeed(Pty.Service, pty)),
    PersistentPty.node.replace(Layer.succeed(PersistentPty.Service, persistentPty)),
  ];
}
