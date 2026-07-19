import { describe, expect, test } from 'bun:test';
import {
  isAssistantStatusAnnouncementText,
  shouldRenderAssistantCopyButton,
  shouldRenderStandaloneAssistantActionsForTextGroup,
  shouldSuppressIntermediateAssistantStatusText,
} from './assistantInlineActions';

describe('shouldRenderStandaloneAssistantActionsForTextGroup', () => {
  test('keeps non-Cursor split assistant actions on the selected text group', () => {
    expect(shouldRenderStandaloneAssistantActionsForTextGroup({
      providerID: 'anthropic',
      shouldShowStandaloneMessageActions: true,
      messageId: 'assistant-1',
      groupStartIndex: 2,
      groupEndIndex: 3,
      lastRenderableTextPartIndex: 3,
      textPartIds: ['part-1'],
    })).toBe(true);
  });

  test('suppresses Cursor split actions on intermediate progress text', () => {
    expect(shouldRenderStandaloneAssistantActionsForTextGroup({
      providerID: 'cursor-acp',
      shouldShowStandaloneMessageActions: true,
      messageId: 'assistant-1',
      groupStartIndex: 0,
      groupEndIndex: 0,
      lastRenderableTextPartIndex: 0,
      textPartIds: ['progress-part'],
      summarySourceMessageId: 'assistant-2',
      summarySourcePartId: 'final-part',
    })).toBe(false);
  });

  test('allows Cursor split actions on the final summary text group', () => {
    expect(shouldRenderStandaloneAssistantActionsForTextGroup({
      providerID: 'cursor-acp',
      shouldShowStandaloneMessageActions: true,
      messageId: 'assistant-2',
      groupStartIndex: 1,
      groupEndIndex: 1,
      lastRenderableTextPartIndex: 1,
      textPartIds: ['final-part'],
      summarySourceMessageId: 'assistant-2',
      summarySourcePartId: 'final-part',
    })).toBe(true);
  });

  test('suppresses Cursor split actions on summary text that is followed by tool activity', () => {
    expect(shouldRenderStandaloneAssistantActionsForTextGroup({
      providerID: 'cursor-acp',
      shouldShowStandaloneMessageActions: true,
      messageId: 'assistant-2',
      groupStartIndex: 0,
      groupEndIndex: 0,
      lastRenderableTextPartIndex: 0,
      textPartIds: ['summary-part'],
      summarySourceMessageId: 'assistant-2',
      summarySourcePartId: 'summary-part',
      hasToolAfterTextGroup: true,
    })).toBe(false);
  });

  test('suppresses split actions on skill status announcement text', () => {
    expect(shouldRenderStandaloneAssistantActionsForTextGroup({
      providerID: 'anthropic',
      shouldShowStandaloneMessageActions: true,
      messageId: 'assistant-1',
      groupStartIndex: 0,
      groupEndIndex: 0,
      lastRenderableTextPartIndex: 0,
      textPartIds: ['skill-status-part'],
      text: 'Using Systematic Debugging to trace the profile form value mismatch.',
    })).toBe(false);

    expect(shouldRenderStandaloneAssistantActionsForTextGroup({
      providerID: 'anthropic',
      shouldShowStandaloneMessageActions: true,
      messageId: 'assistant-2',
      groupStartIndex: 0,
      groupEndIndex: 0,
      lastRenderableTextPartIndex: 0,
      textPartIds: ['skill-guidance-part'],
      text: 'Using Supabase guidance because this profile data likely comes through Supabase-backed APIs.',
    })).toBe(false);

    expect(shouldRenderStandaloneAssistantActionsForTextGroup({
      providerID: 'anthropic',
      shouldShowStandaloneMessageActions: true,
      messageId: 'assistant-3',
      groupStartIndex: 0,
      groupEndIndex: 0,
      lastRenderableTextPartIndex: 0,
      textPartIds: ['skill-announce-part'],
      text: "I'm using the writing-plans skill to create the implementation plan.",
    })).toBe(false);

    expect(shouldRenderStandaloneAssistantActionsForTextGroup({
      providerID: 'anthropic',
      shouldShowStandaloneMessageActions: true,
      messageId: 'assistant-4',
      groupStartIndex: 0,
      groupEndIndex: 0,
      lastRenderableTextPartIndex: 0,
      textPartIds: ['delegation-status-part'],
      text: 'Checking the relevant profile form code via @explorer.',
    })).toBe(false);
  });
});

describe('shouldSuppressIntermediateAssistantStatusText', () => {
  test('hides dispatch-status narration only for intermediate tool-call messages', () => {
    expect(isAssistantStatusAnnouncementText('Waiting on dispatch status')).toBe(true);
    expect(isAssistantStatusAnnouncementText('Waiting on the dispatch status...')).toBe(true);
    expect(isAssistantStatusAnnouncementText('Waiting for subagent output')).toBe(false);
    expect(isAssistantStatusAnnouncementText('Waiting on dispatch status can reveal scheduler latency.')).toBe(false);

    expect(shouldSuppressIntermediateAssistantStatusText({
      messageFinish: 'tool-calls',
      hasToolParts: true,
      text: 'Waiting on dispatch status',
    })).toBe(true);

    expect(shouldSuppressIntermediateAssistantStatusText({
      messageFinish: 'stop',
      hasToolParts: true,
      text: 'Waiting on dispatch status',
    })).toBe(false);

    expect(shouldSuppressIntermediateAssistantStatusText({
      messageFinish: 'tool-calls',
      hasToolParts: false,
      text: 'Waiting on dispatch status',
    })).toBe(false);
  });

  test('hides skill and subagent narration in intermediate tool-call messages', () => {
    expect(shouldSuppressIntermediateAssistantStatusText({
      messageFinish: 'tool-calls',
      hasToolParts: true,
      text: "I'm using the writing-plans skill to create the implementation plan.",
    })).toBe(true);

    expect(shouldSuppressIntermediateAssistantStatusText({
      messageFinish: 'tool-calls',
      hasToolParts: true,
      text: 'Checking the relevant profile form code via @explorer.',
    })).toBe(true);
  });

  test('keeps final answer text and text-only messages visible', () => {
    expect(shouldSuppressIntermediateAssistantStatusText({
      messageFinish: 'stop',
      hasToolParts: true,
      text: 'Checking the relevant profile form code via @explorer.',
    })).toBe(false);

    expect(shouldSuppressIntermediateAssistantStatusText({
      messageFinish: 'tool-calls',
      hasToolParts: false,
      text: "I'm using the writing-plans skill to create the implementation plan.",
    })).toBe(false);

    expect(shouldSuppressIntermediateAssistantStatusText({
      messageFinish: 'tool-calls',
      hasToolParts: true,
      text: 'The profile form dirty state is caused by programmatic setValue calls after reset.',
    })).toBe(false);
  });
});

describe('shouldRenderAssistantCopyButton', () => {
  test('does not render a lone copy action when no assistant text is copyable', () => {
    expect(shouldRenderAssistantCopyButton({
      hasCopyableText: false,
      onCopyMessageConfigured: true,
    })).toBe(false);
  });

  test('renders only when both copy text and copy handler are available', () => {
    expect(shouldRenderAssistantCopyButton({
      hasCopyableText: true,
      onCopyMessageConfigured: false,
    })).toBe(false);
    expect(shouldRenderAssistantCopyButton({
      hasCopyableText: true,
      onCopyMessageConfigured: true,
    })).toBe(true);
  });
});
