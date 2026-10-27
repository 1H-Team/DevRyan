import React, { act } from 'react';
import { beforeEach, describe, expect, mock, test } from 'bun:test';
import { withDom, type HostElement } from '@/test/mountedDom';
import { settingsDict } from '@/lib/i18n/messages/en.settings';

const messages: string[] = [];
const dict: Record<string, string> = settingsDict;
const t = (key: string, params?: Record<string, string | number>) => Object.entries(params ?? {})
  .reduce((text, [name, value]) => text.replace(`{${name}}`, String(value)), dict[key] ?? key);
mock.module('@/lib/i18n', () => ({ useI18n: () => ({ t }) }));
mock.module('@/components/ui', () => ({ toast: {
  success: (message: string) => messages.push(`success:${message}`), error: (message: string) => messages.push(`error:${message}`),
} }));
type ButtonProps = React.ButtonHTMLAttributes<HTMLButtonElement> & { variant?: string; size?: string };
mock.module('@/components/ui/button', () => ({
  Button: ({ children, onClick, disabled, 'aria-label': label }: ButtonProps) => (
    <button onClick={onClick} disabled={disabled} aria-label={label}>{children}</button>
  ),
}));
mock.module('@/components/ui/radio', () => ({
  Radio: ({ checked, onChange, ariaLabel, disabled }: { checked: boolean; onChange: () => void; ariaLabel?: string; disabled?: boolean }) => (
    <button role="radio" aria-checked={checked} aria-label={ariaLabel} disabled={disabled} onClick={() => { if (!checked) onChange(); }} />
  ),
}));
mock.module('@/components/ui/input', () => ({
  Input: ({ value, onChange, 'aria-label': label }: React.InputHTMLAttributes<HTMLInputElement>) => (
    <input value={value} aria-label={label} onInput={(event) => onChange?.({ ...event, target: event.currentTarget })} />
  ),
}));
const Passthrough = ({ children }: { children?: React.ReactNode }) => <>{children}</>;
mock.module('@/components/ui/dialog', () => ({
  Dialog: ({ open, children }: { open: boolean; children?: React.ReactNode }) => (open ? <div data-dialog="open">{children}</div> : null),
  DialogContent: Passthrough, DialogHeader: Passthrough, DialogFooter: Passthrough, DialogTitle: Passthrough, DialogDescription: Passthrough,
}));
const { ProviderAccounts } = await import('./ProviderAccounts');

type Account = { id: string; label: string; method: 'key' | 'oauth'; active: boolean; needsAuth?: boolean };
let accounts: Account[] = [];
let calls: string[] = [];
let listStatus = 200;

const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = String(input);
  const method = init?.method ?? 'GET';
  calls.push(`${method} ${url}${init?.body ? ` ${String(init.body)}` : ''}`);
  if (method !== 'GET') expect(new Headers(init?.headers).get('X-DevRyan-CSRF')).toBe('1');
  if (url.startsWith('/api/provider/openai/accounts')) {
    if (listStatus !== 200) return Response.json({ error: 'unavailable', code: 'capability_unavailable' }, { status: listStatus });
    return Response.json({ providerID: 'openai', accounts });
  }
  const activate = /^\/api\/credential\/([^/?]+)\/activate/.exec(url);
  if (activate && method === 'POST') {
    accounts = accounts.map((account) => ({ ...account, active: account.id === activate[1] }));
    return Response.json(true);
  }
  const single = /^\/api\/credential\/([^/?]+)/.exec(url);
  if (single && method === 'PATCH') {
    const label = (JSON.parse(String(init?.body)) as { label: string }).label;
    accounts = accounts.map((account) => account.id === single[1] ? { ...account, label } : account);
    return Response.json(true);
  }
  if (single && method === 'DELETE') {
    accounts = accounts.filter((account) => account.id !== single[1]);
    return Response.json(true);
  }
  throw new Error(`Unexpected fixture request: ${method} ${url}`);
}) as typeof fetch;

beforeEach(() => {
  messages.length = 0;
  calls = [];
  listStatus = 200;
  accounts = [
    { id: 'cred_personal', label: 'Personal', method: 'oauth', active: true },
    { id: 'cred_work', label: 'Work', method: 'oauth', active: false, needsAuth: true },
  ];
});

const settle = () => act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
const byLabel = (container: HostElement, label: string) => container.find((node) => node.getAttribute('aria-label') === label);
const byText = (container: HostElement, tag: string, text: string) => container.find((node) => node.tagName === tag && node.textContent === text);

