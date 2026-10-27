import React from 'react';
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { renderToString } from 'react-dom/server';
import { fileURLToPath } from 'node:url';

import {
  DeferredChatDialog,
  LazyAgentHandoffDialog,
  LazyGitHubIssuePickerDialog,
  LazyGitHubPrPickerDialog,
  LazyStashDialog,
  LazyTimelineDialog,
} from './lazyChatDialogs';

const testDir = dirname(fileURLToPath(import.meta.url));

const readSource = (relativePath: string): string => {
  try {
    return readFileSync(resolve(testDir, relativePath), 'utf8');
  } catch {
    return '';
  }
};

describe('lazy chat dialogs', () => {
  test('does not initialize a lazy dialog until its authoritative state is active', () => {
    let loadCount = 0;
    const LazyProbe = React.lazy(async () => {
      loadCount += 1;
      return { default: () => <span>loaded</span> };
    });

    const renderProbe = (active: boolean) => renderToString(
      <React.Suspense fallback={<span>loading</span>}>
        <DeferredChatDialog active={active}>
          <LazyProbe />
        </DeferredChatDialog>
      </React.Suspense>,
    );

    expect(renderProbe(false)).not.toContain('loading');
    expect(loadCount).toBe(0);

    expect(renderProbe(true)).toContain('loading');
    expect(loadCount).toBe(1);

    expect(renderProbe(false)).not.toContain('loading');
    expect(loadCount).toBe(1);
  });

  test('declares lazy components for every unopened chat dialog', () => {
    // Import paths are verified by the type-checker (dynamic import of a missing module fails tsc);
    // the chunk-recovery wrapper must still yield a React.lazy element type.
    const lazyExports = {
      LazyGitHubIssuePickerDialog,
      LazyGitHubPrPickerDialog,
      LazyStashDialog,
      LazyTimelineDialog,
      LazyAgentHandoffDialog,
    };

    for (const [name, component] of Object.entries(lazyExports)) {
      expect({ name, type: (component as { $$typeof?: symbol }).$$typeof }).toEqual({
        name,
        type: Symbol.for('react.lazy'),
      });
    }
  });

  test('mounts each composer dialog only for its authoritative local state', () => {
    const source = readSource('ChatInput.tsx');

    expect(source).toContain("from './lazyChatDialogs'");

    expect(source).toContain('active={issuePickerOpen}');
    expect(source).toContain('active={prPickerOpen}');
    expect(source).toContain('active={draftCheckoutDialog !== null}');
    expect(source).toContain('onOpenChange={setIssuePickerOpen}');
    expect(source).toContain('onOpenChange={setPrPickerOpen}');
    expect(source).toContain('setDraftCheckoutDialog(null)');
  });

  test('mounts the timeline dialog only while the shared open state is active', () => {
    const source = readSource('ChatContainer.tsx');

    expect(source).toContain("from './lazyChatDialogs'");
    expect(source).toContain('active={isTimelineDialogOpen}');
    expect(source).toContain('open={isTimelineDialogOpen}');
    expect(source).toContain('onOpenChange={setTimelineDialogOpen}');
  });

  test('mounts the agent handoff dialog only while coordinator state is open', () => {
    const source = readSource('AgentHandoffGuard.tsx');

    expect(source).toContain("from './lazyChatDialogs'");
    expect(source).toContain('active={state.open}');
    expect(source).toContain('<LazyAgentHandoffDialog');
    expect(source).toContain('onCancel={() => { coordinator.cancel(); }}');
    expect(source).toContain('onConfirm={() => { void coordinator.confirm(); }}');
    expect(source).toContain('onRetry={() => { void coordinator.retry(); }}');
  });

  test('mounts tool-output dialogs only while open and preserves shared warmup', () => {
    const chatMessage = readSource('ChatMessage.tsx');
    const fileAttachment = readSource('FileAttachment.tsx');
    const warmup = readSource('../../lib/startup/chat-runtime-warmup.ts');
    const webApp = readSource('../../App.tsx');

    expect(chatMessage).toContain('popupContent.open ? (');
    expect((fileAttachment.match(/popupContent\.open \? \(/g) ?? []).length).toBe(1);
    expect(warmup).toContain("import('@/components/chat/MarkdownRendererImpl')");
    expect(warmup).toContain("import('@/components/chat/message/ToolOutputDialog')");
    expect(webApp).toContain('void warmChatRuntime()');
  });
});
