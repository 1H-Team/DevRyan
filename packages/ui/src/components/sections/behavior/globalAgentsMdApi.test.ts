import { describe, expect, test } from 'bun:test';

import {
  isGlobalAgentsMdSaveWarning,
  loadGlobalAgentsMd,
  saveGlobalAgentsMd,
} from './globalAgentsMdApi';

const jsonResponse = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: { 'Content-Type': 'application/json' },
});

describe('global AGENTS.md API', () => {
  test('loads the complete editable document contract', async () => {
    const fetchImpl: typeof fetch = async () => jsonResponse({
      content: '# Existing\n',
      exists: true,
      editable: true,
    });

    const result = await loadGlobalAgentsMd({ fetchImpl });
    expect(result).toEqual({
      content: '# Existing\n',
      exists: true,
      editable: true,
    });
  });

  test('rejects malformed success responses instead of guessing their shape', async () => {
    const fetchImpl: typeof fetch = async () => jsonResponse({ content: '# Missing flags' });

    try {
      await loadGlobalAgentsMd({ fetchImpl });
      throw new Error('Expected malformed response to be rejected');
    } catch (error) {
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toBe('Invalid global AGENTS.md response');
    }
  });

  test('uses the API error message for failed reads', async () => {
    const fetchImpl: typeof fetch = async () => jsonResponse({ error: 'Permission denied' }, 500);

    try {
      await loadGlobalAgentsMd({ fetchImpl });
      throw new Error('Expected failed response to be rejected');
    } catch (error) {
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toBe('Permission denied');
    }
  });

  test('returns canonical server content after saving', async () => {
    let requestBody: unknown;
    const fetchImpl: typeof fetch = async (_input, init) => {
      requestBody = JSON.parse(String(init?.body));
      return jsonResponse({
        success: true,
        content: '# New rule\n',
        exists: true,
        editable: true,
        runtimeApplied: true,
      });
    };

    const result = await saveGlobalAgentsMd('# New rule', { fetchImpl });
    expect(result).toEqual({
      success: true,
      content: '# New rule\n',
      exists: true,
      editable: true,
      runtimeApplied: true,
    });
    expect(requestBody).toEqual({ content: '# New rule' });
  });

  test('detects persisted saves that need a runtime warning', () => {
    expect(isGlobalAgentsMdSaveWarning({
      success: true,
      content: '# Saved\n',
      exists: true,
      editable: true,
      runtimeApplied: false,
      warning: 'Restart failed',
    })).toBe(true);
    expect(isGlobalAgentsMdSaveWarning({
      success: true,
      content: '# Saved\n',
      exists: true,
      editable: true,
      runtimeApplied: true,
    })).toBe(false);
  });
});
