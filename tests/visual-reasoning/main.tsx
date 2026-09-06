import React from 'react';
import { createRoot } from 'react-dom/client';
import type { Part } from '@opencode-ai/sdk/v2';
import { I18nProvider } from '@/lib/i18n';
import { RuntimeAPIProvider } from '@/contexts/RuntimeAPIProvider';
import { useUIStore } from '@/stores/useUIStore';
import ReasoningGroup from '@/components/chat/message/parts/ReasoningGroup';
import { useHasActiveReasoningDisclosure } from '@/components/chat/message/parts/reasoningDisclosureStatus';
import { createWebAPIs } from '../../packages/web/src/api';
import '../../packages/ui/src/index.css';
import './style.css';

const stages = ['empty', 'whitespace', 'first', 'second', 'gap', 'complete', 'cancel', 'empty-cancel'] as const;
type Stage = typeof stages[number];
const isStage = (value: unknown): value is Stage => stages.some((stage) => stage === value);
const stageKey = 'devryan.reasoning-fixture-stage';
const part = (id: string, text: string, end?: number): Part => ({
    type: 'reasoning', id, messageID: 'msg_fixture', sessionID: 'ses_fixture', text,
    time: end === undefined ? { start: 1_000 } : { start: 1_000, end },
});

declare global {
    interface Window {
        __reasoningFixture?: {
            setStage: (stage: Stage) => void;
            setMode: (mode: 'live' | 'sorted') => void;
            setTheme: (theme: 'light' | 'dark') => void;
        };
    }
}

export function Fixture() {
    const [stage, setStage] = React.useState<Stage>(() => {
        const saved = localStorage.getItem(stageKey);
        return isStage(saved) ? saved : 'empty';
    });
    const ownsStatus = useHasActiveReasoningDisclosure('ses_fixture');
    const mode = useUIStore((state) => state.chatRenderMode);
    const completed = stage === 'complete' || stage === 'cancel' || stage === 'empty-cancel';
    const hasSecond = ['second', 'gap', 'complete', 'cancel'].includes(stage);
    const empty = stage === 'empty' || stage === 'empty-cancel';
    const ended = stage === 'gap' || stage === 'complete';
    const first = part('reasoning-one', empty ? '' : stage === 'whitespace' ? ' \n\t ' : '**First observation**\n\nThe local edit must survive the change.', hasSecond || ended ? 20_000 : undefined);
    const parts = hasSecond
        ? [first, part('reasoning-two', '**Second observation**\n\nVerify the ordered update before declaring completion.', ended ? 40_000 : undefined)]
        : [first];

    React.useEffect(() => { localStorage.setItem(stageKey, stage); }, [stage]);
    React.useEffect(() => {
        window.__reasoningFixture = {
            setStage,
            setMode: (chatRenderMode) => useUIStore.setState({ chatRenderMode }),
            setTheme: (theme) => document.documentElement.classList.toggle('dark', theme === 'dark'),
        };
        return () => { delete window.__reasoningFixture; };
    }, []);

    return <main>
        <h1>Reasoning presentation</h1>
        <p className="fixture-description">Real chat components; synthetic provider events.</p>
        <nav aria-label="Fixture controls">
            {stages.map((value) => <button key={value} onClick={() => setStage(value)}>{value}</button>)}
        </nav>
        <section aria-label="Chat transcript" className="fixture-transcript">
            <p>Inspect the update ordering and preserve the existing edit.</p>
            <div id="reasoning-target">
                <ReasoningGroup entries={parts.map((value) => ({ part: value, messageId: 'msg_fixture' }))}
                    providerID="anthropic" isMessageCompleted={completed} isTrailingLiveRun={!completed} />
            </div>
            {completed && <p data-final-response="true">Verification finished. Existing edits remain intact.</p>}
        </section>
        <textarea aria-label="Composer" placeholder="Send a follow-up" />
        <output data-stage={stage} data-owned-status={String(ownsStatus)}>{stage} · {mode}</output>
    </main>;
}

createRoot(document.getElementById('root')!).render(
    <RuntimeAPIProvider apis={createWebAPIs()}><I18nProvider><Fixture /></I18nProvider></RuntimeAPIProvider>,
);
