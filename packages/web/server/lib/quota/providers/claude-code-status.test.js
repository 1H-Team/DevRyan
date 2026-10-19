import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  CLAUDE_CODE_USAGE_UNAVAILABLE_CODE,
  readClaudeCodeStatusUsage,
} from './claude-code-status.js';

let tempDir = null;

const createTempDir = () => {
  tempDir = mkdtempSync(join(tmpdir(), 'devryan-claude-status-'));
  return tempDir;
};

afterEach(() => {
  if (tempDir) {
    rmSync(tempDir, { recursive: true, force: true });
    tempDir = null;
  }
});

const writeStatusFile = (payload) => {
  const statusPath = join(createTempDir(), 'status.json');
  writeFileSync(statusPath, JSON.stringify(payload), 'utf8');
  return statusPath;
};

describe('readClaudeCodeStatusUsage', () => {
  it('returns five-hour and seven-day windows from Claude Code status JSON', () => {
    const now = Date.UTC(2026, 0, 1);
    const statusPath = writeStatusFile({
      updated_at: now,
      rate_limits: {
        five_hour: { used_percentage: 42, resets_at: new Date(now + 1000).toISOString() },
        seven_day: { used_percentage: 64, resets_at: new Date(now + 2000).toISOString() },
      },
    });

    const result = readClaudeCodeStatusUsage({ statusPath, now });

    expect(result.ok).toBe(true);
    expect(result.usage.windows['5h'].usedPercent).toBe(42);
    expect(result.usage.windows['5h'].windowSeconds).toBe(5 * 60 * 60);
    expect(result.usage.windows['7d'].usedPercent).toBe(64);
    expect(result.usage.windows['7d'].windowSeconds).toBe(7 * 24 * 60 * 60);
  });

  it('preserves over-limit percentages from Claude Code status JSON', () => {
    const now = Date.UTC(2026, 0, 1);
    const statusPath = writeStatusFile({
      updated_at: now,
      rate_limits: {
        five_hour: { used_percentage: 104, resets_at: new Date(now + 1000).toISOString() },
      },
    });

    const result = readClaudeCodeStatusUsage({ statusPath, now });

    expect(result.ok).toBe(true);
    expect(result.usage.windows['5h'].usedPercent).toBe(104);
    expect(result.usage.windows['5h'].remainingPercent).toBe(0);
  });

  it('returns monthly usage from Claude Code status JSON when available', () => {
    const now = Date.UTC(2026, 0, 1);
    const monthlyReset = new Date(now + 30 * 24 * 60 * 60 * 1000).toISOString();
    const statusPath = writeStatusFile({
      updated_at: now,
      rate_limits: {
        monthly: { used_percentage: 12.5, resets_at: monthlyReset },
      },
    });

    const result = readClaudeCodeStatusUsage({ statusPath, now });

    expect(result.ok).toBe(true);
    expect(result.usage.windows.monthly.usedPercent).toBe(12.5);
    expect(result.usage.windows.monthly.windowSeconds).toBe(30 * 24 * 60 * 60);
    expect(result.usage.windows.monthly.resetAt).toBe(Date.parse(monthlyReset));
  });

  it('accepts alternate monthly status field names without failing existing windows', () => {
    const now = Date.UTC(2026, 0, 1);
    const statusPath = writeStatusFile({
      updated_at: now,
      rate_limits: {
        seven_day: { used_percentage: 64 },
        subscription: { used_percentage: 21, window_seconds: 31 * 24 * 60 * 60 },
      },
    });

    const result = readClaudeCodeStatusUsage({ statusPath, now });

    expect(result.ok).toBe(true);
    expect(result.usage.windows['7d'].usedPercent).toBe(64);
    expect(result.usage.windows.monthly.usedPercent).toBe(21);
    expect(result.usage.windows.monthly.windowSeconds).toBe(31 * 24 * 60 * 60);
  });

  it('returns the pending setup code when the status file has not been emitted yet', () => {
    const result = readClaudeCodeStatusUsage({ statusPath: join(createTempDir(), 'missing.json') });

    expect(result.ok).toBe(false);
    expect(result.code).toBe(CLAUDE_CODE_USAGE_UNAVAILABLE_CODE);
    expect(result.error).toContain('has not been emitted yet');
  });

  it('rejects stale status JSON', () => {
    const now = Date.UTC(2026, 0, 2);
    const statusPath = writeStatusFile({
      updated_at: now - (25 * 60 * 60 * 1000),
      rate_limits: {
        five_hour: { used_percentage: 10 },
        seven_day: { used_percentage: 20 },
      },
    });

    const result = readClaudeCodeStatusUsage({ statusPath, now });

    expect(result.ok).toBe(false);
    expect(result.error).toContain('stale');
  });

  it('rejects malformed JSON', () => {
    const statusPath = join(createTempDir(), 'status.json');
    writeFileSync(statusPath, '{not json', 'utf8');

    const result = readClaudeCodeStatusUsage({ statusPath });

    expect(result.ok).toBe(false);
    expect(result.error).toBe('Claude Code status-line usage file is not valid JSON.');
  });

  it('accepts a status file with only five-hour usage', () => {
    const now = Date.UTC(2026, 0, 1);
    const statusPath = writeStatusFile({
      updated_at: now,
      rate_limits: { five_hour: { used_percentage: 11 } },
    });

    const result = readClaudeCodeStatusUsage({ statusPath, now });

    expect(result.ok).toBe(true);
    expect(result.usage.windows['5h'].usedPercent).toBe(11);
    expect(result.usage.windows['7d']).toBeUndefined();
  });

  it('accepts a status file with only seven-day usage', () => {
    const now = Date.UTC(2026, 0, 1);
    const statusPath = writeStatusFile({
      updated_at: now,
      rate_limits: { seven_day: { used_percentage: 22 } },
    });

    const result = readClaudeCodeStatusUsage({ statusPath, now });

    expect(result.ok).toBe(true);
    expect(result.usage.windows['5h']).toBeUndefined();
    expect(result.usage.windows['7d'].usedPercent).toBe(22);
  });

  it('rejects status JSON without five-hour, seven-day, or monthly percentages', () => {
    const now = Date.UTC(2026, 0, 1);
    const statusPath = writeStatusFile({ updated_at: now, rate_limits: {} });

    const result = readClaudeCodeStatusUsage({ statusPath, now });

    expect(result.ok).toBe(false);
    expect(result.error).toContain('does not contain five-hour, seven-day, or monthly');
  });
});
