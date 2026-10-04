import type { RuntimeBundleDescriptor, RuntimeBundleSelection } from './runtime-bundle.js';
export interface RuntimeBundleBinding {
  readonly controlRoot: string;
  readonly bundleRoot: string;
  readonly selection: RuntimeBundleSelection;
  readonly descriptor: RuntimeBundleDescriptor;
  readonly rollbackRecovery?:{readonly reason:string;readonly candidateBundleID?:string;readonly targetBundleID?:string};
  readonly admission: 'held' | 'pending';
}
export function readRuntimeBundleBinding(environment?: Readonly<Record<string, string | undefined>>,options?:{readonly allowHeldInspection?:boolean}): RuntimeBundleBinding | null;
export let selectedRuntimeBundle: RuntimeBundleBinding | null;
export function getRuntimeHome(): string;
export function initializeRuntimeBundleBinding(environment?: Readonly<Record<string,string|undefined>>,options?:{readonly allowHeldInspection?:boolean}):RuntimeBundleBinding;
