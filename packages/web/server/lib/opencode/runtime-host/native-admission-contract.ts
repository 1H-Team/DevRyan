import { Context, Effect } from 'effect';
import { AsyncLocalStorage } from 'node:async_hooks';
import type { Tool } from '@opencode/core/tool';
import type { Tool as ToolSchema } from '@opencode/schema/tool';
import type { RegistrationOrigin } from './registration-origin.js';
import type { Permission } from '@opencode/core/permission';
import type { Location } from '@opencode/core/location';
import { HostRefusal } from './host-refusal.js';

/** Tokens are private bridge handles, never native metadata or caller fingerprints. */
export interface OperationPermit { readonly token: string; readonly sessionID?: string; readonly revision: number }
export interface OperationRequest {
  readonly operation: string;
  readonly sessionID?: string;
  readonly messageID?: string;
  readonly input?: unknown;
  readonly existingPermit?: OperationPermit;
  /** Issued privately at the reviewed native command executor boundary. Never decoded from session input. */
  readonly derivation?: string;
}
export interface ShellJobRegistration {
  readonly permit: OperationPermit;
  readonly authorization: OperationRequest;
  readonly jobID: string;
  readonly command: string;
  readonly handle: string;
  readonly directory: string;
  readonly sessionID: string;
  readonly messageID: string;
  readonly callID: string;
  readonly tool: 'shell';
}
export interface NativeAdmissionBridge {
  readonly queuedAdmissionRejected?: (permit:OperationPermit,messageID:string)=>Promise<void>;
  readonly queuedAdmissionCommitted?: (input: import('./native-queued-input.js').QueuedInputWitness) => Promise<void>;
  readonly queuedDeliveryAuthorized?: (input: import('./native-queued-input.js').QueuedInputWitness) => Promise<void>;
  readonly queuedBlocked?: (permit: OperationPermit, sessionID: string) => Promise<void>;
  readonly queuedWake?: (sessionID: string) => Promise<void>;
 readonly retention?:(permit:OperationPermit,members:readonly import('./native-retention-quiet.js').NativeRetentionMember[],acquire:boolean)=>Promise<void>;
  readonly beginCommand?: (input: { readonly permit: OperationPermit; readonly sessionID: string; readonly name: string;
    readonly definition: unknown; readonly invocation: unknown; readonly model?: unknown;readonly origin?:RegistrationOrigin }) => Promise<string>;
  readonly awaitReady: () => Promise<void>;
  readonly authorize: (request: OperationRequest) => Promise<OperationPermit>;
  readonly recheck: (permit: OperationPermit, request: OperationRequest) => Promise<void>;
  readonly release: (permit: OperationPermit) => Promise<void>;
  readonly sealPrompt: (permit: OperationPermit, input: unknown) => Promise<Readonly<Record<string, unknown>>>;
  readonly verifyAccepted: (permit: OperationPermit, accepted: unknown) => Promise<void>;
  readonly registerShellJob: (input: ShellJobRegistration) => Promise<void>;
  readonly sealSynthetic: (permit: OperationPermit, input: unknown) => Promise<Readonly<Record<string, unknown>>>;
  readonly deferContinuation: (sessionID: string, operation: string) => Promise<void>;
  readonly hold: (sessionID: string) => Promise<void>;
  readonly releaseHold: (sessionID: string) => Promise<void>;
  readonly isHeld: (sessionID: string) => Promise<boolean>;
}
export const OperationPermitRef = Context.Reference<OperationPermit | undefined>(
  'DevRyan/OperationPermit', { defaultValue: () => undefined },
);
export type NativeExecutor = ToolSchema.Info['execute'];
export interface OwnedToolInvocation {
  readonly toolID: string;
  /** Actual native registry/call name, when namespace normalization differs. */
  readonly nativeToolID?: string;
  readonly provenance: RegistrationOrigin;
  readonly input: unknown;
  readonly nativeContext: Tool.Context;
  readonly location: Readonly<Location.Info>;
  readonly existingPermit: OperationPermit;
  readonly recheckPermit: () => Effect.Effect<void>;
  readonly nativePermissionAssert: Permission.Interface['assert'];
  readonly executeNative: () => ReturnType<NativeExecutor>;
}
export type ExecuteOwned = (invocation: OwnedToolInvocation) => ReturnType<NativeExecutor>;
const incomingPermits = new AsyncLocalStorage<OperationPermit>();
export const requestPermit = (): OperationPermit | undefined => incomingPermits.getStore();
export async function runWithRequestPermit<A>(headers: Headers, action: () => Promise<A>): Promise<A> {
  const value = headers.get('x-devryan-native-permit');
  if (!value) return action();
  const invalid = () => new HostRefusal('native_permit_header_invalid', 403, 'request.permit');
  if (value.length > 2048) throw invalid();
  let permit: unknown;
  try { permit = JSON.parse(value); } catch { throw invalid(); }
  if (typeof permit !== 'object' || permit === null || !('token' in permit) || typeof permit.token !== 'string'
    || !/^[a-f0-9]{64}$/.test(permit.token) || !('revision' in permit) || typeof permit.revision !== 'number'
    || !Number.isSafeInteger(permit.revision) || permit.revision < 0
    || ('sessionID' in permit && (typeof permit.sessionID !== 'string' || !/^ses[0-9A-Za-z_-]{1,128}$/.test(permit.sessionID)))) throw invalid();
  return incomingPermits.run({ token: permit.token, revision: Number(permit.revision),
    ...('sessionID' in permit && typeof permit.sessionID === 'string' ? { sessionID: permit.sessionID } : {}) }, action);
}
