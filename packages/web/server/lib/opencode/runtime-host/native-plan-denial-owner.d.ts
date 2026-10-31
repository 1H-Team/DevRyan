import type { SessionMutationRuntime } from '../../../../../harness-runtime/lib/session-mutations.js';
import type { NativeAdmissionOwnerOptions } from './native-admission-owner.js';

/** The refusal for a tool Plan mode cannot run, with guidance for the model. */
export function planWriteDenied(tool: unknown): Error & { readonly code: 'native_plan_write_denied'; readonly status: 403; readonly statusCode: 403 };

/** Private canonical pending-call reader and existing guarded cancellation owner. */
export function createNativePlanDenialOwner(options: {
  readonly runtime: Pick<SessionMutationRuntime, 'cancelUnstartedCall'>;
  readonly readMessage: (sessionID: string, messageID: string, directory: string) => Promise<{
    readonly info: { readonly id: string; readonly sessionID?: string; readonly role?: string;
      readonly time?: { readonly completed?: number } };
    readonly parts: readonly { readonly type: string; readonly callID?: string; readonly tool?: string;
      readonly state?: { readonly status?: string } }[];
  } | null | undefined>;
}): NonNullable<NativeAdmissionOwnerOptions['recordPlanToolDenial']>;
