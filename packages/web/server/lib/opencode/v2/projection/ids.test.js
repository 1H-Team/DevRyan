import { describe, expect, it } from 'vitest';

import {
  assistantContentPartId,
  assistantContentPartIds,
  assistantReasoningPartId,
  assistantTextPartId,
  assistantToolPartId,
  clampIncreasingTime,
  clampIncreasingTimes,
  compactionSummaryMessageId,
  readDevryanPartDescriptors,
  stepFinishPartId,
  stepStartPartId,
  toolAttachmentPartId,
  userAgentPartId,
  userFilePartId,
  userSegmentPartId,
  userTextPartId,
  userTextSegments,
} from './ids.js';

const MID = 'msg_01';

const devryan = (parts, overrides = {}) => ({ devryan: { v: 1, parts, ...overrides } });

describe('assistant part ids', () => {
  it('uses the documented id templates', () => {
    expect(assistantTextPartId(MID, 2)).toBe('msg_01:text:2');
    expect(assistantReasoningPartId(MID, 0)).toBe('msg_01:reasoning:0');
    expect(assistantToolPartId(MID, 'call_9')).toBe('msg_01:tool:call_9');
    expect(stepStartPartId(MID)).toBe('msg_01:step-start');
    expect(stepFinishPartId(MID)).toBe('msg_01:step-finish');
    expect(toolAttachmentPartId(MID, 'call_9', 1)).toBe('msg_01:tool:call_9:file:1');
    expect(compactionSummaryMessageId(MID)).toBe('msg_01:summary');
  });

  it('counts text and reasoning ordinals per kind, not per content index', () => {
    const content = [
      { type: 'reasoning', text: 'r0' },
      { type: 'text', text: 't0' },
      { type: 'tool', id: 'call_a', name: 'read' },
      { type: 'reasoning', text: 'r1' },
      { type: 'text', text: 't1' },
      { type: 'tool', id: 'call_b', name: 'shell' },
      { type: 'text', text: 't2' },
    ];
    expect(assistantContentPartIds(MID, content)).toEqual([
      'msg_01:reasoning:0',
      'msg_01:text:0',
      'msg_01:tool:call_a',
      'msg_01:reasoning:1',
      'msg_01:text:1',
      'msg_01:tool:call_b',
      'msg_01:text:2',
    ]);
  });

  it('agrees with the event ordinal for a single item', () => {
    const content = [{ type: 'reasoning', text: '' }, { type: 'text', text: '' }];
    const ids = assistantContentPartIds(MID, content);
    expect(ids[1]).toBe(assistantContentPartId(MID, content[1], 0));
    expect(assistantContentPartId(MID, { type: 'tool', id: 'c1' }, 7)).toBe('msg_01:tool:c1');
  });

  it('returns null for items without a projected id and [] for non-arrays', () => {
    expect(assistantContentPartIds(MID, [{ type: 'tool' }, { type: 'mystery' }, null, 'text']))
      .toEqual([null, null, null, null]);
    expect(assistantContentPartIds(MID, undefined)).toEqual([]);
    expect(assistantContentPartId(MID, { type: 'tool', id: '' }, 0)).toBeNull();
  });
});

