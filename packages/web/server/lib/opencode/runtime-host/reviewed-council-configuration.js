import { nativeModelSelection } from './native-configuration-data.js';

/** Preserve the existing preset and ordered saved Council selection. Snapshot
 * acquisition already resolves project/global companion-file precedence. */
export function reviewedCouncilMembers(snapshot, { directory, preset }) {
  const location = snapshot?.locations.find(value => value.directory === directory);
  if (!location) throw Object.assign(new Error('native_council_location_unreviewed'), { code: 'native_council_location_unreviewed' });
  const council = location.compatibility.agents.council;
  const entries = preset.trim().toLowerCase() === 'cursor-composer-2' ? [{ model: 'cursor-acp/composer-2' }]
    : Array.isArray(council?.councillors) && council.councillors.length ? council.councillors
      : council?.model ? [{ model: council.model, variant: council.variant }] : [];
  return entries.map(entry => {
    const model = nativeModelSelection(entry.model);
    const variant = typeof entry.variant === 'string' ? entry.variant.trim() : '';
    return { providerId: model.providerID, modelId: model.model,
      variant: variant && !['null', 'undefined'].includes(variant) ? variant : null, agent: 'builder', timeoutMs: 180_000 };
  });
}
