/** Shared settings identity for title, commit, PR and notification helpers.
 * No `variant` means provider Default reasoning. */
export const DEFAULT_HELPER_MODEL_SELECTION = Object.freeze({
  providerID: 'opencode', modelID: 'deepseek-v4.1-flash', revision: 'default',
});

export function parseHelperModelSelection(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).some(key => !['providerID', 'modelID', 'variant', 'revision'].includes(key))) return undefined;
  const valid = text => typeof text === 'string' && text.length > 0 && text.length <= 256 && !/[\x00-\x20\x7f]/.test(text);
  if (!valid(value.providerID) || !valid(value.modelID) || !valid(value.revision)) return undefined;
  if (value.variant !== undefined && !valid(value.variant)) return undefined;
  return { providerID: value.providerID, modelID: value.modelID, ...(value.variant !== undefined ? { variant: value.variant } : {}), revision: value.revision };
}
