import type {NativeManagedJobCancellation,NativeManagedJobInput,NativeManagedJobPhase} from './native-managed-jobs.js';
export const NATIVE_MANAGED_JOB_PHASES:readonly NativeManagedJobPhase[];
export const NATIVE_MANAGED_JOB_COMPLETION:unique symbol;
export function nativeManagedJobInput(value:unknown,phase:'cancelTask'):NativeManagedJobCancellation;
export function nativeManagedJobInput(value:unknown,phase:Exclude<NativeManagedJobPhase,'cancelTask'>):NativeManagedJobInput;
export function nativeManagedJobInput(value:unknown,phase:NativeManagedJobPhase):NativeManagedJobInput|NativeManagedJobCancellation;
