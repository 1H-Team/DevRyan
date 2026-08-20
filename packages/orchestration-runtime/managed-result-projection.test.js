import { describe, expect, test } from 'bun:test';

import {
  MANAGED_RESULT_PAGE_MAX_BYTES,
  projectManagedResultEnvelope,
  projectManagedTaskResult,
  readManagedResultReference,
  resolveManagedResultMode,
} from './managed-result-projection.js';

const encoder = new TextEncoder();
const bytes = (value) => encoder.encode(value).byteLength;

const resultPair = (preview, overrides = {}) => {
  const shared = {
    taskId: 'dvr_task_projection',
    rootSessionId: 'ses_root',
    parentTaskId: null,
    childSessionId: 'ses_child',
    directory: '/workspace',
    status: 'completed',
    partial: false,
    failureReason: null,
    attempt: 1,
    priorTaskId: null,
    executionKind: 'start',
    recoverablePreview: preview,
    canonicalRefs: [{ type: 'message', id: 'msg_child' }],
  };
  return {
    task: {
      ...shared,
      owner: 'devryan',
      label: 'Projection test',
      ...overrides.task,
    },
    resultEnvelope: {
      ...shared,
      owner: 'devryan',
      envelopeId: 'dvr_result_projection_1',
      sequence: 2,
      resumable: false,
      createdAt: 2_000,
      acknowledgedAt: null,
      action: null,
      followUpTaskId: null,
      ...overrides.resultEnvelope,
    },
  };
};