const mount = async (run: (container: HostElement, added: () => number) => Promise<void>, providerId = 'openai') => {
  await withDom(async (container) => {
    const { createRoot } = await import('react-dom/client');
    const root = createRoot(container as unknown as Element);
    let addCount = 0;
    await act(async () => root.render(
      <ProviderAccounts providerId={providerId} directory="/work" refreshKey={0} onAddAccount={() => { addCount += 1; }} fetchImpl={fetchImpl} />,
    ));
    await settle();
    try {
      await run(container, () => addCount);
    } finally {
      await act(async () => root.unmount());
    }
  });
};

describe('provider accounts', () => {
  test('lists accounts with the active marker and switches to another account', async () => {
    await mount(async (container) => {
      expect(calls[0]).toBe('GET /api/provider/openai/accounts?directory=%2Fwork');
      const personal = byLabel(container, 'Use Personal');
      const work = container.find((node) => node.getAttribute('role') === 'radio' && node.getAttribute('aria-label') === 'Use Work');
      expect(personal?.getAttribute('aria-checked')).toBe('true');
      expect(work?.getAttribute('aria-checked')).toBe('false');
      expect(container.textContent).toContain('Active');
      expect(container.textContent).toContain('Sign in again');

      await act(async () => { work?.click(); });
      await settle();
      expect(calls).toContain('POST /api/credential/cred_work/activate?directory=%2Fwork {}');
      expect(messages).toContain('success:Now using Work');
      // The list reloads from the server after the switch.
      expect(calls.filter((call) => call.startsWith('GET ')).length).toBe(2);
      const switched = container.find((node) => node.getAttribute('role') === 'radio' && node.getAttribute('aria-label') === 'Use Work');
      expect(switched?.getAttribute('aria-checked')).toBe('true');
    });
  });

  test('renames an account inline', async () => {
    await mount(async (container) => {
      await act(async () => { byLabel(container, 'Rename Work')?.click(); });
      const input = container.find((node) => node.tagName === 'INPUT');
      expect(input?.value).toBe('Work');
      await act(async () => {
        input!.value = 'Client';
        input!.dispatch('input');
      });
      await act(async () => { byText(container, 'BUTTON', 'Save')?.click(); });
      await settle();
      expect(calls).toContain('PATCH /api/credential/cred_work?directory=%2Fwork {"label":"Client"}');
      expect(messages).toContain('success:Account renamed');
      expect(container.find((node) => node.tagName === 'INPUT')).toBeNull();
      expect(container.textContent).toContain('Client');
    });
  });

  test('removes an account only after confirmation', async () => {
    await mount(async (container) => {
      await act(async () => { byLabel(container, 'Remove Personal')?.click(); });
      expect(calls.some((call) => call.startsWith('DELETE'))).toBe(false);
      const dialog = container.find((node) => node.getAttribute('data-dialog') === 'open');
      expect(dialog?.textContent).toContain('Remove Personal?');
      expect(dialog?.textContent).toContain('newest remaining account becomes active');

      await act(async () => { byText(dialog!, 'BUTTON', 'Cancel')?.click(); });
      expect(container.find((node) => node.getAttribute('data-dialog') === 'open')).toBeNull();
      expect(calls.some((call) => call.startsWith('DELETE'))).toBe(false);

      await act(async () => { byLabel(container, 'Remove Personal')?.click(); });
      const confirm = container.find((node) => node.getAttribute('data-dialog') === 'open');
      await act(async () => { byText(confirm!, 'BUTTON', 'Remove')?.click(); });
      await settle();
      expect(calls).toContain('DELETE /api/credential/cred_personal?directory=%2Fwork');
      expect(messages).toContain('success:Removed Personal');
      expect(container.find((node) => node.getAttribute('data-account-id') === 'cred_personal')).toBeNull();
    });
  });

  test('opens the existing connect flow to add another account', async () => {
    await mount(async (container, added) => {
      await act(async () => { byText(container, 'BUTTON', 'Add Another Account')?.click(); });
      expect(added()).toBe(1);
    });
  });

  test('renders nothing when the runtime cannot list accounts or the provider has none to manage', async () => {
    listStatus = 501;
    await mount(async (container) => {
      expect(container.find((node) => node.getAttribute('data-provider-accounts') !== null)).toBeNull();
    });
    await mount(async (container) => {
      expect(container.find((node) => node.getAttribute('data-provider-accounts') !== null)).toBeNull();
      expect(calls.some((call) => call.includes('/api/provider/anthropic'))).toBe(false);
    }, 'anthropic');
  });
});
