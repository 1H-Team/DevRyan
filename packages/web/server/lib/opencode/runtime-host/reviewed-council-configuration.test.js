import { expect, test } from 'vitest';
import { reviewedCouncilMembers } from './reviewed-council-configuration.js';

test('Council uses the captured location order, effort and existing explicit preset', () => {
  const snapshot = { locations: [
    { directory: '/one', compatibility: { agents: { council: { model: 'unused/default', councillors: [
      { model: 'openai/exact', variant: 'medium' }, { model: 'saved/model/with/slashes', variant: null }] } } } },
    { directory: '/two', compatibility: { agents: { council: { model: 'local/second', variant: 'high' } } } },
  ] };
  expect(reviewedCouncilMembers(snapshot, { directory: '/one', preset: 'default' })).toEqual([
    { providerId: 'openai', modelId: 'exact', variant: 'medium', agent: 'builder', timeoutMs: 180_000 },
    { providerId: 'saved', modelId: 'model/with/slashes', variant: null, agent: 'builder', timeoutMs: 180_000 },
  ]);
  expect(reviewedCouncilMembers(snapshot, { directory: '/two', preset: 'other-saved-label' })[0]).toMatchObject({ providerId: 'local', modelId: 'second', variant: 'high' });
  expect(reviewedCouncilMembers(snapshot, { directory: '/one', preset: 'CURSOR-COMPOSER-2' })[0]).toMatchObject({ providerId: 'cursor-acp', modelId: 'composer-2', variant: null });
  expect(() => reviewedCouncilMembers(snapshot, { directory: '/foreign', preset: 'default' })).toThrow('native_council_location_unreviewed');
});
