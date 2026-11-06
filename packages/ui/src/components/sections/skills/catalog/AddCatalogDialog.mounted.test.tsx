import React, { act } from 'react';
import { beforeEach, describe, expect, mock, test } from 'bun:test';
import { create } from 'zustand';
import { withDom, type HostElement } from '@/test/mountedDom';
import { settingsDict } from '@/lib/i18n/messages/en.settings';
import type { SkillsRepoScanRequest, SkillsRepoScanResponse } from '@/lib/api/types';
import type { AuthPrincipal } from '@/lib/authSession';

const dict: Record<string, string> = settingsDict;
const t = (key: string, values: Record<string, string | number> = {}) => (dict[key] ?? key)
  .replace(/\{(\w+)\}/g, (match, name: string) => String(values[name] ?? match));
// Stable like the real translator.
const translator = { t };
mock.module('@/lib/i18n', () => ({ useI18n: () => translator }));
const errors: string[] = [];
mock.module('@/components/ui', () => ({ toast: {
  error: (message: string) => { errors.push(message); }, success() {}, message() {},
} }));
type ButtonProps = React.ButtonHTMLAttributes<HTMLButtonElement> & { variant?: string; size?: string };
mock.module('@/components/ui/button', () => ({
  Button: ({ children, onClick, disabled }: ButtonProps) => <button onClick={onClick} disabled={disabled}>{children}</button>,
}));
mock.module('@/components/ui/input', () => ({
  Input: ({ value, onChange, placeholder }: React.InputHTMLAttributes<HTMLInputElement>) => (
    <input value={value} placeholder={placeholder}
      onInput={(event) => onChange?.({ ...event, target: event.currentTarget } as React.ChangeEvent<HTMLInputElement>)} />
  ),
}));
const Passthrough = ({ children }: React.PropsWithChildren) => <>{children}</>;
mock.module('@/components/ui/dialog', () => ({
  Dialog: ({ open, children }: React.PropsWithChildren<{ open: boolean }>) => (open ? <div role="dialog">{children}</div> : null),
  DialogContent: Passthrough, DialogHeader: Passthrough, DialogFooter: Passthrough, DialogTitle: Passthrough, DialogDescription: Passthrough,
}));
mock.module('@/components/ui/select', () => ({
  Select: ({ children }: React.PropsWithChildren) => <div data-select="">{children}</div>,
  SelectTrigger: ({ children }: React.PropsWithChildren) => <div data-select-trigger="">{children}</div>,
  SelectContent: Passthrough,
  SelectItem: ({ children, value }: React.PropsWithChildren<{ value: string }>) => <div data-select-item={value}>{children}</div>,
}));
const registry = await import('@/contexts/runtimeAPIRegistry');
mock.module('@/contexts/runtimeAPIRegistry', () => ({ ...registry,
  getRegisteredRuntimeAPIs: () => ({ settings: { load: async () => ({ settings: { skillCatalogs: [] } }) } }) }));
mock.module('@/lib/persistence', () => ({ updateDesktopSettings: async () => {} }));

let scanRequests: SkillsRepoScanRequest[] = [];
let scanAnswer: SkillsRepoScanResponse = { ok: true, items: [] };
const catalog = create<{
  isScanning: boolean;
  scanRepo: (request: SkillsRepoScanRequest) => Promise<SkillsRepoScanResponse>;
  loadCatalog: () => Promise<boolean>;
}>(() => ({
  isScanning: false,
  scanRepo: async (request) => { scanRequests.push(request); return scanAnswer; },
  loadCatalog: async () => true,
}));
mock.module('@/stores/useSkillsCatalogStore', () => ({ useSkillsCatalogStore: catalog }));
const gitIdentities = create<{ defaultGitIdentityId: string | null; loadDefaultGitIdentityId: () => Promise<boolean> }>(() => ({
  defaultGitIdentityId: null,
  loadDefaultGitIdentityId: async () => true,
}));
mock.module('@/stores/useGitIdentitiesStore', () => ({ useGitIdentitiesStore: gitIdentities }));
let principal: Pick<AuthPrincipal, 'scope' | 'role'> = { scope: 'local-admin', role: 'admin' };
const auth = await import('@/lib/authSession');
mock.module('@/lib/authSession', () => ({ ...auth, useAuthPrincipal: () => principal }));
const { AddCatalogDialog } = await import('./AddCatalogDialog');

// The server's answers (lib/skills-catalog/git.js authRequiredError).
const MANAGED_AUTH_MESSAGE = 'Authentication required to access this repository. Connect a GitHub account that can read it.';
const LOCAL_AUTH_MESSAGE = 'Authentication required to access this repository';

