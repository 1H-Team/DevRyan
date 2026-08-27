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
          failureMessage="You've hit your limit · resets 1:30am (Africa/Casablanca). This session was stopped."
          onSelectionChange={() => undefined}
          onRetry={() => undefined}
        />
      </I18nProvider>,
    );

    expect(html).toContain('Choose a model to continue:');
    expect(html).toContain('Model Recovery');
    expect(html).toContain('You&#x27;ve hit your limit · resets 1:30am (Africa/Casablanca). This session was stopped.');
    expect(html).toContain('role="alert"');
    expect(html).toContain('OpenCode Go / DeepSeek V4 Flash');
    expect(html).toContain('Try Again');
    expect(html).toContain('normal-case');
    expect(html).toContain('rounded-xl');
    expect(html).toContain('border-[color-mix');
  });

  test('renders a timeout detail line alongside the model picker', () => {
    const html = renderToStaticMarkup(
      <I18nProvider>
        <ModelRecoveryCard
          embedded
          title="This subtask ran out of time. Choose a model to continue it:"
          detail="It hit its time limit before finishing. Try Again continues it from saved progress with at least the original time window."
          originalModelLabel="Anthropic / Claude Opus 5"
          providers={[]}
          selection={{ providerId: 'anthropic', modelId: 'claude-opus-5', variant: 'max' }}
          pending={false}
          actionError={null}
          onSelectionChange={() => undefined}
          onRetry={() => undefined}
        />
      </I18nProvider>,
    );

    expect(html).toContain('This subtask ran out of time. Choose a model to continue it:');
    expect(html).toContain('at least the original time window');
    // The picker stays: the user may still want a different model for the retry.
    expect(html).toContain('Anthropic / Claude Opus 5');
    expect(html).toContain('Try Again');
  });

  test('keeps Try Again visible and disables it while one retry is in flight', () => {
    const html = renderToStaticMarkup(
      <I18nProvider>
        <ModelRecoveryCard
          title="Choose a model to continue:"
          originalModelLabel="openai / gpt-5.6"
          providers={[]}
          selection={{ providerId: 'openai', modelId: 'gpt-5.6', variant: 'high' }}
          pending
          actionError={null}
          onSelectionChange={() => undefined}
          onRetry={() => undefined}
        />
      </I18nProvider>,
    );

    expect(html).toContain('Trying Again…');
    expect(html).toContain('disabled=""');
  });

  test('keeps a failed retry visible and actionable', () => {
    const html = renderToStaticMarkup(
      <I18nProvider>
        <ModelRecoveryCard
          title="Choose a model to continue:"
          originalModelLabel="openai / gpt-5.6"
          providers={[]}
          selection={{ providerId: 'openai', modelId: 'gpt-5.6', variant: 'high' }}
          pending={false}
          actionError="Recovery request failed. Try again."
          onSelectionChange={() => undefined}
          onRetry={() => undefined}
        />
      </I18nProvider>,
    );

    expect(html).toContain('Recovery request failed. Try again.');
    expect(html).toContain('role="alert"');
    expect(html).toContain('Try Again');
    expect(html).not.toContain('disabled=""');
  });

  test('renders the explicit Claude compatibility recovery action', () => {
    const html = renderToStaticMarkup(
      <I18nProvider>
        <ModelRecoveryCard
          title="Retry this turn with Claude compatibility mode:"
          originalModelLabel="anthropic / claude-opus-4-1"
          providers={[]}
          selection={{ providerId: 'anthropic', modelId: 'claude-opus-4-1', variant: null }}
          pending={false}
          actionError={null}
          failureMessage="Anthropic classified this turn as third-party usage."
          retryLabel="Enable Compatibility & Try Again"
          retryingLabel="Enabling Compatibility…"
          onSelectionChange={() => undefined}
          onRetry={() => undefined}
        />
      </I18nProvider>,
    );

    expect(html).toContain('Enable Compatibility &amp; Try Again');
    expect(html).toContain('Anthropic classified this turn as third-party usage.');
    expect(html).toContain('max-w-full whitespace-normal');
    expect(html).toContain('w-full min-w-0 flex-wrap');
  });
});