describe('user part ids', () => {
  it('synthesizes per-kind indexed ids', () => {
    expect(userTextPartId(MID, 0)).toBe('msg_01:text:0');
    expect(userFilePartId(MID, 1)).toBe('msg_01:file:1');
    expect(userAgentPartId(MID, 2)).toBe('msg_01:agent:2');
  });

  it('splits text by UTF-16 segment lengths and keeps the client part ids', () => {
    const preface = 'Plan mode.';
    const attachment = 'file: a.txt\n😀 body';
    const typed = 'héllo';
    const text = `${preface}${attachment}${typed}`;
    const metadata = devryan([
      { kind: 'synthetic', length: preface.length, id: 'prt_a' },
      { kind: 'attachment', length: attachment.length },
      { kind: 'text', length: typed.length, id: 'prt_c' },
    ]);
    expect(userTextSegments(MID, text, metadata)).toEqual([
      { id: 'prt_a', kind: 'synthetic', text: preface },
      { id: 'msg_01:text:1', kind: 'attachment', text: attachment },
      { id: 'prt_c', kind: 'text', text: typed },
    ]);
    expect(userSegmentPartId(MID, metadata, 0)).toBe('prt_a');
    expect(userSegmentPartId(MID, metadata, 1)).toBe('msg_01:text:1');
  });

  it('drops empty segments but keeps the descriptor index in synthesized ids', () => {
    const metadata = devryan([
      { kind: 'synthetic', length: 0 },
      { kind: 'text', length: 2 },
    ]);
    expect(userTextSegments(MID, 'hi', metadata)).toEqual([
      { id: 'msg_01:text:1', kind: 'text', text: 'hi' },
    ]);
  });

  it('falls back to one text part when metadata is missing or inconsistent', () => {
    const whole = [{ id: 'msg_01:text:0', kind: 'text', text: 'hello' }];
    expect(userTextSegments(MID, 'hello', undefined)).toEqual(whole);
    expect(userTextSegments(MID, 'hello', {})).toEqual(whole);
    expect(userTextSegments(MID, 'hello', devryan([{ kind: 'text', length: 4, id: 'p' }]))).toEqual(whole);
    expect(userTextSegments(MID, 'hello', devryan([{ kind: 'text', length: 5 }], { v: 2 }))).toEqual(whole);
    expect(userTextSegments(MID, 'hello', devryan([]))).toEqual(whole);
    expect(userSegmentPartId(MID, undefined, 0)).toBe('msg_01:text:0');
  });

  it('yields no text parts for empty text', () => {
    expect(userTextSegments(MID, '', undefined)).toEqual([]);
    expect(userTextSegments(MID, undefined, undefined)).toEqual([]);
  });

  it('rejects malformed descriptors', () => {
    expect(readDevryanPartDescriptors(devryan([{ kind: 'image', length: 1 }]))).toBeNull();
    expect(readDevryanPartDescriptors(devryan([{ kind: 'text', length: -1 }]))).toBeNull();
    expect(readDevryanPartDescriptors(devryan([{ kind: 'text', length: 1.5 }]))).toBeNull();
    expect(readDevryanPartDescriptors(devryan([{ kind: 'text', length: 1, id: '' }]))).toBeNull();
    expect(readDevryanPartDescriptors(devryan([
      { kind: 'text', length: 1, id: 'dup' },
      { kind: 'text', length: 1, id: 'dup' },
    ]))).toBeNull();
    expect(readDevryanPartDescriptors(devryan('nope'))).toBeNull();
    expect(readDevryanPartDescriptors({ devryan: [] })).toBeNull();
    expect(readDevryanPartDescriptors(devryan([{ kind: 'text', length: 3, id: 'p', extra: true }])))
      .toEqual([{ kind: 'text', length: 3, id: 'p' }]);
  });
});

describe('time clamp', () => {
  it('keeps strictly increasing times and bumps ties and regressions', () => {
    expect(clampIncreasingTime(10, undefined)).toBe(10);
    expect(clampIncreasingTime(11, 10)).toBe(11);
    expect(clampIncreasingTime(10, 10)).toBe(11);
    expect(clampIncreasingTime(5, 10)).toBe(11);
  });

  it('fills a missing time from the previous one', () => {
    expect(clampIncreasingTime(undefined, 10)).toBe(11);
    expect(clampIncreasingTime('10', 10)).toBe(11);
    expect(clampIncreasingTime(undefined, undefined)).toBeUndefined();
    expect(clampIncreasingTime(Number.NaN, undefined)).toBeUndefined();
  });

  it('clamps a sequence in seq order, continuing from a previous value', () => {
    expect(clampIncreasingTimes([100, 100, 90, 200, undefined])).toEqual([100, 101, 102, 200, 201]);
    expect(clampIncreasingTimes([100, 150], 120)).toEqual([121, 150]);
    expect(clampIncreasingTimes([undefined, 5])).toEqual([undefined, 5]);
    expect(clampIncreasingTimes(null)).toEqual([]);
  });
});
