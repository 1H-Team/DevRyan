import React, { act } from 'react';
import { afterEach, describe, expect, mock, test } from 'bun:test';
import { withDom } from '@/components/bots/chat/botMountedDom';
import { I18nProvider } from '@/lib/i18n';
import { beginRuntimeCapabilityRead, observeRuntimeCapabilityHealth, resetRuntimeCapabilitiesForTests } from '@/lib/opencode/runtime-capabilities';
// Tooltip positioning needs a browser; keep the real buttons and capability hooks.
mock.module('@/components/ui/tooltip', () => ({
  Tooltip: ({ children }: { children: React.ReactNode }) => children,
  TooltipTrigger: ({ children }: { children: React.ReactNode }) => children,
  TooltipContent: () => null,
}));
const { SidebarHeader } = await import('./SidebarHeader');

afterEach(resetRuntimeCapabilitiesForTests);
const header = () => (<I18nProvider><SidebarHeader
  hideDirectoryControls={false} handleNewSession={() => {}} onOpenMultiRun={() => {}} onOpenScheduledTasks={() => {}}
  headerActionIconClass="" reserveHeaderActionsSpace={true} headerActionButtonClass="" isSessionSearchOpen={false}
  setIsSessionSearchOpen={() => {}} audience="coding-agents" onAudienceChange={() => {}}
/></I18nProvider>);

describe('Standard Preview sidebar controls', () => {
  test('keeps ordinary New Chat and revokes managed controls on the mounted UI', async () => withDom(async (container) => {
    const { createRoot } = await import('react-dom/client');
    const root = createRoot(container as unknown as Element);
    const button = (label: string) => container.find((node) => node.tagName === 'BUTTON' && node.getAttribute('aria-label') === label);
    try {
      await act(async () => { root.render(header()); });
      expect(button('New Chat')).not.toBeNull();
      expect(button('New Multi-Run')).not.toBeNull();
      expect(button('Scheduled Tasks')).not.toBeNull();
      await act(async () => {
        observeRuntimeCapabilityHealth({ openCode: { generation: 2, runtimeMode: 'standard-preview', ordinaryUserPermissions: true,
          capabilities: { chat: true, sessions: true, files: true, providerApiKey: true },
        } }, beginRuntimeCapabilityRead());
      });
      expect(button('New Chat')).not.toBeNull();
      expect(button('New Multi-Run')).toBeNull();
      expect(button('Scheduled Tasks')).toBeNull();
      expect(container.find((node) => node.getAttribute('role') === 'tab' && node.textContent === 'Bots')).toBeNull();
    } finally { await act(async () => { root.unmount(); }); }
  }));
});
