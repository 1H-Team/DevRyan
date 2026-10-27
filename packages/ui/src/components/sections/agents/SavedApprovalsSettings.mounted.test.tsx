import React, { act } from 'react';
import { afterEach, beforeEach, expect, mock, test } from 'bun:test';
import { create } from 'zustand';
import { withDom, type HostElement } from '@/test/mountedDom';
import { settingsDict } from '@/lib/i18n/messages/en.settings';

const dict: Record<string, string> = settingsDict;
const t = (key: string, values: Record<string, string> = {}) => (dict[key] ?? key).replace(/\{(\w+)\}/g, (match, name: string) => values[name] ?? match);
mock.module('@/lib/i18n', () => ({ useI18n: () => ({ t }) }));
type ButtonProps = React.ButtonHTMLAttributes<HTMLButtonElement>;
mock.module('@/components/ui/button', () => ({
  Button: ({ onClick, disabled, children, ...props }: ButtonProps) => <button onClick={onClick} disabled={disabled} aria-label={props['aria-label']}>{children}</button>,
}));
mock.module('@/components/ui/input', () => ({
  Input: ({ onChange, onKeyDown, value, disabled, ...props }: React.InputHTMLAttributes<HTMLInputElement>) => (
    <input value={value} disabled={disabled} aria-label={props['aria-label']} onKeyDown={onKeyDown}
      onInput={(event) => onChange?.({ ...event, target: event.currentTarget } as React.ChangeEvent<HTMLInputElement>)} />
  ),
}));
mock.module('@/components/ui/switch', () => ({
  Switch: ({ checked, onCheckedChange, ...props }: { checked: boolean; onCheckedChange: (next: boolean) => void; 'aria-label'?: string }) => (
    <button role="switch" aria-checked={checked} aria-label={props['aria-label']} onClick={() => onCheckedChange(!checked)} />
  ),
}));
const permissions = create<{ defaultAutoAccept: boolean; setDefaultAutoAccept: (enabled: boolean) => void }>((set) => ({
  defaultAutoAccept: false,
  setDefaultAutoAccept: (enabled) => set({ defaultAutoAccept: enabled }),
}));
mock.module('@/stores/permissionStore', () => ({ usePermissionStore: permissions }));
const errors: string[] = [];
const successes: string[] = [];
const ui = await import('@/components/ui');
mock.module('@/components/ui', () => ({ ...ui, toast: { ...ui.toast,
  error: (message: string) => { errors.push(message); }, success: (message: string) => { successes.push(message); } } }));
const actualDialog = await import('@/components/ui/dialog');
const wrapper = ({ children }: React.PropsWithChildren) => <div>{children}</div>;
mock.module('@/components/ui/dialog', () => ({ ...actualDialog,
  Dialog: ({ open, children }: React.PropsWithChildren<{ open: boolean }>) => open ? <div role="dialog">{children}</div> : null,
  DialogContent: wrapper, DialogHeader: wrapper, DialogFooter: wrapper,
  DialogTitle: ({ children }: React.PropsWithChildren) => <h2>{children}</h2>,
  DialogDescription: ({ children }: React.PropsWithChildren) => <p>{children}</p>,
}));
mock.module('@/components/sections/shared/SettingsProjectSelector', () => ({
  SettingsProjectSelector: ({ onProjectChange }: { onProjectChange?: (id: string) => void }) => (
    <button onClick={() => onProjectChange?.('beta')}>Pick Beta</button>
  ),
}));
type Project = { id: string; path: string; label: string };
const projects = create<{ projects: Project[]; activeProjectId: string | null }>(() => ({
  projects: [{ id: 'alpha', path: '/repo/alpha', label: 'Alpha' }, { id: 'beta', path: '/repo/beta', label: 'Beta' }],
  activeProjectId: 'alpha',
}));
const actualProjects = await import('@/stores/useProjectsStore');
mock.module('@/stores/useProjectsStore', () => ({ ...actualProjects, useProjectsStore: projects }));
let principal: { scope: string; role: string } = { scope: 'local-admin', role: 'admin' };
const auth = await import('@/lib/authSession');
mock.module('@/lib/authSession', () => ({ ...auth, useAuthPrincipal: () => principal }));
const { SavedApprovalsSettings } = await import('./SavedApprovalsSettings');

