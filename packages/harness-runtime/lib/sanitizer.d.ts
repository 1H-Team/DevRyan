export { createDiagnosticSanitizer } from '../index.js';
export function sanitizeNativeSchemaPath(value: unknown): boolean;
/** Behaviour switches a harness run fingerprint records, by exact name. */
export const HARNESS_BEHAVIOUR_SWITCHES: readonly string[];
export type HarnessBehaviourSwitchValue = 'unset' | '0' | '1' | 'true' | 'false' | 'on' | 'off' | 'yes' | 'no' | 'other';
export const HARNESS_BEHAVIOUR_SWITCH_VALUES: readonly HarnessBehaviourSwitchValue[];
/** Reduces an environment value to its enum; the raw value is never kept. */
export function normalizeBehaviourSwitch(value: string | undefined): HarnessBehaviourSwitchValue;
