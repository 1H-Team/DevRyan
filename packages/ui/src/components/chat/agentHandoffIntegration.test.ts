import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const read = (name: string) => readFileSync(fileURLToPath(new URL(name, import.meta.url)), 'utf8');

describe('agent handoff guard integration', () => {
  test('wraps chat and routes shared desktop, mobile, keyboard, and send paths through the guard', () => {
    const chatView = read('../views/ChatView.tsx');
    const modelControls = read('./ModelControls.tsx');
    const chatInput = read('./ChatInput.tsx');
    const autoSend = read('../../hooks/useQueuedMessageAutoSend.ts');

    expect(chatView).toContain('<AgentHandoffGuardProvider>');
    expect(modelControls).toContain('requestAgentChange({');
    expect(modelControls).toContain('handleCycleAgentFromModelPicker');
    expect(chatInput).toContain('requestAgentChange({');
    expect(chatInput).toContain('await guardBuilderSend(');
    expect(chatInput).toContain('authorizeSend: guardBuilderSend');
    expect(chatInput).toContain('handleCycleAgent();');
    expect(autoSend).toContain('authorizeSend: guardQueuedBuilderSend');
  });
});