const approval = (id: string, action: string, resource: string) => ({ id, projectID: 'prj', action, resource, anyInput: resource === '*',
  time: { created: 1_700_000_000_000, updated: 1_700_000_000_000 } });
const originalFetch = globalThis.fetch;
let calls: Array<{ path: string; method: string; body: string; csrf: string | null }> = [];
let listAnswer: (path: string) => Response;
beforeEach(() => {
  calls = []; errors.length = 0; successes.length = 0; principal = { scope: 'local-admin', role: 'admin' };
  permissions.setState({ defaultAutoAccept: false });
  listAnswer = (path) => Response.json({ projectID: 'prj', approvals: path.includes('%2Frepo%2Fbeta')
    ? [approval('psv_beta', 'edit', 'src/**')]
    : [approval('psv_bash', 'bash', 'git status*'), approval('psv_mcp', 'github_create_issue', '*')] });
  globalThis.fetch = Object.assign(mock(async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input), method = init?.method ?? 'GET';
    calls.push({ path, method, body: String(init?.body ?? ''), csrf: new Headers(init?.headers).get('x-devryan-csrf') });
    if (method === 'GET') return listAnswer(path);
    if (method === 'PATCH') {
      const { resource } = JSON.parse(String(init?.body)) as { resource: string };
      return Response.json({ ...approval('psv_mcp', 'github_create_issue', resource), time: { created: 1_700_000_000_000, updated: 1_700_000_500_000 } });
    }
    return Response.json({ id: 'psv_mcp', removed: true });
  }), { preconnect: () => {} });
});
afterEach(() => { globalThis.fetch = originalFetch; });

const button = (container: HostElement, label: string) => container.find((node) => node.tagName === 'BUTTON'
  && (node.textContent === label || node.getAttribute('aria-label') === label));
const click = async (container: HostElement, label: string) => act(async () => {
  const node = button(container, label); expect(node).not.toBeNull(); node?.click();
});
const render = async (container: HostElement) => {
  const { createRoot } = await import('react-dom/client');
  const root = createRoot(container as unknown as Element);
  await act(async () => root.render(<SavedApprovalsSettings />));
  return root;
};
const writes = () => calls.filter((call) => call.method !== 'GET');

test('lists the active project approvals and flags any-input rules', async () => withDom(async (container) => {
  const root = await render(container);
  try {
    expect(calls.map(({ method, path }) => ({ method, path })))
      .toEqual([{ method: 'GET', path: '/api/permission/saved?directory=%2Frepo%2Falpha' }]);
    expect(container.textContent).toContain('Saved Approvals');
    expect(container.textContent).toContain('bash');
    expect(container.textContent).toContain('git status*');
    expect(container.textContent).toContain('github_create_issue');
    expect(container.textContent).toContain('Any Input');
    expect(container.textContent).toContain('Always Allowed');
    expect(container.textContent).toContain('Saved ');
    expect(writes()).toEqual([]);
  } finally { await act(async () => root.unmount()); }
}));

test('puts the auto-accept default above saved approvals and toggles it', async () => withDom(async (container) => {
  const root = await render(container);
  try {
    const text = container.textContent ?? '';
    expect(text).toContain('Approvals');
    expect(text.indexOf('Auto-Accept Permissions')).toBeLessThan(text.indexOf('Saved Approvals'));
    const toggle = button(container, 'Auto-accept permissions in new sessions');
    expect(toggle?.getAttribute('aria-checked')).toBe('false');
    await click(container, 'Auto-accept permissions in new sessions');
    expect(permissions.getState().defaultAutoAccept).toBe(true);
    expect(button(container, 'Auto-accept permissions in new sessions')?.getAttribute('aria-checked')).toBe('true');
    expect(writes()).toEqual([]);
  } finally { await act(async () => root.unmount()); }
}));

