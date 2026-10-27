import React, { act } from 'react';
import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';

import { withDom, type HostElement } from '@/test/mountedDom';
import { I18nProvider, useI18n } from '@/lib/i18n';
import { CommitSection } from './CommitSection';

type Props = React.ComponentProps<typeof CommitSection>;
const calls: string[] = [];
const baseProps = (overrides: Partial<Props> = {}): Props => ({
  selectedCount: 2,
  commitMessage: '',
  onCommitMessageChange: () => {},
  onCommit: () => { calls.push('commit'); },
  onCommitAmend: () => { calls.push('amend'); },
  onCommitAndPush: () => { calls.push('push'); },
  onCommitAndSync: () => { calls.push('sync'); },
  onGenerateCommitMessage: () => { calls.push('generate'); },
  commitAction: null,
  isGeneratingCommitMessage: false,
  commitGenerationDisabled: false,
  gitmojiEnabled: false,
  onOpenGitmojiPicker: () => {},
  syncAction: null,
  remotes: [],
  onSync: () => {},
  syncDisabled: false,
  ...overrides,
});

const markup = (overrides: Partial<Props> = {}) => renderToStaticMarkup(
  <I18nProvider><CommitSection {...baseProps(overrides)} /></I18nProvider>,
);

// Resolve labels through the real translator so the tests do not pin English copy.
let translate: ReturnType<typeof useI18n>['t'] = (key) => key;
const Capture = () => { translate = useI18n().t; return null; };
renderToStaticMarkup(<I18nProvider><Capture /></I18nProvider>);

const isDisabled = (tag: string): boolean => /\sdisabled(=|\s|>)/.test(tag);

const buttonTag = (html: string, label: string): string => {
  const tags = html.match(/<button[^>]*>/g) ?? [];
  const tag = tags.find((candidate) => candidate.includes(`aria-label="${label}"`));
  expect(tag).toBeDefined();
  return tag!;
};

const mount = async (props: Props, run: (container: HostElement) => Promise<void>) => withDom(async (container) => {
  const { createRoot } = await import('react-dom/client');
  Object.assign(globalThis.window, { location: { search: '' } });
  Object.assign(globalThis.document.documentElement, { classList: { add() {}, remove() {}, toggle() {} } });
  const root = createRoot(container as unknown as Element);
  try {
    await act(async () => { root.render(<I18nProvider><CommitSection {...props} /></I18nProvider>); });
    await run(container);
  } finally { await act(async () => root.unmount()); }
});

describe('CommitSection primary action', () => {
  test('keeps the primary button dedicated to plain commit', async () => {
    calls.length = 0;
    await mount(baseProps(), async (container) => {
      const primary = container.find((node) => node.tagName === 'BUTTON' && node.getAttribute('aria-label') === translate('gitView.commit.commitAria'));
      expect(primary).not.toBeNull();
      await act(async () => primary!.click());
    });
    expect(calls).toEqual(['commit']);
  });

  test('renders commit generation as a separate trailing action that only generates', async () => {
    calls.length = 0;
    await mount(baseProps(), async (container) => {
      const generate = container.find((node) => node.tagName === 'BUTTON' && node.getAttribute('aria-label') === translate('gitView.commit.generateAria'));
      expect(generate).not.toBeNull();
      await act(async () => generate!.click());
    });
    expect(calls).toEqual(['generate']);
    expect(translate('gitView.commit.generateAria')).not.toBe(translate('gitView.commit.commitAria'));
  });

  test('commit controls stay clickable when changes exist without requiring a message', () => {
    const html = markup({ selectedCount: 1, commitMessage: '' });
    expect(isDisabled(buttonTag(html, translate('gitView.commit.commitAria')))).toBe(false);
    expect(isDisabled(buttonTag(html, translate('gitView.commit.moreActionsAria')))).toBe(false);
  });

  test('disables commit controls with nothing selected or while an action runs', () => {
    for (const overrides of [{ selectedCount: 0 }, { commitAction: 'commit' as const }]) {
      const html = markup(overrides);
      expect(isDisabled(buttonTag(html, translate('gitView.commit.commitAria')))).toBe(true);
      expect(isDisabled(buttonTag(html, translate('gitView.commit.moreActionsAria')))).toBe(true);
    }
  });

  test('does not show a staged-changes hint above the commit input', () => {
    expect(markup({ selectedCount: 0 })).not.toContain(translate('gitView.commit.selectFilesHint'));
  });
});
