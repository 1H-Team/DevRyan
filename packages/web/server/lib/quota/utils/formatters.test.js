import { describe, expect, it } from 'vitest';

import { buildResult, calculateResetAfterSeconds, formatResetTime, toUsageWindow } from './formatters.js';

describe('formatResetTime', () => {
  it('returns null for invalid timestamps', () => {
    expect(formatResetTime('not-a-date')).toBeNull();
    expect(formatResetTime(NaN)).toBeNull();
    expect(formatResetTime(Infinity)).toBeNull();
    expect(formatResetTime(-Infinity)).toBeNull();
  });
});

describe('calculateResetAfterSeconds', () => {
  it('accepts an epoch reset timestamp', () => {
    expect(calculateResetAfterSeconds(0)).toBe(0);
  });

  it('returns null for invalid timestamps', () => {
    expect(calculateResetAfterSeconds('not-a-date')).toBeNull();
    expect(calculateResetAfterSeconds(undefined)).toBeNull();
    expect(calculateResetAfterSeconds(null)).toBeNull();
    expect(calculateResetAfterSeconds('')).toBeNull();
    expect(calculateResetAfterSeconds(NaN)).toBeNull();
    expect(calculateResetAfterSeconds(Infinity)).toBeNull();
    expect(calculateResetAfterSeconds(-Infinity)).toBeNull();
  });
});

describe('toUsageWindow', () => {
  it('formats epoch reset timestamps', () => {
    const usageWindow = toUsageWindow({ resetAt: 0 });

    expect(usageWindow.resetAfterSeconds).toBe(0);
    expect(usageWindow.resetAtFormatted).toBe(formatResetTime(0));
    expect(usageWindow.resetAfterFormatted).toBe(formatResetTime(0));
  });

  it('does not derive reset labels from missing reset timestamps', () => {
    expect(toUsageWindow({ resetAt: undefined }).resetAfterSeconds).toBeNull();
    expect(toUsageWindow({ resetAt: null }).resetAtFormatted).toBeNull();
    expect(toUsageWindow({ resetAt: '' }).resetAfterFormatted).toBeNull();
    expect(toUsageWindow({ resetAt: NaN }).resetAfterSeconds).toBeNull();
    expect(toUsageWindow({ resetAt: Infinity }).resetAtFormatted).toBeNull();
    expect(toUsageWindow({ resetAt: -Infinity }).resetAfterFormatted).toBeNull();
  });

  it('does not derive remaining percent from missing or non-finite usage', () => {
    expect(toUsageWindow({ usedPercent: undefined }).remainingPercent).toBeNull();
    expect(toUsageWindow({ usedPercent: null }).remainingPercent).toBeNull();
    expect(toUsageWindow({ usedPercent: NaN }).remainingPercent).toBeNull();
    expect(toUsageWindow({ usedPercent: Infinity }).remainingPercent).toBeNull();
    expect(toUsageWindow({ usedPercent: -Infinity }).remainingPercent).toBeNull();
  });

  it('derives and clamps remaining percent from valid finite usage', () => {
    expect(toUsageWindow({ usedPercent: 60 }).remainingPercent).toBe(40);
    expect(toUsageWindow({ usedPercent: 110 }).remainingPercent).toBe(0);
  });
});

describe('buildResult', () => {
  it('retains non-fatal provider warnings without requiring an error result', () => {
    const result = buildResult({
      providerId: 'deepseek',
      providerName: 'DeepSeek',
      ok: true,
      configured: true,
      usage: { windows: {} },
      warnings: ['Balance is temporarily unavailable.'],
    });

    expect(result.warnings).toEqual(['Balance is temporarily unavailable.']);
    expect(result.ok).toBe(true);
  });
});
