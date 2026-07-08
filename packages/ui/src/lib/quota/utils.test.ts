import { describe, expect, test } from 'bun:test';
import type { ProviderResult, UsageWindow } from '@/types';
import {
  buildQuotaTrendKey,
  buildQuotaWindowDisplayState,
  calculatePace,
  calculateUsagePrediction,
  clampPercent,
  formatPercent,
  formatWindowLabel,
  recordProviderUsageTrends,
  resolveUsageTone,
  type UsageTrendHistory,
} from './utils';

const makeWindow = (overrides: Partial<UsageWindow>): UsageWindow => ({
  usedPercent: 0,
  remainingPercent: 100,
  windowSeconds: 7 * 24 * 60 * 60,
  resetAfterSeconds: null,
  resetAt: null,
  resetAtFormatted: null,
  resetAfterFormatted: null,
  ...overrides,
});

const makeProviderResult = (window: UsageWindow, fetchedAt: number, resetAt = window.resetAt): ProviderResult => ({
  providerId: 'codex',
  providerName: 'Codex',
  ok: true,
  configured: true,
  fetchedAt,
  usage: {
    windows: {
      weekly: { ...window, resetAt },
    },
  },
});

describe('quota usage utils', () => {
  test('usage tone stays safe until 75 percent and critical starts at 90 percent', () => {
    expect(resolveUsageTone(74)).toBe('safe');
    expect(resolveUsageTone(75)).toBe('warn');
    expect(resolveUsageTone(89)).toBe('warn');
    expect(resolveUsageTone(90)).toBe('critical');
  });

  test('percent formatting rejects non-finite values', () => {
    expect(clampPercent(Infinity)).toBeNull();
    expect(clampPercent(-Infinity)).toBeNull();
    expect(formatPercent(Infinity)).toBe('-');
    expect(formatPercent(-Infinity)).toBe('-');
  });

  test('formats GitHub Copilot AI Credits quota label', () => {
    expect(formatWindowLabel('ai-credits')).toBe('AI Credits');
  });

  test('formats OpenCode Go rolling usage label', () => {
    expect(formatWindowLabel('rolling')).toBe('Rolling');
  });

  test('prediction falls back to full-window pace without enough trend samples', () => {
    const prediction = calculateUsagePrediction(20, 0.5, 3600, [
      { fetchedAt: 1_000, usedPercent: 20, resetAt: 10_000 },
    ]);

    expect(Math.round(prediction.predictedFinalPercent)).toBe(40);
    expect(prediction.confidence).toBe('low');
  });

  test('prediction blends recent burn rate with full-window pace when samples are usable', () => {
    const prediction = calculateUsagePrediction(20, 0.5, 3600, [
      { fetchedAt: 0, usedPercent: 10, resetAt: 10_000 },
      { fetchedAt: 10 * 60 * 1000, usedPercent: 20, resetAt: 10_000 },
    ]);

    // Recent pace projects to 80%; full-window pace projects to 40%; high confidence weights recent pace at 70%.
    expect(Math.round(prediction.predictedFinalPercent)).toBe(68);
    expect(prediction.confidence).toBe('high');
  });

  test('pace prediction discounts future remaining time for average sleep', () => {
    const resetAt = Date.now() + 12 * 60 * 60 * 1000;
    const pace = calculatePace(25, resetAt, 24 * 60 * 60, 'daily');

    expect(Math.round(pace?.predictedFinalPercent ?? 0)).toBe(42);
    expect(Math.round((pace?.elapsedRatio ?? 0) * 100)).toBe(60);
  });

  test('7-day rolling window prediction uses wall-clock time instead of sleep adjustment', () => {
    const resetAt = Date.now() + 3.5 * 24 * 60 * 60 * 1000;
    const pace = calculatePace(25, resetAt, 7 * 24 * 60 * 60, '7d');

    expect(Math.round(pace?.predictedFinalPercent ?? 0)).toBe(50);
    expect(Math.round((pace?.elapsedRatio ?? 0) * 100)).toBe(50);
  });

  test('monthly prediction uses the shared non-rolling quota model', () => {
    const resetAt = Date.now() + 15 * 24 * 60 * 60 * 1000;
    const pace = calculatePace(25, resetAt, 30 * 24 * 60 * 60, 'monthly');

    // Monthly quotas follow the same sleep-adjusted prediction path used for non-rolling Codex-style windows.
    expect(Math.round(pace?.predictedFinalPercent ?? 0)).toBe(42);
    expect(Math.round((pace?.elapsedRatio ?? 0) * 100)).toBe(60);
  });

  test('model-specific 7-day Anthropic labels use rolling window prediction', () => {
    const resetAt = Date.now() + 3.5 * 24 * 60 * 60 * 1000;
    const sonnetPace = calculatePace(25, resetAt, null, '7d-sonnet');
    const opusPace = calculatePace(25, resetAt, null, '7d-opus');

    expect(Math.round(sonnetPace?.predictedFinalPercent ?? 0)).toBe(50);
    expect(sonnetPace?.totalSeconds).toBe(7 * 24 * 60 * 60);
    expect(Math.round(opusPace?.predictedFinalPercent ?? 0)).toBe(50);
    expect(opusPace?.totalSeconds).toBe(7 * 24 * 60 * 60);
  });

  test('trend projection uses sleep-adjusted remaining time', () => {
    const resetAt = Date.now() + 12 * 60 * 60 * 1000;
    const pace = calculatePace(20, resetAt, 24 * 60 * 60, 'daily', [
      { fetchedAt: 0, usedPercent: 10, resetAt },
      { fetchedAt: 10 * 60 * 1000, usedPercent: 20, resetAt },
    ]);

    // Recent pace projects through 8 active remaining hours instead of 12 wall-clock hours.
    expect(Math.round(pace?.predictedFinalPercent ?? 0)).toBe(360);
    expect(pace?.predictionConfidence).toBe('high');
  });

  test('trend recording clears prior samples across reset boundaries', () => {
    const firstWindow = makeWindow({ usedPercent: 55, resetAt: 100_000 });
    const resetWindow = makeWindow({ usedPercent: 2, resetAt: 200_000 });
    let history: UsageTrendHistory = {};

    history = recordProviderUsageTrends(history, makeProviderResult(firstWindow, 10_000));
    history = recordProviderUsageTrends(history, makeProviderResult(resetWindow, 20_000));

    const key = buildQuotaTrendKey('codex', 'window', null, 'weekly');
    expect(history[key]).toEqual([
      { fetchedAt: 20_000, usedPercent: 2, resetAt: 200_000 },
    ]);
  });

  test('trend recording skips non-finite usage percentages', () => {
    const key = buildQuotaTrendKey('codex', 'window', null, 'weekly');
    const history = recordProviderUsageTrends({}, makeProviderResult(makeWindow({ usedPercent: Infinity }), 10_000));

    expect(history[key]).toBe(undefined);
  });

  test('remaining display state mirrors predicted used quota', () => {
    const resetAt = Date.now() + 12 * 60 * 60 * 1000;
    const window = makeWindow({
      usedPercent: 25,
      remainingPercent: 75,
      windowSeconds: 24 * 60 * 60,
      resetAt,
    });
    const state = buildQuotaWindowDisplayState(window, 'daily', 'remaining');

    expect(state.displayPercent).toBe(75);
    expect(state.paceInfo?.predictedFinalPercent).toBeGreaterThan(40);
    expect(100 - (state.paceInfo?.predictedFinalPercent ?? 0)).toBeLessThan(60);
  });
});
