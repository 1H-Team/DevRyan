import React from 'react';
import { describe, expect, mock, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';

import { I18nProvider } from '@/lib/i18n';
mock.module('@/components/ui/ProviderLogo', () => ({
  ProviderLogo: ({ providerId }: { providerId: string }) => React.createElement('img', { src: `/logos/${providerId}.svg` }),
}));

const { ControlledModelPicker, ControlledVariantPicker } = await import('./ControlledModelPicker');
const { getControlledModelOptions } = await import('./controlledModelPickerOptions');

const providers = [{
  id: 'opencode-go',
  name: 'OpenCode Go',
  models: [
    { id: 'deepseek-v4-flash', name: 'DeepSeek V4 Flash', variants: { low: {}, medium: {}, high: {} } },
    { id: 'hidden', name: 'Hidden Model', available: false },
  ],
}];

describe('ControlledModelPicker', () => {
  test('uses the composer picker filtering and sorting contract', () => {
    const options = getControlledModelOptions(providers, []);
    expect(options).toHaveLength(1);
    expect({
      providerId: options[0]?.providerId,
      providerName: options[0]?.providerName,
      modelId: options[0]?.modelId,
      modelName: options[0]?.modelName,
      model: options[0]?.model,
    }).toEqual({
      providerId: 'opencode-go',
      providerName: 'OpenCode Go',
      modelId: 'deepseek-v4-flash',
      modelName: 'DeepSeek V4 Flash',
      model: providers[0].models[0],
    });
  });

  test('renders the same model trigger language used by the chat input', () => {
    const html = renderToStaticMarkup(
      <I18nProvider>
        <ControlledModelPicker
          providers={providers}
          value={{ providerId: 'opencode-go', modelId: 'deepseek-v4-flash', variant: null }}
          onChange={() => undefined}
        />
      </I18nProvider>,
    );
    expect(html).toContain('model-controls__model-trigger');
    expect(html).toContain('DeepSeek V4 Flash');
    expect(html).toContain('/logos/opencode-go.svg');
  });

  test('renders the selected thinking level beside the model picker', () => {
    const html = renderToStaticMarkup(
      <I18nProvider>
        <ControlledVariantPicker
          providers={providers}
          value={{ providerId: 'opencode-go', modelId: 'deepseek-v4-flash', variant: 'high' }}
          onChange={() => undefined}
        />
      </I18nProvider>,
    );
    expect(html).toContain('model-controls__variant-trigger');
    expect(html).toContain('High');
    expect(html).toContain('aria-label="Thinking"');
  });
});