describe('managed result projection and paging', () => {
  test('defaults to eager and rejects unsupported supplied modes', () => {
    expect(resolveManagedResultMode()).toBe('eager');
    expect(resolveManagedResultMode('eager')).toBe('eager');
    expect(resolveManagedResultMode('reference')).toBe('reference');
    for (const value of [null, '', 'lazy', true, 1]) {
      expect(() => resolveManagedResultMode(value)).toThrow('resultMode must be eager or reference');
    }
  });

  test.each([
    ['below', 'x'.repeat(MANAGED_RESULT_PAGE_MAX_BYTES - 1)],
    ['exactly at', 'x'.repeat(MANAGED_RESULT_PAGE_MAX_BYTES)],
    ['exactly at with emoji', '🙂'.repeat(MANAGED_RESULT_PAGE_MAX_BYTES / 4)],
  ])('leaves %s-threshold responses byte-shape equivalent', (_label, preview) => {
    const { task, resultEnvelope } = resultPair(preview);
    const projected = projectManagedTaskResult(task, resultEnvelope, 'reference');

    expect(projected).toEqual({ task, resultEnvelope });
    expect(projected.task).toBe(task);
    expect(projected.resultEnvelope).toBe(resultEnvelope);
    expect(projected).not.toHaveProperty('resultReference');
  });

  test('projects immutable clones above the threshold and keeps metadata inline', () => {
    const preview = `prefix:${'x'.repeat(MANAGED_RESULT_PAGE_MAX_BYTES)}:suffix`;
    const { task, resultEnvelope } = resultPair(preview);
    const projected = projectManagedTaskResult(task, resultEnvelope, 'reference');

    expect(projected.task).not.toBe(task);
    expect(projected.resultEnvelope).not.toBe(resultEnvelope);
    expect(projected.task).not.toHaveProperty('recoverablePreview');
    expect(projected.resultEnvelope).not.toHaveProperty('recoverablePreview');
    expect(projected.task).toMatchObject({ failureReason: null, canonicalRefs: task.canonicalRefs });
    expect(projected.resultEnvelope).toMatchObject({
      failureReason: null,
      canonicalRefs: resultEnvelope.canonicalRefs,
      action: null,
    });
    expect(task.recoverablePreview).toBe(preview);
    expect(resultEnvelope.recoverablePreview).toBe(preview);
    expect(bytes(projected.resultReference.text)).toBeLessThanOrEqual(MANAGED_RESULT_PAGE_MAX_BYTES);
    expect(projected.resultReference).toMatchObject({
      taskId: task.taskId,
      envelopeId: resultEnvelope.envelopeId,
      totalBytes: bytes(preview),
      complete: false,
    });
  });

  test('preserves both eager copies when immutable task payload differs', () => {
    const preview = 'x'.repeat(MANAGED_RESULT_PAGE_MAX_BYTES + 1);
    const { task, resultEnvelope } = resultPair(preview, {
      resultEnvelope: { failureReason: 'envelope mismatch' },
    });
    const projected = projectManagedTaskResult(task, resultEnvelope, 'reference');

    expect(projected).toEqual({ task, resultEnvelope });
    expect(projected.task.recoverablePreview).toBe(preview);
    expect(projected.resultEnvelope.recoverablePreview).toBe(preview);
    expect(projected).not.toHaveProperty('resultReference');
  });

  test('falls back to eager output when the retained identity cannot fit a safe cursor', () => {
    const preview = 'x'.repeat(MANAGED_RESULT_PAGE_MAX_BYTES + 1);
    const taskId = `dvr_task_${'t'.repeat(4_096)}`;
    const { task, resultEnvelope } = resultPair(preview, {
      task: { taskId },
      resultEnvelope: { taskId },
    });

    const projected = projectManagedTaskResult(task, resultEnvelope, 'reference');

    expect(projected).toEqual({ task, resultEnvelope });
    expect(projected.task).toBe(task);
    expect(projected.resultEnvelope).toBe(resultEnvelope);
  });

  test('uses the acknowledgement wrapper location without exposing its matching task', () => {
    const { task, resultEnvelope } = resultPair('x'.repeat(MANAGED_RESULT_PAGE_MAX_BYTES + 1));
    const projected = projectManagedResultEnvelope(task, resultEnvelope, 'reference');

    expect(projected).toEqual({
      resultEnvelope: expect.not.objectContaining({ recoverablePreview: expect.anything() }),
      resultReference: expect.objectContaining({ taskId: task.taskId }),
    });
    expect(projected).not.toHaveProperty('task');
  });

  test('reconstructs a full 64 KiB Unicode preview without gaps or duplicate code points', () => {
    const unit = '🙂e\u0301Z';
    let preview = '';
    while (bytes(preview + unit) <= 64 * 1024) preview += unit;
    while (bytes(preview + 'x') <= 64 * 1024) preview += 'x';
    expect(bytes(preview)).toBe(64 * 1024);
    const { task, resultEnvelope } = resultPair(preview);
    let reference = projectManagedTaskResult(task, resultEnvelope, 'reference').resultReference;
    const pages = [reference.text];
    let previousBytes = 0;

    while (!reference.complete) {
      expect(bytes(reference.text)).toBeGreaterThan(0);
      expect(bytes(reference.text)).toBeLessThanOrEqual(MANAGED_RESULT_PAGE_MAX_BYTES);
      expect(reference.returnedBytes).toBeGreaterThan(previousBytes);
      previousBytes = reference.returnedBytes;
      reference = readManagedResultReference({
        task,
        resultEnvelope,
        resultCursor: reference.nextCursor,
      });
      pages.push(reference.text);
    }

    expect(pages.join('')).toBe(preview);
    expect(reference.returnedBytes).toBe(bytes(preview));
    expect(reference.nextCursor).toBeNull();
  });

  test('never splits a surrogate pair when a page ends next to emoji', () => {
    const preview = `${'x'.repeat(MANAGED_RESULT_PAGE_MAX_BYTES - 1)}🙂tail`;
    const { task, resultEnvelope } = resultPair(preview);
    const first = projectManagedTaskResult(task, resultEnvelope, 'reference').resultReference;
    const second = readManagedResultReference({
      task,
      resultEnvelope,
      resultCursor: first.nextCursor,
    });

    expect(first.text).toBe('x'.repeat(MANAGED_RESULT_PAGE_MAX_BYTES - 1));
    expect(second.text.startsWith('🙂')).toBe(true);
    expect(first.text + second.text).toBe(preview);
  });

  test('rejects malformed cursors and mismatched retained identities', () => {
    const { task, resultEnvelope } = resultPair('x'.repeat(MANAGED_RESULT_PAGE_MAX_BYTES + 10));
    const reference = projectManagedTaskResult(task, resultEnvelope, 'reference').resultReference;

    expect(() => readManagedResultReference({
      task,
      resultEnvelope,
      resultCursor: 'not-a-managed-cursor',
    })).toThrow(expect.objectContaining({ code: 'invalid_result_cursor' }));
    expect(() => readManagedResultReference({
      task: { ...task, taskId: 'dvr_task_other' },
      resultEnvelope,
      resultCursor: reference.nextCursor,
    })).toThrow(expect.objectContaining({ code: 'result_reference_mismatch' }));
    expect(() => readManagedResultReference({
      task,
      resultEnvelope: { ...resultEnvelope, envelopeId: 'dvr_result_replaced_2' },
      resultCursor: reference.nextCursor,
    })).toThrow(expect.objectContaining({ code: 'result_reference_mismatch' }));
  });

  test('rejects a cursor offset placed inside a surrogate pair', () => {
    const preview = `🙂${'x'.repeat(MANAGED_RESULT_PAGE_MAX_BYTES + 20)}`;
    const { task, resultEnvelope } = resultPair(preview);
    const reference = projectManagedTaskResult(task, resultEnvelope, 'reference').resultReference;
    const prefix = 'dvr_result_cursor_v1.';
    const encoded = reference.nextCursor.slice(prefix.length).replace(/-/g, '+').replace(/_/g, '/');
    const padded = encoded.padEnd(Math.ceil(encoded.length / 4) * 4, '=');
    const cursorState = JSON.parse(atob(padded));
    cursorState.o = 1;
    cursorState.b = 0;
    const tamperedPayload = btoa(JSON.stringify(cursorState))
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/g, '');

    expect(() => readManagedResultReference({
      task,
      resultEnvelope,
      resultCursor: `${prefix}${tamperedPayload}`,
    })).toThrow(expect.objectContaining({ code: 'invalid_result_cursor' }));
  });
});
