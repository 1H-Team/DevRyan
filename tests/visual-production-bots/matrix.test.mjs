import { describe, expect, test } from 'bun:test';

import { PRODUCTION_BOTS_VISUAL_MATRIX, productionBotsVisualUrl } from './matrix.mjs';

describe('Production Bots visual fixture matrix', () => {
  test('covers every required state family with unique deterministic identifiers', () => {
    const ids = PRODUCTION_BOTS_VISUAL_MATRIX.map((entry) => entry.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(new Set(PRODUCTION_BOTS_VISUAL_MATRIX.map((entry) => entry.theme))).toEqual(new Set(['light', 'dark']));
    expect(new Set(PRODUCTION_BOTS_VISUAL_MATRIX.map((entry) => entry.rail))).toEqual(new Set([220, 280, 500]));
    expect(PRODUCTION_BOTS_VISUAL_MATRIX.some((entry) => entry.viewport.width === 390)).toBe(true);
    expect(PRODUCTION_BOTS_VISUAL_MATRIX.some((entry) => entry.interaction === 'activity_hidden')).toBe(true);
    expect(PRODUCTION_BOTS_VISUAL_MATRIX.some((entry) => entry.interaction === 'legacy_dialog')).toBe(true);
    expect(PRODUCTION_BOTS_VISUAL_MATRIX.some((entry) => entry.viewport.width === 390 && entry.drawer === 'open')).toBe(true);
    expect(PRODUCTION_BOTS_VISUAL_MATRIX.some((entry) => entry.viewport.width === 390 && entry.drawer === 'closed')).toBe(true);
    for (const state of [
      'provider_model', 'missing_credential',
      'opencode', 'healthy', 'testing', 'failed', 'revoked', 'privacy_warning',
      'trusted', 'untrusted', 'tampered', 'binding_failed', 'diff',
      'validation_error', 'quota_exhausted', 'public_only', 'allowlist',
      'private_denial', 'proxy_failure', 'standard', 'runsc', 'runsc_unavailable',
      'consent', 'starting', 'connected', 'degraded', 'updating', 'disabled',
      'desktop_unavailable', 'empty', 'loading', 'pending', 'settled',
      'reconciliation', 'partial_failure', 'paused', 'retired', 'ack_running',
      'retry_refused', 'timeout', 'ack_result', 'screen_connecting', 'screen_owned', 'screen_view_only',
      'image_loading', 'image_ready', 'image_error',
      'screen_conflict', 'screen_wait_owned', 'screen_wait_other',
      'screen_disconnected', 'screen_off',
    ]) {
      expect(PRODUCTION_BOTS_VISUAL_MATRIX.some((entry) => entry.state === state)).toBe(true);
    }
  });

  test('constructs loopback URLs without carrying unrelated query data', () => {
    const url = new URL(productionBotsVisualUrl('http://127.0.0.1:4178/ignored?secret=no', PRODUCTION_BOTS_VISUAL_MATRIX[0]));
    expect(url.hostname).toBe('127.0.0.1');
    expect(url.searchParams.get('secret')).toBeNull();
    expect(url.searchParams.get('scene')).toBe('agent');
    expect(url.searchParams.get('rail')).toBe('220');
    expect(url.searchParams.get('drawer')).toBe('open');
  });
});
