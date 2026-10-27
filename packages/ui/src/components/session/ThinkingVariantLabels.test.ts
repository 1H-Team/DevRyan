import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'bun:test';
import { resolveAgentVariantForSave } from '../sections/agents/agentVariantSelection';
import { getChatThinkingState } from '@/lib/providers/chatThinking';

const sessionDir = dirname(fileURLToPath(import.meta.url));
const readSource = (path: string) => readFileSync(resolve(sessionDir, path), 'utf8');

describe('thinking variant labels', () => {
  test('formats scheduled-task thinking values for display', () => {
    const scheduledTaskEditor = readSource('ScheduledTaskEditorDialog.tsx');

    expect(scheduledTaskEditor).toContain("import { formatEffortLabel, isPrimaryMode } from '@/components/chat/mobileControlsUtils';");
    expect(scheduledTaskEditor).toContain(': formatEffortLabel(value, { providerId: draft.execution.providerID })');
    expect(scheduledTaskEditor).toContain('{formatEffortLabel(variant, { providerId: draft.execution.providerID })}');
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

  test('passes provider context through model controls and agent settings', () => {
    const modelControls = readSource('../chat/ModelControls.tsx');
    const agentsPage = readSource('../sections/agents/AgentsPage.tsx');
    const controlledPicker = readSource('../chat/ControlledModelPicker.tsx');

    expect(modelControls).toContain('getChatThinkingState(provider, modelId, resolvedVariant)');
    expect(modelControls).toContain('formatEffortLabel(chatLevel, { providerId })');
    // Agent settings use the chat picker, which labels levels with the row's provider.
    expect(agentsPage).toContain('<ControlledModelPicker');
    expect(controlledPicker).toContain('formatEffortLabel(activeLevel, { providerId: value.providerId })');
  });

  test('agent settings show the concrete level for an unsaved agent instead of a Default option', () => {
    const agentsPage = readSource('../sections/agents/AgentsPage.tsx');
    const provider = {
      id: 'openai',
      models: [{ id: 'qa-model', variants: { low: {}, high: {} } }],
    };

    expect(agentsPage).not.toMatch(/<SelectItem value=\{NO_VARIANT_VALUE\}>/);
    expect(agentsPage).not.toContain('Provider Default');
    expect(agentsPage).toContain('<ControlledModelPicker');
    // The chat picker resolves an unsaved level to a concrete catalog level.
    expect(getChatThinkingState(provider, 'qa-model', null).selected).toBe('low');
    // Showing the level does not save one: an unsaved agent stays unsaved.
    expect(resolveAgentVariantForSave(provider, 'openai/qa-model', undefined)).toBeUndefined();
  });
});
