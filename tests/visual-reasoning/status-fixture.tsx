import React from 'react';
import type { AssistantMessage, Message, Part } from '@opencode-ai/sdk/v2';
import { useI18n } from '@/lib/i18n';
import { selectAssistantStatusRecord, getAssistantActivePartStatus } from '@/hooks/useAssistantStatus';
import { resolveManagedDelegationStatusPhase } from '@/components/chat/StatusRowContainer';
import { WorkingPlaceholder } from '@/components/chat/message/parts/WorkingPlaceholder';

const user = (id: string, created: number): Message => ({
    id, role: 'user', sessionID: 'fixture', time: { created },
    agent: 'builder', model: { providerID: 'fixture', modelID: 'fixture' },
});
const assistant: AssistantMessage = {
    id: 'old-assistant', role: 'assistant', sessionID: 'fixture', parentID: 'old-user',
    time: { created: 2 }, modelID: 'fixture', providerID: 'fixture', mode: 'primary', agent: 'builder',
    path: { cwd: '/fixture', root: '/fixture' }, cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
};
const wait: Part = {
    id: 'wait', messageID: assistant.id, sessionID: 'fixture', type: 'tool', tool: 'devryan_task', callID: 'wait-call',
    state: { status: 'running', input: { action: 'wait' }, time: { start: 2 }, title: 'Wait', metadata: {} },
};
const stages = ['old-wait', 'send', 'empty-assistant', 'running', 'completed', 'loading-wait', 'confirmed-empty'] as const;
type Stage = typeof stages[number];

/** Real status selection and label component; all lifecycle input is disposable. */
export function StatusFixture() {
    const { t } = useI18n();
    const [stage, setStage] = React.useState<Stage>('old-wait');
    const currentPromptId = stage === 'old-wait' ? 'old-user' : 'new-user';
    const records: { info: Message; parts: Part[] }[] = [
        { info: user('old-user', 1), parts: [] }, { info: assistant, parts: [wait] },
    ];
    if (stage !== 'old-wait') records.push({ info: user('new-user', 3), parts: [] });
    if (stage === 'empty-assistant' || stage === 'loading-wait' || stage === 'confirmed-empty') {
        records.push({
            info: { ...assistant, id: 'new-assistant', parentID: 'new-user', time: { created: 4 } },
            parts: stage === 'empty-assistant' ? [] : [{ ...wait, messageID: 'new-assistant' }],
        });
    }
    const selected = selectAssistantStatusRecord(records);
    const active = getAssistantActivePartStatus(selected?.parts);
    const phase = resolveManagedDelegationStatusPhase({
        rootPhase: stage === 'running' ? 'waiting' : null,
        activeToolName: active.activeToolName,
        activeToolAction: active.activeToolAction,
        isLoadingSnapshot: stage === 'loading-wait' || stage === 'old-wait',
        hasConfirmedSnapshot: stage !== 'loading-wait' && stage !== 'old-wait',
    });
    const statusText = phase === 'waiting' ? t('chat.statusRow.managedTasks.waiting')
        : phase === 'starting' ? t('chat.statusRow.managedTasks.starting')
            : phase === 'managing' ? t('chat.statusRow.managedTasks.managing') : 'Working';
    return <main>
        <h1>Prompt status transition</h1>
        <p>Production status selector and animated label with synthetic events. No runtime requests.</p>
        <nav aria-label="Status controls">{stages.map((value) => <button key={value} onClick={() => setStage(value)}>{value}</button>)}</nav>
        <section aria-label="Live status" style={{ minHeight: 64, padding: 16 }}>
            <WorkingPlaceholder key={`${currentPromptId}:${phase ?? ''}`} isWorking statusText={statusText} isGenericStatus={phase === null} />
        </section>
        <output data-stage={stage}>{stage}</output>
    </main>;
}
