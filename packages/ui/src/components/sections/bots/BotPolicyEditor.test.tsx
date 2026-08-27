import React from 'react';
import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';

import { I18nProvider } from '@/lib/i18n';
import { BotPolicyEditor } from './BotPolicyEditor';
import { createDefaultBotRevisionContract } from './botManagementPresentation';

describe('BotPolicyEditor', () => {
  test('presents broad Allow as informational instead of a publication blocker', () => {
    const contract = createDefaultBotRevisionContract();
    const markup = renderToStaticMarkup(
      <I18nProvider>
        <BotPolicyEditor
          value={{
            actionPolicy: contract.actionPolicy,
            browserPolicy: contract.browserPolicy,
            memoryPolicy: contract.memoryPolicy,
          }}
          onChange={() => {}}
        />
      </I18nProvider>,
    );
    expect(markup).toContain('Broad Allow lets ordinary bounded actions run automatically');
    expect(markup).toContain('Leave empty to allow any valid HTTP(S) origin');
    expect(markup).not.toContain('allowed origin uncovered');
  });

  test('renders browser, action, evidence, and memory controls', () => {
    const contract = createDefaultBotRevisionContract();
    const markup = renderToStaticMarkup(
      <I18nProvider>
        <BotPolicyEditor
          value={{
            actionPolicy: contract.actionPolicy,
            browserPolicy: contract.browserPolicy,
            memoryPolicy: contract.memoryPolicy,
          }}
          onChange={() => {}}
        />
      </I18nProvider>,
    );
    expect(markup).toContain('Guarded action policy');
    expect(markup).toContain('Reviewed action rules');
    expect(markup).toContain('Allowed Browser Origins');
    expect(markup).toContain('Learn from Conversations');
    expect(markup).not.toContain('User-Private Memory');
  });
});
