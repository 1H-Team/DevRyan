import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  BUSY_STATUS,
  IDLE_STATUS,
  activeSessionIDs,
  filterStatusesByDirectory,
  isSameStatus,
  reconcileActiveStatuses,
  retryStatusFromMessages,
  statusForEvent,
  statusesFromActive,
  toV1RetryStatus,
} from './status.js';

const VECTORS = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '__vectors__');
const loadVector = (file) => JSON.parse(fs.readFileSync(path.join(VECTORS, file), 'utf8'));
const rest = (file, label) => {
  const entry = loadVector(file).rest.find((item) => item.label === label);
  if (!entry) throw new Error(`missing ${file} ${label}`);
  return entry.body;
};
const events = (file) => loadVector(file).frames
  .filter((frame) => frame.startsWith('data: '))
  .map((frame) => JSON.parse(frame.slice('data: '.length)));

const SID = 'ses_fffffffffffenormalized0000';
const retryOf02 = { type: 'retry', attempt: 2, message: 'Rate limit exceeded, please retry', next: 1767225609000 };

describe('live derivation', () => {
  it('derives busy, retry and idle from the 02 retry trace', () => {
    const derived = events('02-retry.json')
      .map((event) => statusForEvent(event.type, event.data))
      .filter((status) => status !== undefined);
    expect(derived).toEqual([BUSY_STATUS, retryOf02, IDLE_STATUS]);
  });

  it('derives idle for failed and interrupted executions (vectors 04, 03)', () => {
    for (const file of ['04-failure.json', '03-abort.json', '05b-question-dismissed.json']) {
      const derived = events(file).map((event) => statusForEvent(event.type, event.data)).filter(Boolean);
      expect(derived[0]).toEqual(BUSY_STATUS);
      expect(derived.at(-1)).toEqual(IDLE_STATUS);
    }
  });

  it('ignores native status events and keeps a malformed retry busy', () => {
    expect(statusForEvent('session.status', { status: { type: 'idle' } })).toBeUndefined();
    expect(statusForEvent('session.idle', {})).toBeUndefined();
    expect(statusForEvent('session.text.delta', {})).toBeUndefined();
    expect(statusForEvent('session.retry.scheduled', { attempt: 'x' })).toBe(BUSY_STATUS);
  });

  it('keeps next as absolute epoch milliseconds and tolerates a missing error message', () => {
    expect(toV1RetryStatus({ attempt: 3, at: 1767225609000 })).toEqual({ type: 'retry', attempt: 3, message: '', next: 1767225609000 });
    expect(toV1RetryStatus({ attempt: 1.5, at: 1 })).toBeNull();
    expect(toV1RetryStatus(null)).toBeNull();
  });

  it('compares statuses for no-op suppression', () => {
    expect(isSameStatus(undefined, IDLE_STATUS)).toBe(true);
    expect(isSameStatus(BUSY_STATUS, { type: 'busy' })).toBe(true);
    expect(isSameStatus(BUSY_STATUS, IDLE_STATUS)).toBe(false);
    expect(isSameStatus(retryOf02, { ...retryOf02 })).toBe(true);
    expect(isSameStatus(retryOf02, { ...retryOf02, attempt: 3 })).toBe(false);
  });
});

describe('cold start from /api/session/active', () => {
  it('recovers retry from the latest assistant only while it carries retry (vector 02)', () => {
    expect(retryStatusFromMessages(rest('02-retry.json', 'retrying.session.messages.asc').data)).toEqual(retryOf02);
    expect(retryStatusFromMessages(rest('02-retry.json', 'session.messages.asc').data)).toBeNull();
    expect(retryStatusFromMessages([{ type: 'assistant', retry: { attempt: 2, at: 5 } }, { type: 'idle' }])).toBeNull();
    expect(retryStatusFromMessages(undefined)).toBeNull();
  });

  it('lists active sessions as busy, or retrying when recovered', () => {
    const active = rest('02-retry.json', 'retrying.session.active');
    expect(activeSessionIDs(active)).toEqual(new Set([SID]));
    expect(statusesFromActive(active)).toEqual({ [SID]: BUSY_STATUS });
    expect(statusesFromActive(active, { retryBySession: new Map([[SID, retryOf02]]) })).toEqual({ [SID]: retryOf02 });
    expect(statusesFromActive(rest('03-abort.json', 'session.active'))).toEqual({});
    expect(statusesFromActive(undefined)).toEqual({});
  });

  it('emits a status for every previously busy session and every newly active one', () => {
    const active = { data: { ses_b: { type: 'running' }, ses_c: { type: 'running' } } };
    const { statuses, changes } = reconcileActiveStatuses({
      active,
      previous: { ses_a: BUSY_STATUS, ses_b: retryOf02, ses_idle: IDLE_STATUS },
      retryBySession: new Map([['ses_c', retryOf02]]),
    });
    expect(statuses).toEqual({ ses_b: BUSY_STATUS, ses_c: retryOf02 });
    expect(changes).toEqual([
      { sessionID: 'ses_a', status: IDLE_STATUS },
      { sessionID: 'ses_b', status: BUSY_STATUS },
      { sessionID: 'ses_c', status: retryOf02 },
    ]);
    const fromMap = reconcileActiveStatuses({ active: { data: {} }, previous: new Map([['ses_a', BUSY_STATUS]]) });
    expect(fromMap.changes).toEqual([{ sessionID: 'ses_a', status: IDLE_STATUS }]);
    expect(reconcileActiveStatuses({ active: { data: {} } })).toEqual({ statuses: {}, changes: [] });
  });
});

describe('GET /session/status?directory', () => {
  const statuses = { ses_a: BUSY_STATUS, ses_b: retryOf02, ses_c: BUSY_STATUS, ses_d: IDLE_STATUS };
  const locations = new Map([['ses_a', '/repo'], ['ses_b', '/repo/'], ['ses_c', '/other'], ['ses_d', '/repo']]);
  const directoryOf = (id) => locations.get(id);

  it('keeps non-idle sessions whose cached location matches', () => {
    expect(filterStatusesByDirectory(statuses, { directory: '/repo', directoryOf })).toEqual({ ses_a: BUSY_STATUS, ses_b: retryOf02 });
    expect(filterStatusesByDirectory(statuses, { directory: '/repo/', directoryOf })).toEqual({ ses_a: BUSY_STATUS, ses_b: retryOf02 });
  });

  it('fails closed for unknown locations and returns all non-idle entries without a directory', () => {
    expect(filterStatusesByDirectory({ ses_x: BUSY_STATUS }, { directory: '/repo', directoryOf })).toEqual({});
    expect(filterStatusesByDirectory(statuses, { directoryOf })).toEqual({ ses_a: BUSY_STATUS, ses_b: retryOf02, ses_c: BUSY_STATUS });
  });
});
