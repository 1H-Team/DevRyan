import { readFileSync } from 'node:fs';

import {
  AUTO_RESUME_ACTIVE_STATES,
  MANAGED_RESULT_COMPACTED_FIELDS,
  MANAGED_RESULT_PAGE_MAX_BYTES,
  MANAGED_TASK_FAILURE_KINDS,
  MANAGED_TASK_LIVE_STATUSES,
  MANAGED_TASK_TERMINAL_STATUSES,
} from '@openchamber/orchestration-runtime';
import { describe, expect, it } from 'vitest';

// The plugin is copied into the OpenCode config directory and cannot import the
// orchestration runtime, so it keeps literal copies of the codec's constants.
// This test reads those copies from its source and holds them equal.
const source = readFileSync(new URL('./devryan-managed-orchestration.mjs', import.meta.url), 'utf8');

const declaration = (name) => {
  const match = source.match(new RegExp(`^const ${name} = (?:new Set\\()?\\[([^\\]]*)\\]\\)?;`, 'm'));
  if (!match) throw new Error(`plugin constant ${name} was not found`);
  return [...match[1].matchAll(/'([^']*)'/g)].map(entry => entry[1]);
};

describe('managed orchestration plugin copies of the codec constants', () => {
  it('auto-resume active states', () => {
    expect(declaration('AUTO_RESUME_ACTIVE_STATES')).toEqual([...AUTO_RESUME_ACTIVE_STATES]);
  });

  it('live and terminal task statuses', () => {
    expect(declaration('LIVE_TASK_STATUSES')).toEqual([...MANAGED_TASK_LIVE_STATUSES]);
    expect(declaration('TERMINAL_TASK_STATUSES')).toEqual([...MANAGED_TASK_TERMINAL_STATUSES]);
  });

  it('compacted result payload fields', () => {
    expect(declaration('DUPLICATE_RESULT_PAYLOAD_FIELDS')).toEqual([...MANAGED_RESULT_COMPACTED_FIELDS]);
  });

  it('result page limit', () => {
    const match = source.match(/^const RESULT_PAGE_MAX_BYTES = (\d+) \* (\d+);/m);
    expect(match && Number(match[1]) * Number(match[2])).toBe(MANAGED_RESULT_PAGE_MAX_BYTES);
  });

  it('every failure kind the plugin compares against', () => {
    const kinds = [...new Set([...source.matchAll(/failureKind [!=]== '([a-z_]+)'/g)].map(entry => entry[1]))];
    expect(kinds.length).toBeGreaterThan(0);
    expect(kinds.filter(kind => !MANAGED_TASK_FAILURE_KINDS.includes(kind))).toEqual([]);
  });
});
