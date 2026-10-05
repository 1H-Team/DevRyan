import React, { act } from 'react';
import { expect, mock, spyOn, test } from 'bun:test';
import { withDom } from '@/components/bots/chat/botMountedDom';

const t = (key: string) => key;
const merged: unknown[] = [];
mock.module('@/lib/i18n', () => ({ useI18n: () => ({ t }) }));
mock.module('@/stores/useConfigApplyStore', () => ({ useConfigApplyStore: { getState: () => ({ mergeMutationResponse: (value: unknown) => merged.push(value) }) } }));
mock.module('@/components/ui/button', () => ({ Button: ({ children, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement>) => <button {...props}>{children}</button> }));
const { PackagedAgentPrompts } = await import('./PackagedAgentPrompts');
const { parsePackagedAgentPrompts } = await import('@/lib/api/packaged-agent-prompts');

test('explicit restoration refreshes a refused revision and queues only a successful change', async () => withDom(async (container) => {
  const { createRoot } = await import('react-dom/client');
  const root = createRoot(container as unknown as Element);
  const first = 'a'.repeat(64), second = 'b'.repeat(64);
  let current = first;
  let restored = false;
  const writes: Array<{ name: string; expectedHash: string }> = [];
  const fetchMock = spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
    if (init?.method === 'POST') {
      expect(new Headers(init.headers).get('X-DevRyan-CSRF')).toBe('1');
      writes.push(JSON.parse(String(init.body)));
      if (writes.length === 1) { current = second; return Response.json({ error: 'Prompt changed' }, { status: 409 }); }
      restored = true;
      return Response.json({ success: true, requiresApply: true, runtimeApplied: false });
    }
    return Response.json({ prompts: [{ name: 'builder', currentHash: current, packagedHash: 'c'.repeat(64), state: restored ? 'current' : 'modified' }] });
  });
  merged.length = 0;
  try {
    await act(async () => root.render(<PackagedAgentPrompts />));
    expect(writes).toHaveLength(0);
    expect(container.textContent).toContain('settings.agents.prompts.conflict');
    await act(async () => container.find(node => node.tagName === 'BUTTON')!.click());
    expect(container.textContent).toContain('Prompt changed');
    expect(merged).toHaveLength(0);
    await act(async () => container.find(node => node.tagName === 'BUTTON')!.click());
    expect(writes).toEqual([{ name: 'builder', expectedHash: first }, { name: 'builder', expectedHash: second }]);
    expect(merged).toEqual([{ success: true, requiresApply: true, runtimeApplied: false }]);
    expect(container.find(node => node.tagName === 'BUTTON')).toBeNull();
    expect(container.textContent).toContain('settings.agents.prompts.restored');
    expect(() => parsePackagedAgentPrompts({ prompts: [{ name: '../builder', state: 'modified' }] })).toThrow();
  } finally { await act(async () => root.unmount()); fetchMock.mockRestore(); }
}));