beforeEach(() => {
  errors.length = 0;
  scanRequests = [];
  scanAnswer = { ok: true, items: [] };
  principal = { scope: 'local-admin', role: 'admin' };
  gitIdentities.setState({ defaultGitIdentityId: null });
});

const settle = () => act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
const scanButton = (container: HostElement) => container.find((node) => (
  node.tagName === 'BUTTON' && node.textContent === dict['settings.skills.catalog.shared.actions.scan']
));
const identityPicker = (container: HostElement) => container.find((node) => node.hasAttribute('data-select'));

const mount = async (run: (container: HostElement) => Promise<void>) => withDom(async (container) => {
  const { createRoot } = await import('react-dom/client');
  const root = createRoot(container as unknown as Element);
  try {
    await act(async () => { root.render(<AddCatalogDialog open onOpenChange={() => {}} />); });
    await settle();
    await run(container);
  } finally { await act(async () => root.unmount()); }
});

const scan = async (container: HostElement, source: string) => {
  const repository = container.find((node) => (
    node.tagName === 'INPUT' && node.getAttribute('placeholder') === dict['settings.skills.catalog.shared.field.repositoryPlaceholder']
  ));
  expect(repository).not.toBeNull();
  await act(async () => {
    repository!.value = source;
    repository!.dispatch('input');
  });
  await act(async () => { scanButton(container)?.click(); });
  await settle();
};

describe('Add Skills Catalog dialog authentication', () => {
  test('shows a managed user the server message when no identity is offered', async () => {
    principal = { scope: 'managed', role: 'admin' };
    scanAnswer = { ok: false, error: { kind: 'authRequired', message: MANAGED_AUTH_MESSAGE, sshOnly: true, identities: [] } };
    await mount(async (container) => {
      await scan(container, 'acme/private-skills');

      expect(scanRequests.map((request) => [request.source, request.gitIdentityId])).toEqual([['acme/private-skills', undefined]]);
      expect(errors).toEqual([MANAGED_AUTH_MESSAGE]);
      expect(identityPicker(container)).toBeNull();
      expect(container.textContent).not.toContain(dict['settings.skills.catalog.shared.auth.description']);
    });
  });

  test('shows the server message when the local owner has no identity to offer', async () => {
    scanAnswer = { ok: false, error: { kind: 'authRequired', message: LOCAL_AUTH_MESSAGE, sshOnly: true, identities: [] } };
    await mount(async (container) => {
      await scan(container, 'acme/private-skills');

      expect(errors).toEqual([LOCAL_AUTH_MESSAGE]);
      expect(identityPicker(container)).toBeNull();
    });
  });

  test('falls back to the dialog copy when the server sends no message', async () => {
    scanAnswer = { ok: false, error: { kind: 'authRequired', message: '', sshOnly: true } };
    await mount(async (container) => {
      await scan(container, 'acme/private-skills');

      expect(errors).toEqual([dict['settings.skills.catalog.add.toast.authenticationRequiredScan']]);
    });
  });

  test('asks the local owner to pick one of the offered identities and rescans with it', async () => {
    gitIdentities.setState({ defaultGitIdentityId: 'personal' });
    scanAnswer = { ok: false, error: { kind: 'authRequired', message: LOCAL_AUTH_MESSAGE, sshOnly: true, identities: [
      { id: 'work', name: 'Work' },
      { id: 'personal', name: 'Personal' },
    ] } };
    await mount(async (container) => {
      await scan(container, 'acme/private-skills');

      expect(errors).toEqual([dict['settings.skills.catalog.add.toast.authenticationRequiredScan']]);
      expect(container.textContent).toContain(dict['settings.skills.catalog.shared.auth.description']);
      expect(container.find((node) => node.hasAttribute('data-select-trigger'))?.textContent).toBe('Personal');

      await act(async () => { scanButton(container)?.click(); });
      await settle();
      expect(scanRequests.map((request) => request.gitIdentityId)).toEqual([undefined, 'personal']);
    });
  });
});

describe('Add Skills Catalog dialog repository hint', () => {
  test('tells the local owner about Git identities', async () => {
    await mount(async (container) => {
      expect(container.textContent).toContain(dict['settings.skills.catalog.add.field.repositoryHint']);
      expect(container.textContent).not.toContain(dict['settings.skills.catalog.add.field.managedRepositoryHint']);
    });
  });

  test('tells a managed user about their connected GitHub account', async () => {
    principal = { scope: 'managed', role: 'developer' };
    await mount(async (container) => {
      expect(container.textContent).toContain(dict['settings.skills.catalog.add.field.managedRepositoryHint']);
      expect(container.textContent).not.toContain(dict['settings.skills.catalog.add.field.repositoryHint']);
    });
  });
});
