import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

import {
  createManagedTaskScheduler,
  createManagedWaitCursor,
  prepareManagedResultMetadata,
  projectManagedTaskResult,
  readManagedResultReference,
  resolveManagedWaitCursor,
  toManagedTaskEvent,
  validateManagedTaskAutoResume,
  validateManagedTaskResultEnvelope,
} from './index.js';

// Golden fixtures pin persisted ledger bytes, key order, wire payloads and
// model-visible cursors. A difference here is a format change, never a refactor.
const fixture = name => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');
const NOW = 1_760_000_100_000;

const roundTripScheduler = async (bytes) => {
  let saved = null;
  const scheduler = createManagedTaskScheduler({
    now: () => NOW, logger: { warn() {} },
    persistence: { load: async () => JSON.parse(bytes), save: async (state) => { saved = `${JSON.stringify(state)}\n`; } },
    executor: { start: async () => { throw new Error('golden fixtures never launch'); } },
  });
  try {
    await scheduler.initialize();
    await scheduler.flush();
  } finally { await scheduler.shutdown(); }
  return saved;
};

describe('golden ledgers through the scheduler', () => {
  test('a current ledger saves byte-identical', async () => {
    const current = fixture('ledger-current.json');
    expect(await roundTripScheduler(current)).toBe(current);
  });

  test('a legacy ledger gains its defaults in the pinned key order, then stays stable', async () => {
    const saved = fixture('ledger-legacy.scheduler-saved.json');
    expect(await roundTripScheduler(fixture('ledger-legacy.json'))).toBe(saved);
    expect(await roundTripScheduler(saved)).toBe(saved);
  });
});

describe('golden wire payloads', () => {
  const ledger = JSON.parse(fixture('ledger-current.json'));
  const envelopeBytes = fixture('envelope-auto-resume.json');

  test('an envelope with autoResume validates without reordering its keys', () => {
    const envelope = JSON.parse(envelopeBytes);
    expect(`${JSON.stringify(validateManagedTaskResultEnvelope(envelope))}\n`).toBe(envelopeBytes);
    expect(JSON.stringify(validateManagedTaskAutoResume(envelope.autoResume))).toBe(JSON.stringify(envelope.autoResume));
  });

  test('the task-event SSE payload is byte-identical', () => {
    expect(`${JSON.stringify(toManagedTaskEvent(ledger.tasks[1], JSON.parse(envelopeBytes)))}\n`).toBe(fixture('task-event.json'));
  });
});

describe('golden cursors', () => {
  const ledger = JSON.parse(fixture('ledger-current.json'));
  const [task1] = ledger.tasks;
  const [envelope1, envelope2] = ledger.resultEnvelopes;
  const cursors = JSON.parse(fixture('cursors.json'));
  const taskIds = ['dvr_task_golden1', 'dvr_task_golden2'];

  test('dvr_result_cursor_v1. encodes and decodes unpadded', () => {
    const { cursor, maxPageBytes, firstPage, nextPage } = cursors.resultCursorV1;
    expect(cursor.slice('dvr_result_cursor_v1.'.length).length % 4).not.toBe(0);
    expect(projectManagedTaskResult(task1, envelope1, 'reference', maxPageBytes).resultReference).toEqual(firstPage);
    expect(firstPage.nextCursor).toBe(cursor);
    expect(readManagedResultReference({ task: task1, resultEnvelope: envelope1, resultCursor: cursor, maxPageBytes })).toEqual(nextPage);
  });

  test('dvr_result_section_v2. encodes and decodes unpadded', async () => {
    const { cursor, maxPageBytes, identitySha256, firstPage, nextPage } = cursors.resultSectionV2;
    expect(cursor.slice('dvr_result_section_v2.'.length).length % 4).not.toBe(0);
    const metadata = await prepareManagedResultMetadata({ task: toManagedTaskEvent(task1, envelope1).properties.task, resultEnvelope: envelope1 });
    const projected = metadata.project(maxPageBytes);
    expect(projected.metadataReference).toEqual(firstPage);
    expect(projected.metadataReference.identitySha256).toBe(identitySha256);
    expect(firstPage.nextCursor).toBe(cursor);
    expect(metadata.read(cursor, maxPageBytes).metadataReference).toEqual(nextPage);
  });

  test('dvr_wait_v2: encodes its scope and resolves against retained envelopes', () => {
    const { cursor, resolved } = cursors.waitV2;
    expect(createManagedWaitCursor('ses_golden_root', envelope2, [...taskIds].reverse())).toBe(cursor);
    expect(resolveManagedWaitCursor(cursor, 'ses_golden_root', [envelope1, envelope2], taskIds)).toEqual(resolved);
  });

  test('legacy dvr_wait_v1: still decodes and resets', () => {
    const { cursor, resolved } = cursors.waitV1Legacy;
    expect(resolved).toEqual({ sequence: 0, reset: true });
    expect(resolveManagedWaitCursor(cursor, 'ses_golden_root', [envelope1, envelope2], taskIds)).toEqual(resolved);
  });
});
