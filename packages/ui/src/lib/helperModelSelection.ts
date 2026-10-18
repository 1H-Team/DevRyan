export { DEFAULT_HELPER_MODEL_SELECTION, parseHelperModelSelection } from '@openchamber/shared-runtime/lib/helper-model-selection.js';
export type { HelperModelSelection } from '@openchamber/shared-runtime/lib/helper-model-selection.js';

export const createHelperModelRevision = (): string => globalThis.crypto?.randomUUID?.()
  ?? `helper_${Date.now().toString(36)}_${Math.random().toString(36).slice(2)}`;
