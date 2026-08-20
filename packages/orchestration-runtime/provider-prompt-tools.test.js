import { describe, expect, test } from 'bun:test';

import { resolveProviderPromptTools } from './provider-prompt-tools.js';

const WRITABLE_CONTEXT_MODE_TOOLS = Object.freeze({
  ctx_execute: true,
  mcp__context_mode__ctx_execute: true,
  ctx_execute_file: true,
  mcp__context_mode__ctx_execute_file: true,
  ctx_batch_execute: true,
  mcp__context_mode__ctx_batch_execute: true,
  ctx_index: true,
  mcp__context_mode__ctx_index: true,
  ctx_search: true,
  mcp__context_mode__ctx_search: true,
  ctx_stats: true,
  mcp__context_mode__ctx_stats: true,
  ctx_fetch_and_index: true,
  mcp__context_mode__ctx_fetch_and_index: true,
  ctx_purge: false,
  mcp__context_mode__ctx_purge: false,
  ctx_upgrade: false,
  mcp__context_mode__ctx_upgrade: false,
  ctx_insight: false,
  mcp__context_mode__ctx_insight: false,
});

describe('provider prompt tool policy', () => {
  test('caps GitHub Copilot tool discovery for canonical and legacy provider IDs', () => {
    expect(resolveProviderPromptTools('github-copilot')).toEqual({
      'resend_*': false,
      'mcp__resend__*': false,
    });
    expect(resolveProviderPromptTools('  COPILOT ')).toEqual({
      'resend_*': false,
      'mcp__resend__*': false,
    });
  });

  test('does not restrict providers without a confirmed tool limit', () => {
    expect(resolveProviderPromptTools('openai')).toBeUndefined();
    expect(resolveProviderPromptTools('cursor-acp')).toBeUndefined();
  });

  test('keeps managed delegation root-owned without hiding plugins or MCP tools', () => {
    expect(resolveProviderPromptTools('openai', 'orchestrator')).toEqual({
      task: false,
      invalid: false,
    });
    expect(resolveProviderPromptTools('cursor-acp', ' Orchestrator ')).toEqual({
      task: false,
      invalid: false,
    });
  });

  test('merges Orchestrator and Copilot tool restrictions', () => {
    expect(resolveProviderPromptTools('github-copilot', 'orchestrator')).toEqual({
      'resend_*': false,
      'mcp__resend__*': false,
      task: false,
      invalid: false,
    });
  });

  test('fails closed to an inspection-only allowlist when Context Mode is unavailable', () => {
    expect(resolveProviderPromptTools('openai', 'designer', { readOnly: true })).toEqual({
      '*': false,
      read: true,
      oc_read: true,
      glob: true,
      oc_glob: true,
      grep: true,
      ls: true,
      oc_ls: true,
      stat: true,
      oc_stat: true,
      ast_grep_search: true,
      webfetch: true,
      websearch: true,
      google_search: true,
    });
    expect(resolveProviderPromptTools('github-copilot', 'designer', { readOnly: true })).toMatchObject({
      'resend_*': false,
      'mcp__resend__*': false,
      '*': false,
      read: true,
      webfetch: true,
    });
  });

  test('withholds every Context Mode tool in UI Plan Mode when unavailable', () => {
    const tools = resolveProviderPromptTools('openai', 'orchestrator', { planMode: true });

    expect(tools).toMatchObject({
      task: false,
      invalid: false,
      ctx_execute: false,
      mcp__context_mode__ctx_execute: false,
      ctx_execute_file: false,
      mcp__context_mode__ctx_execute_file: false,
      ctx_batch_execute: false,
      mcp__context_mode__ctx_batch_execute: false,
      ctx_purge: false,
      mcp__context_mode__ctx_purge: false,
      ctx_upgrade: false,
      mcp__context_mode__ctx_upgrade: false,
      ctx_search: false,
      mcp__context_mode__ctx_search: false,
      ctx_stats: false,
      mcp__context_mode__ctx_stats: false,
      ctx_fetch_and_index: false,
      mcp__context_mode__ctx_fetch_and_index: false,
      ctx_index: false,
      mcp__context_mode__ctx_index: false,
      ctx_insight: false,
      mcp__context_mode__ctx_insight: false,
    });
    expect(tools).not.toHaveProperty('*');
  });

  test('grants writable Context Mode tools in both naming forms when available', () => {
    expect(resolveProviderPromptTools('openai', 'orchestrator', {
      contextModeAvailable: true,
    })).toEqual({
      task: false,
      invalid: false,
      ...WRITABLE_CONTEXT_MODE_TOOLS,
    });
  });

  test('grants only safe read-only Context Mode tools when available', () => {
    expect(resolveProviderPromptTools('openai', 'plan', {
      planMode: true,
      contextModeAvailable: true,
    })).toMatchObject({
      ctx_execute: false,
      mcp__context_mode__ctx_execute: false,
      ctx_index: true,
      mcp__context_mode__ctx_index: true,
      ctx_search: true,
      mcp__context_mode__ctx_search: true,
      ctx_stats: true,
      mcp__context_mode__ctx_stats: true,
      ctx_fetch_and_index: true,
      mcp__context_mode__ctx_fetch_and_index: true,
      ctx_insight: false,
      mcp__context_mode__ctx_insight: false,
    });

    expect(resolveProviderPromptTools('openai', 'explorer', {
      readOnly: true,
      contextModeAvailable: true,
    })).toMatchObject({
      '*': false,
      ctx_index: true,
      mcp__context_mode__ctx_index: true,
      ctx_fetch_and_index: true,
      mcp__context_mode__ctx_fetch_and_index: true,
    });
  });

  test('retains the read-only indexing capability alias', () => {
    expect(resolveProviderPromptTools('openai', 'plan', {
      planMode: true,
      contextModeReadOnlyIndexing: true,
    })).toMatchObject({
      ctx_index: true,
      mcp__context_mode__ctx_index: true,
      ctx_search: true,
      mcp__context_mode__ctx_search: true,
    });
  });

  test('keeps Cursor SDK-backed turns out of Context Mode scope', () => {
    expect(resolveProviderPromptTools('cursor-acp', 'orchestrator', {
      contextModeAvailable: true,
    })).toEqual({ task: false, invalid: false });
  });

  test('merges Copilot caps with the Plan Mode Context policy', () => {
    expect(resolveProviderPromptTools('github-copilot', 'orchestrator', {
      planMode: true,
      contextModeAvailable: true,
    })).toMatchObject({
      'resend_*': false,
      'mcp__resend__*': false,
      task: false,
      invalid: false,
      ctx_execute: false,
      ctx_search: true,
    });
  });
});
