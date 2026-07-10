import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'bun:test';

const sessionDir = dirname(fileURLToPath(import.meta.url));
const readSource = (path: string) => readFileSync(resolve(sessionDir, path), 'utf8');

describe('thinking variant labels', () => {
  test('formats scheduled-task and todo-send thinking values for display', () => {
    const scheduledTaskEditor = readSource('ScheduledTaskEditorDialog.tsx');
    const todoSendDialog = readSource('TodoSendDialog.tsx');

    expect(scheduledTaskEditor).toContain("import { formatEffortLabel, isPrimaryMode } from '@/components/chat/mobileControlsUtils';");
    expect(scheduledTaskEditor).toContain(': formatEffortLabel(value)');
    expect(scheduledTaskEditor).toContain('{formatEffortLabel(variant)}');
    expect(todoSendDialog).toContain("import { formatEffortLabel, isPrimaryMode } from '@/components/chat/mobileControlsUtils';");
    expect(todoSendDialog).toContain('const label = resolvedValue ? formatEffortLabel(resolvedValue)');
    expect(todoSendDialog).toContain('{formatEffortLabel(option)}');
  });

  test('formats multirun thinking values without changing their wire keys', () => {
    const modelMultiSelect = readSource('../multirun/ModelMultiSelect.tsx');

    expect(modelMultiSelect).toContain("import { formatEffortLabel } from '@/components/chat/mobileControlsUtils';");
    expect(modelMultiSelect).toContain('{(value) => formatEffortLabel(value)}');
    expect(modelMultiSelect).toContain('{formatEffortLabel(variant)}');
  });

  test('formats message-header thinking values through the shared display-label helper', () => {
    const messageHeader = readSource('../chat/message/MessageHeader.tsx');

    expect(messageHeader).toContain("import { formatAgentLabel, formatEffortLabel } from '../mobileControlsUtils';");
    expect(messageHeader).toContain('const thinkingLabel = variant ? formatEffortLabel(variant) : undefined;');
  });
});
