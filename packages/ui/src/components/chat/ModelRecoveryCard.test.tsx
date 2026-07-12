import React from 'react';
import { describe, expect, mock, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';

import { I18nProvider } from '@/lib/i18n';

mock.module('@/components/ui/ProviderLogo', () => ({
  ProviderLogo: ({ providerId }: { providerId: string }) => React.createElement('img', { src: `/logos/${providerId}.svg` }),
}));

const { ModelRecoveryCard } = await import('./ModelRecoveryCard');

describe('ModelRecoveryCard', () => {
  test('uses the Agent Dispatch visual shell with manual model recovery controls', () => {
    const html = renderToStaticMarkup(
      <I18nProvider>
        <ModelRecoveryCard
          title="Choose a model to continue:"
          originalModelLabel="OpenCode Go / DeepSeek V4 Flash"
          providers={[]}
          selection={{ providerId: 'opencode-go', modelId: 'deepseek-v4-flash', variant: null }}
          pending={false}
          actionError={null}
          onSelectionChange={() => undefined}
          onRetry={() => undefined}
        />
      </I18nProvider>,
    );

    expect(html).toContain('Choose a model to continue:');
    expect(html).toContain('Model Recovery');
    expect(html).not.toContain('OpenCode Go usage limit reached');
    expect(html).toContain('OpenCode Go / DeepSeek V4 Flash');
    expect(html).toContain('Try Again');
    expect(html).toContain('normal-case');
    expect(html).toContain('rounded-xl');
    expect(html).toContain('border-[color-mix');
  });
});
