import { describe, expect, test } from 'bun:test';

import {
  resolveStatusRowAssistantDisplay,
  shouldRenderStatusRowAssistantStatus,
} from './StatusRowContainer';

describe('shouldRenderStatusRowAssistantStatus', () => {
  test('suppresses the status row while reasoning owns the visible Thinking indicator', () => {
    expect(shouldRenderStatusRowAssistantStatus('reasoning', true)).toBe(false);
  });

  test('keeps the waiting row visible when a managed barrier owns live reasoning', () => {
    expect(shouldRenderStatusRowAssistantStatus('reasoning', true, true)).toBe(true);
  });

  test('keeps non-reasoning working states visible in the status row', () => {
    expect(shouldRenderStatusRowAssistantStatus('text', true)).toBe(true);
    expect(shouldRenderStatusRowAssistantStatus('tool', true)).toBe(true);
    expect(shouldRenderStatusRowAssistantStatus('editing', true)).toBe(true);
  });

  test('does not render the status row assistant placeholder while idle', () => {
    expect(shouldRenderStatusRowAssistantStatus(undefined, false)).toBe(false);
    expect(shouldRenderStatusRowAssistantStatus('text', false)).toBe(false);
  });
});

describe('resolveStatusRowAssistantDisplay', () => {
  test('shows the localized non-blocking revert status ahead of normal assistant activity', () => {
    expect(resolveStatusRowAssistantDisplay({
      isRevertPending: true,
      revertingText: 'Reverting chat…',
      showWorkingPlaceholder: true,
      assistantStatusText: 'Editing files',
      assistantIsGenericStatus: true,
    })).toEqual({
      isWorking: true,
      statusText: 'Reverting chat…',
      isGenericStatus: false,
    });
  });

  test('preserves normal working and idle status behavior when no revert is pending', () => {
    expect(resolveStatusRowAssistantDisplay({
      isRevertPending: false,
      revertingText: 'Reverting chat…',
      showWorkingPlaceholder: true,
      assistantStatusText: 'Running tests',
      assistantIsGenericStatus: true,
    })).toEqual({
      isWorking: true,
      statusText: 'Running tests',
      isGenericStatus: true,
    });
    expect(resolveStatusRowAssistantDisplay({
      isRevertPending: false,
      revertingText: 'Reverting chat…',
      showWorkingPlaceholder: false,
      assistantStatusText: null,
      assistantIsGenericStatus: false,
    })).toEqual({
      isWorking: false,
      statusText: null,
      isGenericStatus: false,
    });
  });
});
