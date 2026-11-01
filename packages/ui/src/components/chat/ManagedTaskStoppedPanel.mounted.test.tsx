import React, { act } from 'react';
import { expect, mock, test } from 'bun:test';

import { I18nProvider } from '@/lib/i18n';
import type { ProviderRecoverySelection } from '@/stores/useProviderRecoveryStore';
import { withDom } from '@/test/mountedDom';

mock.module('@/components/ui/ProviderLogo', () => ({
  ProviderLogo: ({ providerId }: { providerId: string }) => React.createElement('img', { src: `/logos/${providerId}.svg` }),
}));
const { ManagedTaskStoppedPanel } = await import('./ManagedTaskStoppedPanel');

const lastModel: ProviderRecoverySelection = { providerId: 'opencode', modelId: 'deepseek-v4.1-flash', variant: null };

test('Resume as Task resumes on the last model and the model choice stays secondary', async () => {
  const resumed: ProviderRecoverySelection[] = [];
  let dismissed = 0;
  await withDom(async (container) => {
    const { createRoot } = await import('react-dom/client');
    const root = createRoot(container as unknown as Element);
    try {
      await act(async () => {
        root.render(
          <I18nProvider>
            <ManagedTaskStoppedPanel
              title="Stopped by you"
              detail="You stopped this subtask."
              lastModelLabel="OpenCode Zen / DeepSeek V4.1 Flash"
              providers={[]}
              selection={lastModel}
              onSelectionChange={() => undefined}
              pending={false}
              actionError={null}
              onResume={(selection) => { resumed.push(selection); }}
              onDismiss={() => { dismissed += 1; }}
            />
          </I18nProvider>,
        );
      });
      const button = (label: string) => container.find((node) => node.tagName === 'BUTTON' && node.textContent === label);
      expect(container.textContent).toContain('Last model: OpenCode Zen / DeepSeek V4.1 Flash');
      expect(container.textContent).not.toContain('Model Recovery');

      await act(async () => { button('Resume as Task')?.click(); });
      expect(resumed).toEqual([lastModel]);

      await act(async () => { button('Dismiss Stopped Task')?.click(); });
      expect(dismissed).toBe(1);

      await act(async () => { button('Change Model')?.click(); });
      expect(button('Change Model')).toBeNull();
      expect(container.textContent).not.toContain('Last model:');
    } finally {
      await act(async () => root.unmount());
    }
  });
});
