import React from 'react';
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { renderToString } from 'react-dom/server';
import { fileURLToPath } from 'node:url';

import { DeferredChatDialog } from './lazyChatDialogs';

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

  test('declares recovery-aware lazy imports for unopened chat dialogs', () => {
    const source = readSource('lazyChatDialogs.tsx');

    expect(source).toContain("import { lazyWithChunkRecovery } from '@/lib/chunkLoadRecovery'");
    expect(source).toContain("import('@/components/session/GitHubIssuePickerDialog')");
    expect(source).toContain("import('@/components/session/GitHubPrPickerDialog')");
    expect(source).toContain("import('@/components/views/git/StashDialog')");
    expect(source).toContain("import('@/components/chat/TimelineDialog')");
    expect(source).toContain("import('@/components/chat/AgentHandoffDialog')");

    for (const dialogName of ['GitHubIssuePickerDialog', 'GitHubPrPickerDialog', 'StashDialog', 'TimelineDialog', 'AgentHandoffDialog']) {
      expect(source).toContain(`export const Lazy${dialogName} = /* @__PURE__ */ lazyWithChunkRecovery`);
    }
  });

  test('mounts each composer dialog only for its authoritative local state', () => {
    const source = readSource('ChatInput.tsx');

    expect(source).not.toContain("import { GitHubIssuePickerDialog } from '@/components/session/GitHubIssuePickerDialog'");
    expect(source).not.toContain("import { GitHubPrPickerDialog } from '@/components/session/GitHubPrPickerDialog'");
    expect(source).not.toContain("import { StashDialog } from '@/components/views/git/StashDialog'");
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

    expect(source).not.toContain("import { TimelineDialog } from './TimelineDialog'");
    expect(source).toContain("from './lazyChatDialogs'");
    expect(source).toContain('active={isTimelineDialogOpen}');
    expect(source).toContain('open={isTimelineDialogOpen}');
    expect(source).toContain('onOpenChange={setTimelineDialogOpen}');
  });

  test('mounts the agent handoff dialog only while coordinator state is open', () => {
    const source = readSource('AgentHandoffGuard.tsx');

    expect(source).not.toContain("import { AgentHandoffDialog } from './AgentHandoffDialog'");
    expect(source).toContain("from './lazyChatDialogs'");
    expect(source).toContain('active={state.open}');
    expect(source).toContain('<LazyAgentHandoffDialog');
    expect(source).toContain('onCancel={() => { coordinator.cancel(); }}');
    expect(source).toContain('onConfirm={() => { void coordinator.confirm(); }}');
    expect(source).toContain('onRetry={() => { void coordinator.retry(); }}');
  });

  test('mounts tool-output dialogs only while open and preserves both shared warmup callers', () => {
    const chatMessage = readSource('ChatMessage.tsx');
    const fileAttachment = readSource('FileAttachment.tsx');
    const warmup = readSource('../../lib/startup/chat-runtime-warmup.ts');
    const webApp = readSource('../../App.tsx');
    const vscodeApp = readSource('../../apps/VSCodeApp.tsx');

    expect(chatMessage).toContain('popupContent.open ? (');
    expect((fileAttachment.match(/popupContent\.open \? \(/g) ?? []).length).toBe(2);
    expect(warmup).toContain("import('@/components/chat/MarkdownRendererImpl')");
    expect(warmup).toContain("import('@/components/chat/message/ToolOutputDialog')");
    expect(webApp).toContain('void warmChatRuntime()');
    expect(vscodeApp).toContain('void warmChatRuntime()');
  });
});
