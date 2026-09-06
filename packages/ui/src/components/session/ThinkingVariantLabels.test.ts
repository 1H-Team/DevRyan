import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'bun:test';
import { formatEffortLabel } from '../chat/mobileControlsUtils';
import { resolveAgentVariantForSave } from '../sections/agents/agentVariantSelection';

const sessionDir = dirname(fileURLToPath(import.meta.url));
const readSource = (path: string) => readFileSync(resolve(sessionDir, path), 'utf8');

describe('thinking variant labels', () => {
  test('formats scheduled-task and todo-send thinking values for display', () => {
    const scheduledTaskEditor = readSource('ScheduledTaskEditorDialog.tsx');
    const todoSendDialog = readSource('TodoSendDialog.tsx');

    expect(scheduledTaskEditor).toContain("import { formatEffortLabel, isPrimaryMode } from '@/components/chat/mobileControlsUtils';");
    expect(scheduledTaskEditor).toContain(': formatEffortLabel(value, { providerId: draft.execution.providerID })');
    expect(scheduledTaskEditor).toContain('{formatEffortLabel(variant, { providerId: draft.execution.providerID })}');
    expect(todoSendDialog).toContain("import { formatEffortLabel, isPrimaryMode } from '@/components/chat/mobileControlsUtils';");
    expect(todoSendDialog).toContain('const label = resolvedValue ? formatEffortLabel(resolvedValue, { providerId })');
    expect(todoSendDialog).toContain('{formatEffortLabel(option, { providerId })}');
  });

  test('formats multirun thinking values without changing their wire keys', () => {
    const modelMultiSelect = readSource('../multirun/ModelMultiSelect.tsx');

    expect(modelMultiSelect).toContain("import { formatEffortLabel } from '@/components/chat/mobileControlsUtils';");
    expect(modelMultiSelect).toContain('{(value) => formatEffortLabel(value, { providerId: model.providerID })}');
    expect(modelMultiSelect).toContain('{formatEffortLabel(variant, { providerId: model.providerID })}');
  });

  test('formats message-header thinking values through the shared display-label helper', () => {
    const messageHeader = readSource('../chat/message/MessageHeader.tsx');

    expect(messageHeader).toContain("import { formatAgentLabel, formatEffortLabel } from '../mobileControlsUtils';");
    expect(messageHeader).toContain('const thinkingLabel = variant ? formatEffortLabel(variant, { providerId: providerID }) : undefined;');
  });

  test('passes provider context through model controls, status chips, and agent settings', () => {
    const modelControls = readSource('../chat/ModelControls.tsx');
    const statusChip = readSource('../chat/StatusChip.tsx');
    const agentsPage = readSource('../sections/agents/AgentsPage.tsx');

    expect(modelControls).toContain('getCursorAcpVariantDisplayLabel(cursorVariantState, { providerId })');
    expect(modelControls).toContain('{formatEffortLabel(variantOption, { providerId })}');
    expect(statusChip).toContain('{ providerId: currentProvider?.id }');
    expect(agentsPage).toContain('{ providerId: parsedRowModel?.providerId }');
  });

  test('offers provider Default in agent settings without inventing a thinking level', () => {
    const agentsPage = readSource('../sections/agents/AgentsPage.tsx');
    const defaultOption = agentsPage.match(/<SelectItem value=\{NO_VARIANT_VALUE\}>(.*?)<\/SelectItem>/)?.[1];
    const provider = {
      id: 'openai',
      models: [{ id: 'qa-model', variants: { low: {}, high: {} } }],
    };

    expect(defaultOption).toBe('{formatEffortLabel(undefined)}');
    expect(formatEffortLabel(undefined)).toBe('Default');
    expect(resolveAgentVariantForSave(provider, 'openai/qa-model', undefined)).toBeUndefined();
  });
});
