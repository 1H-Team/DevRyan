import { describe, expect, test } from 'bun:test';
import { createPlanRevisionDraft } from './planRevisionDraft';

describe('plan revision draft', () => {
  test('does not save load echoes or unchanged edits', async () => {
    let writes = 0;
    const draft = createPlanRevisionDraft(async () => { writes++; return 'v2'; });
    draft.load('# Plan', 'v1');
    draft.edit('# Plan');
    await draft.save();
    expect(writes).toBe(0);
  });

  test('serializes overlapping edits and uses the last acknowledged version for the latest draft', async () => {
    const writes: Array<{ content: string; version: string }> = [];
    const releases: Array<(version: string) => void> = [];
    const draft = createPlanRevisionDraft((content, version) => {
      writes.push({ content, version });
      return new Promise(resolve => releases.push(resolve));
    });
    draft.load('# Original', 'v1');
    draft.edit('# First');
    const saving = draft.save();
    draft.edit('# Intermediate');
    draft.edit('# Latest');
    expect(draft.save()).toBe(saving);
    expect(writes).toEqual([{ content: '# First', version: 'v1' }]);
    expect(draft.observe('v2')).toBe('pending');
    releases[0]('v2');
    await Promise.resolve();
    expect(writes).toEqual([{ content: '# First', version: 'v1' }, { content: '# Latest', version: 'v2' }]);
    releases[1]('v3');
    await saving;
    expect(draft.snapshot()).toMatchObject({ content: '# Latest', version: 'v3', dirty: false, conflict: false });
  });

  test('preserves a rejected draft without adopting the stale-response version or retrying', async () => {
    let writes = 0;
    const draft = createPlanRevisionDraft(async () => {
      writes++;
      throw Object.assign(new Error('The saved plan changed'), { status: 409, code: 'plan_version_conflict', version: 'v2' });
    });
    draft.load('# Original', 'v1');
    draft.edit('# Draft');
    await draft.save();
    expect(draft.snapshot()).toMatchObject({ content: '# Draft', version: 'v1', dirty: true, conflict: true });
    draft.edit('# Latest draft');
    await draft.save();
    expect(writes).toBe(1);
  });

  test('refreshes a clean revision and preserves a dirty draft on an external update or late load', () => {
    const draft = createPlanRevisionDraft(async () => 'v3');
    draft.load('# Original', 'v1');
    expect(draft.observe('v1')).toBe('ignore');
    expect(draft.observe('v2')).toBe('reload');
    draft.load('# Updated', 'v2');
    draft.edit('# My draft');
    expect(draft.observe('v3')).toBe('conflict');
    draft.load('# External', 'v3');
    expect(draft.snapshot()).toMatchObject({ content: '# My draft', version: 'v2', conflict: true });
  });

  test('defers an in-flight event until the ack distinguishes own writes from another writer', async () => {
    let release: (version: string) => void = () => {};
    const draft = createPlanRevisionDraft(() => new Promise(resolve => { release = resolve; }));
    draft.load('# Original', 'v1');
    draft.edit('# Draft');
    const saving = draft.save();
    expect(draft.observe('v-external')).toBe('pending');
    draft.edit('# Latest');
    release('v2');
    await saving;
    expect(draft.snapshot()).toMatchObject({ content: '# Latest', version: 'v2', conflict: true, dirty: true });
  });
});
