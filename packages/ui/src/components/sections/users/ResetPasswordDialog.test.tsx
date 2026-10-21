import React, { act } from 'react';
import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';

import { withDom, type HostElement } from '@/components/bots/chat/botMountedDom';

const passthrough = ({ children }: React.PropsWithChildren) => <>{children}</>;
mock.module('@/components/ui/dialog', () => ({
  Dialog: ({ children, open }: React.PropsWithChildren<{ open: boolean }>) => (open ? <>{children}</> : null),
  DialogContent: passthrough, DialogDescription: passthrough, DialogFooter: passthrough,
  DialogHeader: passthrough, DialogTitle: passthrough,
}));
mock.module('@/components/ui', () => ({ toast: { success() {}, error() {} } }));
mock.module('@/components/ui/button', () => ({
  Button: ({ children, onClick, disabled }: React.ButtonHTMLAttributes<HTMLButtonElement>) => (
    <button onClick={onClick} disabled={disabled}>{children}</button>
  ),
}));

type InputProps = { type?: string; autoComplete?: string; minLength?: number; maxLength?: number; value?: string; onChange?: (event: { target: { value: string } }) => void };
let inputs: InputProps[] = [];
mock.module('@/components/ui/input', () => ({
  Input: (props: InputProps) => { inputs.push(props); return <input value={props.value} readOnly />; },
}));

const { ResetPasswordDialog } = await import('./ResetPasswordDialog');

const user = { id: 'user 1', email: 'a@example.test', display_name: 'A', role: 'developer', status: 'active', github_account_id: null } as const;
const requests: Array<{ url: string; method?: string; body?: string }> = [];
const temporaryPasswords: string[] = [];
const originalFetch = globalThis.fetch;
beforeEach(() => {
  requests.length = 0; temporaryPasswords.length = 0; inputs = [];
  globalThis.fetch = Object.assign(async (input: RequestInfo | URL, init?: RequestInit) => {
    requests.push({ url: String(input), method: init?.method, body: init?.body as string | undefined });
    return Response.json({ temporaryPassword: 'generated-secret' });
  }, { preconnect: () => {} });
});
afterEach(() => { globalThis.fetch = originalFetch; });

const mount = async (run: (container: HostElement) => Promise<void>) => withDom(async (container) => {
  const { createRoot } = await import('react-dom/client');
  const root = createRoot(container as unknown as Element);
  try {
    await act(async () => {
      root.render(<ResetPasswordDialog user={user} open onOpenChange={() => {}} onTemporaryPassword={(password) => temporaryPasswords.push(password)} />);
    });
    await run(container);
  } finally { await act(async () => root.unmount()); }
});

const latest = (index: 0 | 1): InputProps => inputs.filter((_, i) => i % 2 === index).at(-1)!;
const type = async (password: string, confirmation: string) => {
  await act(async () => { latest(0).onChange?.({ target: { value: password } }); });
  await act(async () => { latest(1).onChange?.({ target: { value: confirmation } }); });
};
const button = (container: HostElement, text: string) => container.find((node) => node.tagName === 'BUTTON' && node.textContent.includes(text));
const isDisabled = (node: HostElement | null) => node?.hasAttribute('disabled') === true;

describe('administrator password reset dialog', () => {
  test('offers masked, bounded new-password inputs', async () => {
    await mount(async () => {
      for (const index of [0, 1] as const) {
        expect(latest(index)).toMatchObject({ type: 'password', autoComplete: 'new-password', minLength: 6, maxLength: 256 });
      }
    });
  });

  test('accepts passwords from six through 256 characters that match their confirmation', async () => {
    await mount(async (container) => {
      const set = () => button(container, 'Set Password');
      expect(isDisabled(set())).toBe(true);
      for (const [length, enabled] of [[5, false], [6, true], [256, true], [257, false]] as const) {
        const password = 'p'.repeat(length);
        await type(password, password);
        expect(isDisabled(set())).toBe(!enabled);
      }
      await type('secret1', 'secret2');
      expect(isDisabled(set())).toBe(true);
      expect(container.textContent).toContain('Passwords do not match.');
    });
  });

  test('sets the explicit confirmed password through the admin reset endpoint', async () => {
    await mount(async (container) => {
      await type('secret1', 'secret1');
      await act(async () => button(container, 'Set Password')?.click());
      expect(requests).toEqual([{ url: '/api/admin/users/user%201/reset-password', method: 'POST', body: JSON.stringify({ password: 'secret1' }) }]);
      expect(temporaryPasswords).toEqual([]);
    });
  });

  test('generates a temporary password without sending one and hands it to the caller', async () => {
    await mount(async (container) => {
      await act(async () => button(container, 'Generate Temporary Password')?.click());
      expect(requests).toHaveLength(1);
      expect(requests[0]?.body).toBeUndefined();
      expect(temporaryPasswords).toEqual(['generated-secret']);
    });
  });
});