test('edits the input pattern with CSRF and refuses an empty pattern', async () => withDom(async (container) => {
  const root = await render(container);
  try {
    await click(container, 'Edit Input for github_create_issue');
    const input = container.find((node) => node.tagName === 'INPUT');
    expect(input?.value).toBe('*');
    await act(async () => { if (input) { input.value = '  '; input.dispatch('input'); } });
    await click(container, 'Save');
    expect(writes()).toEqual([]);
    expect(errors).toEqual(['Enter an input pattern, or revoke the approval instead.']);
    await act(async () => { if (input) { input.value = 'repo:alpha'; input.dispatch('input'); } });
    await click(container, 'Save');
    expect(writes()).toEqual([{ path: '/api/permission/saved/psv_mcp?directory=%2Frepo%2Falpha', method: 'PATCH',
      body: JSON.stringify({ resource: 'repo:alpha' }), csrf: '1' }]);
    expect(container.find((node) => node.tagName === 'INPUT')).toBeNull();
    expect(container.textContent).toContain('repo:alpha');
    expect(container.textContent).not.toContain('Any Input');
    expect(container.textContent).toContain('edited');
  } finally { await act(async () => root.unmount()); }
}));

test('revokes only after confirmation', async () => withDom(async (container) => {
  const root = await render(container);
  try {
    await click(container, 'Revoke Approval for github_create_issue');
    expect(container.find((node) => node.getAttribute('role') === 'dialog')?.textContent)
      .toContain('github_create_issue is allowed with any input.');
    await click(container, 'Cancel');
    expect(container.find((node) => node.getAttribute('role') === 'dialog')).toBeNull();
    expect(writes()).toEqual([]);
    await click(container, 'Revoke Approval for bash');
    expect(container.textContent).toContain('bash will ask again before running with input matching "git status*".');
    await act(async () => {
      const dialog = container.find((node) => node.getAttribute('role') === 'dialog');
      dialog?.find((node) => node.tagName === 'BUTTON' && node.textContent === 'Revoke')?.click();
    });
    expect(writes()).toEqual([{ path: '/api/permission/saved/psv_bash?directory=%2Frepo%2Falpha', method: 'DELETE', body: '', csrf: '1' }]);
    expect(container.textContent).not.toContain('git status*');
    expect(successes).toEqual(['Revoked the saved approval for bash']);
  } finally { await act(async () => root.unmount()); }
}));

test('managed non-administrators get no edit control, an explanation, and keep revoke', async () => withDom(async (container) => {
  for (const role of ['developer', 'senior_developer']) {
    calls = []; principal = { scope: 'managed', role };
    const root = await render(container);
    try {
      expect(container.textContent).toContain('git status*');
      expect(button(container, 'Edit Input for bash')).toBeNull();
      expect(button(container, 'Edit')).toBeNull();
      expect(container.textContent).toContain('Only administrators can edit an approval');
      await click(container, 'Revoke Approval for bash');
      await act(async () => {
        container.find((node) => node.getAttribute('role') === 'dialog')
          ?.find((node) => node.tagName === 'BUTTON' && node.textContent === 'Revoke')?.click();
      });
      expect(writes().map(({ method, path }) => ({ method, path })))
        .toEqual([{ method: 'DELETE', path: '/api/permission/saved/psv_bash?directory=%2Frepo%2Falpha' }]);
    } finally { await act(async () => root.unmount()); }
  }
  principal = { scope: 'managed', role: 'admin' };
  const root = await render(container);
  try {
    expect(button(container, 'Edit Input for bash')).not.toBeNull();
    expect(container.textContent).not.toContain('Only administrators can edit an approval');
  } finally { await act(async () => root.unmount()); }
}));

test('switching project reloads that project only', async () => withDom(async (container) => {
  const root = await render(container);
  try {
    await click(container, 'Pick Beta');
    expect(calls.at(-1)).toMatchObject({ method: 'GET', path: '/api/permission/saved?directory=%2Frepo%2Fbeta' });
    expect(container.textContent).toContain('src/**');
    expect(container.textContent).not.toContain('git status*');
  } finally { await act(async () => root.unmount()); }
}));

test('reports a disabled server and a failed load without rows', async () => withDom(async (container) => {
  listAnswer = () => Response.json({ error: 'off', code: 'capability_unavailable' }, { status: 501 });
  let root = await render(container);
  try {
    expect(container.textContent).toContain('Saved approvals are turned off on this server.');
  } finally { await act(async () => root.unmount()); }
  listAnswer = () => Response.json({ error: 'Directory is outside your assigned workspace', code: 'saved_approval_forbidden' }, { status: 403 });
  root = await render(container);
  try {
    expect(container.textContent).toContain('Directory is outside your assigned workspace');
    expect(button(container, 'Revoke')).toBeNull();
  } finally { await act(async () => root.unmount()); }
}));
