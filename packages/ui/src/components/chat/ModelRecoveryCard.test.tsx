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

  const renderAutoResume = (
    autoResume: React.ComponentProps<typeof ModelRecoveryCard>['autoResume'],
    extra: Partial<React.ComponentProps<typeof ModelRecoveryCard>> = {},
  ) => renderToStaticMarkup(
    <I18nProvider>
      <ModelRecoveryCard
        embedded
        title="Choose a model to continue this subtask:"
        originalModelLabel="OpenCode Go / DeepSeek V4 Flash"
        providers={[]}
        selection={{ providerId: 'opencode-go', modelId: 'deepseek-v4-flash', variant: null }}
        pending={false}
        actionError={null}
        onSelectionChange={() => undefined}
        onRetry={() => undefined}
        autoResume={autoResume}
        onAutoResumeChange={() => undefined}
        now={() => 1_000_000}
        {...extra}
      />
    </I18nProvider>,
  );

  const scheduledAutoResume = {
    enabled: true,
    state: 'scheduled' as const,
    nextAttemptAt: 1_090_000,
    expiresAt: 5_000_000,
    attemptCount: 0,
    targetLabel: 'Anthropic / Claude Sonnet 5',
    resetAt: 1_080_000,
    lastError: null,
  };

  test('renders nothing new when auto-resume is not offered', () => {
    const html = renderAutoResume(undefined);

    expect(html).not.toContain('Auto-Resume');
    expect(html).not.toContain('role="checkbox"');
    expect(html).toContain('justify-end');
    expect(html).toContain('Try Again');
  });

  test('renders the auto-resume box checked with a countdown from the injected clock', () => {
    const html = renderAutoResume(scheduledAutoResume);

    expect(html).toContain('Auto-Resume When the Limit Lifts');
    expect(html).toContain('role="checkbox"');
    expect(html).toContain('aria-checked="true"');
    expect(html).toContain('Next attempt in 1m 30s on Anthropic / Claude Sonnet 5');
    expect(html).toContain('justify-between');
    expect(html.indexOf('Auto-Resume When the Limit Lifts')).toBeLessThan(html.indexOf('Try Again'));
    expect(html).not.toContain('role="alert"');
  });

  test('describes an attempt in flight and disables the box while a toggle is pending', () => {
    const html = renderAutoResume(
      { ...scheduledAutoResume, state: 'attempting', attemptCount: 1 },
      { autoResumePending: true },
    );

    expect(html).toContain('Attempting on Anthropic / Claude Sonnet 5…');
    expect(html).toContain('disabled=""');
    expect(html).not.toContain('Next attempt in');
  });

  test('explains why auto-resume stopped and shows the last error while still scheduled', () => {
    const exhausted = renderAutoResume({
      ...scheduledAutoResume,
      state: 'exhausted',
      lastError: { code: 'backup_rate_limited', message: 'Backup model also hit its limit', at: 999_000 },
    });
    expect(exhausted).toContain('Auto-resume stopped: Backup model also hit its limit');
    expect(exhausted).not.toContain('role="alert"');

    const errored = renderAutoResume({
      ...scheduledAutoResume,
      lastError: { code: 'attempt_failed', message: 'The backup attempt was rejected', at: 999_000 },
    });
    expect(errored).toContain('The backup attempt was rejected');
    expect(errored).toContain('role="alert"');
    expect(errored).toContain('Next attempt in 1m 30s');
  });

  test('renders the box unchecked and off once auto-resume is cancelled', () => {
    const html = renderAutoResume({
      ...scheduledAutoResume,
      enabled: false,
      state: 'cancelled',
      nextAttemptAt: null,
    });

    expect(html).toContain('aria-checked="false"');
    expect(html).toContain('Auto-resume off');
    expect(html).not.toContain('Next attempt in');
  });
});
