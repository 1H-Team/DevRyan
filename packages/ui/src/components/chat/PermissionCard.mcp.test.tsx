import React from 'react';
import { describe, expect, mock, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';

import type { PermissionRequest } from '@/types/permission';
import { getMcpPermissionDetails, MCP_PERMISSION_INPUT_MAX } from './permissionCardPatterns';

const syncModule = await import('@/sync/sync-context');
mock.module('@/sync/sync-context', () => ({ ...syncModule, useSession: () => undefined }));
mock.module('@/contexts/useThemeSystem', () => ({ useThemeSystem: () => ({ currentTheme: {} }) }));
mock.module('@/lib/theme/syntaxThemeGenerator', () => ({ generateSyntaxTheme: () => ({}) }));

const { I18nProvider } = await import('@/lib/i18n');
const { PermissionCard } = await import('./PermissionCard');

const permission = (metadata: Record<string, unknown>, overrides: Partial<PermissionRequest> = {}): PermissionRequest => ({
  id: 'per_1', sessionID: 'ses_1', permission: 'linear_search_issues', patterns: ['*'], always: ['*'], metadata, ...overrides,
});
const render = (request: PermissionRequest) => renderToStaticMarkup(<I18nProvider><PermissionCard permission={request} /></I18nProvider>);

describe('MCP permission details', () => {
  test('reads the host-stamped server and tool and formats the input', () => {
    expect(getMcpPermissionDetails('linear_search_issues', { input: { query: 'bug', limit: 5 }, mcp: { server: 'linear', tool: 'search_issues' } }))
      .toEqual({ server: 'linear', tool: 'search_issues', input: '{\n  "query": "bug",\n  "limit": 5\n}', truncated: false });
    expect(getMcpPermissionDetails('linear_search_issues', { input: {} }))
      .toEqual({ server: null, tool: 'linear_search_issues', input: '{}', truncated: false });
  });

  test('bounds a large input and ignores other permissions', () => {
    const large = getMcpPermissionDetails('x', { input: { blob: 'a'.repeat(MCP_PERMISSION_INPUT_MAX * 2) } });
    expect(large?.truncated).toBe(true);
    expect(large?.input.length).toBe(MCP_PERMISSION_INPUT_MAX);
    expect(getMcpPermissionDetails('bash', { command: 'ls' })).toBeNull();
    expect(getMcpPermissionDetails('edit', { input: {}, filepath: 'a.ts' })).toBeNull();
    expect(getMcpPermissionDetails('x', undefined)).toBeNull();
  });
});

describe('PermissionCard MCP branch', () => {
  test('shows server, tool and the formatted input instead of raw details', () => {
    const html = render(permission({ input: { query: 'bug', limit: 5 }, mcp: { server: 'linear', tool: 'search_issues' } }));
    expect(html).toContain('data-permission-mcp="true"');
    expect(html).toContain('linear · search_issues');
    expect(html).toContain('Server:');
    expect(html).toContain('Tool:');
    expect(html).toContain('&quot;query&quot;: &quot;bug&quot;');
    expect(html).toContain('Always Allow This Tool');
    expect(html).not.toContain('Details:');
    expect(html).not.toContain('Patterns:');
    expect(html).not.toContain('Always: *');
  });

  test('marks a truncated input and keeps non-MCP permissions on their own branch', () => {
    const html = render(permission({ input: { blob: 'a'.repeat(MCP_PERMISSION_INPUT_MAX * 2) } }));
    expect(html).toContain('Input truncated for display.');
    const shell = render(permission({ command: 'ls -la' }, { permission: 'bash', patterns: ['ls -la'], always: [] }));
    expect(shell).not.toContain('data-permission-mcp');
  });
});
