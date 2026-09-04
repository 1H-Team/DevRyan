import { beforeEach, describe, expect, test } from 'bun:test';
import type { Agent, Model, Provider } from '@opencode-ai/sdk/v2';
import { applyDraftAwareAgentChange, applyDraftAwareModelChange, persistCycledThinkingVariant } from './draftAwareAgentChange';
import { useConfigStore } from '@/stores/useConfigStore';
import { useSelectionStore } from '@/sync/selection-store';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { resolveCurrentDraftSendConfig } from '@/sync/send-config';

type TestProvider = Omit<Provider, 'models'> & { models: Model[] };

const createModel = (providerID: string, id: string, variants?: Model['variants']): Model => ({
    id,
    providerID,
    api: { id: providerID, url: 'https://example.test', npm: providerID },
    name: id,
    capabilities: {
        temperature: true,
        reasoning: true,
        attachment: false,
        toolcall: true,
        input: { text: true, audio: false, image: false, video: false, pdf: false },
        output: { text: true, audio: false, image: false, video: false, pdf: false },
        interleaved: false,
    },
    cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
    limit: { context: 1000, output: 1000 },
    status: 'active',
    options: {},
    headers: {},
    release_date: '2026-01-01',
    variants,
});

const providers: TestProvider[] = [
    {
        id: 'opencode',
        name: 'OpenCode',
        source: 'custom',
        options: {},
        env: [],
        models: [
            createModel('opencode', 'small'),
            createModel('opencode', 'builder-model', { high: {} }),
        ],
    },
    {
        id: 'anthropic',
        name: 'Anthropic',
        source: 'custom',
        options: {},
        env: [],
        models: [createModel('anthropic', 'claude')],
    },
];

const agents: Agent[] = [
    {
        name: 'Orchestrator',
        mode: 'primary',
        model: { providerID: 'opencode', modelID: 'small' },
        permission: [],
        options: {},
    },
    {
        name: 'Builder',
        mode: 'primary',
        model: { providerID: 'opencode', modelID: 'builder-model' },
        variant: 'high',
        permission: [],
        options: {},
    },
];

const DRAFT_ID = 'draft-cycle';

function selectionActions() {
    const selection = useSelectionStore.getState();
    return {
        setAgent: useConfigStore.getState().setAgent,
        setProviderModel: useConfigStore.getState().setProviderModel,
        saveSessionAgentSelection: selection.saveSessionAgentSelection,
        getDraftAgentModelForSelection: selection.getDraftAgentModelForSelection,
        getDraftAgentModelVariantForSelection: selection.getDraftAgentModelVariantForSelection,
        saveDraftAgentSelection: selection.saveDraftAgentSelection,
        saveDraftModelSelection: selection.saveDraftModelSelection,
        saveDraftAgentModelForSelection: selection.saveDraftAgentModelForSelection,
        saveDraftAgentModelVariantForSelection: selection.saveDraftAgentModelVariantForSelection,
        saveDraftSendConfig: (_draftId: string, sendConfig: Parameters<NonNullable<Parameters<typeof applyDraftAwareAgentChange>[2]['saveDraftSendConfig']>>[1]) => {
            useSessionUIStore.getState().updateNewSessionDraftSendConfig(sendConfig);
        },
    };
}

function modelSelectionActions() {
    const selection = useSelectionStore.getState();
    return {
        setProviderModel: useConfigStore.getState().setProviderModel,
        saveSessionModelSelection: selection.saveSessionModelSelection,
        saveAgentModelForSession: selection.saveAgentModelForSession,
        saveAgentModelVariantForSession: selection.saveAgentModelVariantForSession,
        saveDraftModelSelection: selection.saveDraftModelSelection,
        saveDraftAgentModelForSelection: selection.saveDraftAgentModelForSelection,
        saveDraftAgentModelVariantForSelection: selection.saveDraftAgentModelVariantForSelection,
        saveDraftSendConfig: (_draftId: string, sendConfig: Parameters<NonNullable<Parameters<typeof applyDraftAwareModelChange>[3]['saveDraftSendConfig']>>[1]) => {
            useSessionUIStore.getState().updateNewSessionDraftSendConfig(sendConfig);
        },
    };
}

describe('applyDraftAwareAgentChange', () => {
    beforeEach(() => {
        useSessionUIStore.setState({
            currentSessionId: null,
            currentDraftId: DRAFT_ID,
            draftsById: {
                [DRAFT_ID]: {
                    id: DRAFT_ID,
                    text: '',
                    createdAt: 1,
                    updatedAt: 1,
                    selectedProjectId: null,
                    directoryOverride: '/repo',
                    parentID: null,
                },
            },
            draftOrder: [DRAFT_ID],
            newSessionDraft: { open: true, id: DRAFT_ID, directoryOverride: '/repo', parentID: null },
        });
        useSelectionStore.setState({
            sessionModelSelections: new Map(),
            sessionAgentSelections: new Map(),
            sessionPlanModeSelections: new Map(),
            defaultPlanModeSelection: false,
            draftPlanModeSelections: new Map(),
            sessionAgentModelSelections: new Map(),
            draftModelSelections: new Map(),
            draftAgentSelections: new Map(),
            draftAgentModelSelections: new Map(),
            draftAgentModelVariantSelections: new Map(),
            lastUsedProvider: null,
        });
        useConfigStore.setState({
            activeDirectoryKey: '__global__',
            providers,
            agents,
            settingsDefaultAgent: 'Orchestrator',
            currentAgentName: 'Orchestrator',
            currentProviderId: 'anthropic',
            currentModelId: 'claude',
            currentVariant: undefined,
            selectedProviderId: 'anthropic',
            directoryScoped: {},
        });
    });

    test('uses each target agent configured model when cycling a new draft', () => {
        applyDraftAwareAgentChange(
            'Builder',
            {
                currentSessionId: null,
                currentDraftId: DRAFT_ID,
                newSessionDraftOpen: true,
            },
            selectionActions(),
        );

        expect(useConfigStore.getState().currentAgentName).toBe('Builder');
        expect(useConfigStore.getState().currentModelId).toBe('builder-model');

        applyDraftAwareAgentChange(
            'Orchestrator',
            {
                currentSessionId: null,
                currentDraftId: DRAFT_ID,
                newSessionDraftOpen: true,
            },
            selectionActions(),
        );

        expect(useConfigStore.getState().currentAgentName).toBe('Orchestrator');
        expect(useConfigStore.getState().currentProviderId).toBe('opencode');
        expect(useConfigStore.getState().currentModelId).toBe('small');
        expect(useConfigStore.getState().currentVariant).toBe(undefined);
    });

    test('applies the selected agent configured model when no draft model was saved', () => {
        applyDraftAwareAgentChange(
            'Builder',
            {
                currentSessionId: null,
                currentDraftId: DRAFT_ID,
                newSessionDraftOpen: true,
            },
            selectionActions(),
        );

        expect(useConfigStore.getState().currentAgentName).toBe('Builder');
        expect(useConfigStore.getState().currentProviderId).toBe('opencode');
        expect(useConfigStore.getState().currentModelId).toBe('builder-model');
        expect(useConfigStore.getState().currentVariant).toBe('high');
        expect(useSelectionStore.getState().getDraftAgentSelection(DRAFT_ID)).toBe('Builder');
        expect(useSelectionStore.getState().getDraftModelSelection(DRAFT_ID)).toEqual({
            providerId: 'opencode',
            modelId: 'builder-model',
        });
    });

    test('falls back when the target agent model is explicitly unavailable', () => {
        const unavailableModel = {
            ...createModel('opencode', 'unavailable-model'),
            available: false,
        } as Model;
        useConfigStore.setState({
            providers: [{
                ...providers[0],
                models: [...providers[0].models, unavailableModel],
            }, providers[1]],
            agents: [...agents, {
                name: 'UnavailableAgent',
                mode: 'primary',
                model: { providerID: 'opencode', modelID: 'unavailable-model' },
                permission: [],
                options: {},
            }],
            currentAgentName: 'Orchestrator',
            currentProviderId: 'opencode',
            currentModelId: 'unavailable-model',
            currentVariant: 'max',
        });

        applyDraftAwareAgentChange(
            'UnavailableAgent',
            {
                currentSessionId: null,
                currentDraftId: DRAFT_ID,
                newSessionDraftOpen: true,
            },
            selectionActions(),
        );

        expect(useConfigStore.getState().currentModelId).toBe('small');
        expect(useConfigStore.getState().currentVariant).toBe(undefined);
        expect(resolveCurrentDraftSendConfig(DRAFT_ID)?.modelID).toBe('small');
    });

    test('records draft send config when cycling agents on a new draft', () => {
        const savedConfigs: Array<{
            draftId: string;
            sendConfig: {
                providerID?: string;
                modelID?: string;
                agent?: string;
                variant?: string;
            };
        }> = [];

        applyDraftAwareAgentChange(
            'Builder',
            {
                currentSessionId: null,
                currentDraftId: DRAFT_ID,
                newSessionDraftOpen: true,
            },
            {
                ...selectionActions(),
                saveDraftSendConfig: (draftId, sendConfig) => {
                    savedConfigs.push({ draftId, sendConfig });
                },
            },
        );

        expect(savedConfigs).toEqual([{
            draftId: DRAFT_ID,
            sendConfig: {
                providerID: 'opencode',
                modelID: 'builder-model',
                agent: 'Builder',
                variant: 'high',
                modelProvenance: 'agent-default',
            },
        }]);
    });

    test('preserves an explicit model across agent changes on a new draft', () => {
        applyDraftAwareModelChange(
            'anthropic',
            'claude',
            {
                currentSessionId: null,
                currentDraftId: DRAFT_ID,
                newSessionDraftOpen: true,
                currentAgentName: 'Orchestrator',
            },
            modelSelectionActions(),
        );

        applyDraftAwareAgentChange(
            'Builder',
            {
                currentSessionId: null,
                currentDraftId: DRAFT_ID,
                newSessionDraftOpen: true,
            },
            selectionActions(),
        );

        expect(useConfigStore.getState().currentAgentName).toBe('Builder');
        expect(useConfigStore.getState().currentProviderId).toBe('anthropic');
        expect(useConfigStore.getState().currentModelId).toBe('claude');
        expect(useSessionUIStore.getState().newSessionDraft.sendConfig?.modelProvenance).toBe('explicit');
        expect(resolveCurrentDraftSendConfig(DRAFT_ID)).toEqual({
            providerID: 'anthropic',
            modelID: 'claude',
            agent: 'Builder',
            variant: undefined,
            planMode: false,
        });
    });

    test('keeps automatic default-to-default switching when no explicit model intent exists', () => {
        applyDraftAwareAgentChange(
            'Builder',
            {
                currentSessionId: null,
                currentDraftId: DRAFT_ID,
                newSessionDraftOpen: true,
            },
            selectionActions(),
        );
        expect(useConfigStore.getState().currentModelId).toBe('builder-model');
        expect(useSessionUIStore.getState().newSessionDraft.sendConfig?.modelProvenance).toBe('agent-default');

        applyDraftAwareAgentChange(
            'Orchestrator',
            {
                currentSessionId: null,
                currentDraftId: DRAFT_ID,
                newSessionDraftOpen: true,
            },
            selectionActions(),
        );

        expect(useConfigStore.getState().currentProviderId).toBe('opencode');
        expect(useConfigStore.getState().currentModelId).toBe('small');
        expect(useSessionUIStore.getState().newSessionDraft.sendConfig?.modelProvenance).toBe('agent-default');
    });

    test('treats same-as-default manual selection as explicit intent across agents', () => {
        useConfigStore.setState({
            currentAgentName: 'Orchestrator',
            currentProviderId: 'opencode',
            currentModelId: 'small',
            currentVariant: undefined,
            selectedProviderId: 'opencode',
        });

        applyDraftAwareModelChange(
            'opencode',
            'small',
            {
                currentSessionId: null,
                currentDraftId: DRAFT_ID,
                newSessionDraftOpen: true,
                currentAgentName: 'Orchestrator',
            },
            modelSelectionActions(),
        );

        expect(useSessionUIStore.getState().newSessionDraft.sendConfig?.modelProvenance).toBe('explicit');

        applyDraftAwareAgentChange(
            'Builder',
            {
                currentSessionId: null,
                currentDraftId: DRAFT_ID,
                newSessionDraftOpen: true,
            },
            selectionActions(),
        );

        expect(useConfigStore.getState().currentAgentName).toBe('Builder');
        expect(useConfigStore.getState().currentProviderId).toBe('opencode');
        expect(useConfigStore.getState().currentModelId).toBe('small');
        expect(useConfigStore.getState().currentVariant).toBe(undefined);
    });

    test('treats variant-only manual selection as explicit intent across agents', () => {
        useConfigStore.setState({
            currentAgentName: 'Builder',
            currentProviderId: 'opencode',
            currentModelId: 'builder-model',
            currentVariant: 'high',
            selectedProviderId: 'opencode',
        });
        useSessionUIStore.getState().updateNewSessionDraftSendConfig({
            providerID: 'opencode',
            modelID: 'builder-model',
            agent: 'Builder',
            variant: 'high',
            modelProvenance: 'agent-default',
        });

        applyDraftAwareModelChange(
            'opencode',
            'builder-model',
            {
                currentSessionId: null,
                currentDraftId: DRAFT_ID,
                newSessionDraftOpen: true,
                currentAgentName: 'Builder',
                variant: undefined,
            },
            modelSelectionActions(),
        );

        expect(useSessionUIStore.getState().newSessionDraft.sendConfig?.modelProvenance).toBe('explicit');

        applyDraftAwareAgentChange(
            'Orchestrator',
            {
                currentSessionId: null,
                currentDraftId: DRAFT_ID,
                newSessionDraftOpen: true,
            },
            selectionActions(),
        );

        expect(useConfigStore.getState().currentAgentName).toBe('Orchestrator');
        expect(useConfigStore.getState().currentProviderId).toBe('opencode');
        expect(useConfigStore.getState().currentModelId).toBe('builder-model');
    });

    test('preserves explicit model through rapid agent switching', () => {
        applyDraftAwareModelChange(
            'anthropic',
            'claude',
            {
                currentSessionId: null,
                currentDraftId: DRAFT_ID,
                newSessionDraftOpen: true,
                currentAgentName: 'Orchestrator',
            },
            modelSelectionActions(),
        );

        for (const agentName of ['Builder', 'Orchestrator', 'Builder', 'Orchestrator', 'Builder']) {
            applyDraftAwareAgentChange(
                agentName,
                {
                    currentSessionId: null,
                    currentDraftId: DRAFT_ID,
                    newSessionDraftOpen: true,
                },
                selectionActions(),
            );
        }

        const state = useConfigStore.getState();
        expect({
            currentAgentName: state.currentAgentName,
            currentProviderId: state.currentProviderId,
            currentModelId: state.currentModelId,
            currentVariant: state.currentVariant,
        }).toEqual({
            currentAgentName: 'Builder',
            currentProviderId: 'anthropic',
            currentModelId: 'claude',
            currentVariant: undefined,
        });
        expect(useSessionUIStore.getState().newSessionDraft.sendConfig?.modelProvenance).toBe('explicit');
    });

    test('records keyboard-selected draft model for the current agent and draft send config', () => {
        const selection = useSelectionStore.getState();
        const savedConfigs: Array<{
            draftId: string;
            sendConfig: {
                providerID?: string;
                modelID?: string;
                agent?: string;
                variant?: string;
                modelProvenance?: string;
            };
        }> = [];

        applyDraftAwareModelChange(
            'anthropic',
            'claude',
            {
                currentSessionId: null,
                currentDraftId: DRAFT_ID,
                newSessionDraftOpen: true,
                currentAgentName: 'Orchestrator',
            },
            {
                ...modelSelectionActions(),
                saveDraftSendConfig: (draftId, sendConfig) => {
                    savedConfigs.push({ draftId, sendConfig });
                    useSessionUIStore.getState().updateNewSessionDraftSendConfig(sendConfig);
                },
            },
        );

        expect(useConfigStore.getState().currentProviderId).toBe('anthropic');
        expect(useConfigStore.getState().currentModelId).toBe('claude');
        expect(selection.getDraftModelSelection(DRAFT_ID)).toEqual({
            providerId: 'anthropic',
            modelId: 'claude',
        });
        expect(selection.getDraftAgentModelForSelection(DRAFT_ID, 'Orchestrator')).toEqual({
            providerId: 'anthropic',
            modelId: 'claude',
        });
        expect(savedConfigs).toEqual([{
            draftId: DRAFT_ID,
            sendConfig: {
                providerID: 'anthropic',
                modelID: 'claude',
                agent: 'Orchestrator',
                variant: undefined,
                modelProvenance: 'explicit',
            },
        }]);
    });

    test('carries a keyboard-selected explicit model into another agent', () => {
        applyDraftAwareModelChange(
            'anthropic',
            'claude',
            {
                currentSessionId: null,
                currentDraftId: DRAFT_ID,
                newSessionDraftOpen: true,
                currentAgentName: 'Orchestrator',
            },
            modelSelectionActions(),
        );

        applyDraftAwareAgentChange(
            'Builder',
            {
                currentSessionId: null,
                currentDraftId: DRAFT_ID,
                newSessionDraftOpen: true,
            },
            selectionActions(),
        );

        expect(resolveCurrentDraftSendConfig(DRAFT_ID)).toEqual({
            providerID: 'anthropic',
            modelID: 'claude',
            agent: 'Builder',
            variant: undefined,
            planMode: false,
        });
        expect(useSessionUIStore.getState().newSessionDraft.sendConfig?.modelProvenance).toBe('explicit');
    });

    test('treats legacy draft provider+model without provenance as explicit when switching agents', () => {
        useConfigStore.setState({
            currentAgentName: 'Orchestrator',
            currentProviderId: 'anthropic',
            currentModelId: 'claude',
            currentVariant: undefined,
            selectedProviderId: 'anthropic',
        });
        useSessionUIStore.getState().updateNewSessionDraftSendConfig({
            providerID: 'anthropic',
            modelID: 'claude',
            agent: 'Orchestrator',
        });
        expect(useSessionUIStore.getState().newSessionDraft.sendConfig?.modelProvenance).toBe(undefined);

        applyDraftAwareAgentChange(
            'Builder',
            {
                currentSessionId: null,
                currentDraftId: DRAFT_ID,
                newSessionDraftOpen: true,
            },
            selectionActions(),
        );

        expect(useConfigStore.getState().currentModelId).toBe('claude');
        expect(useSessionUIStore.getState().newSessionDraft.sendConfig?.modelProvenance).toBe('explicit');
    });

    test('rapid agent switching settles on the final target model and variant', () => {
        for (const agentName of ['Builder', 'Orchestrator', 'Builder', 'Orchestrator', 'Builder']) {
            applyDraftAwareAgentChange(
                agentName,
                {
                    currentSessionId: null,
                    currentDraftId: DRAFT_ID,
                    newSessionDraftOpen: true,
                },
                selectionActions(),
            );
        }

        const state = useConfigStore.getState();
        expect({
            currentAgentName: state.currentAgentName,
            currentProviderId: state.currentProviderId,
            currentModelId: state.currentModelId,
            currentVariant: state.currentVariant,
        }).toEqual({
            currentAgentName: 'Builder',
            currentProviderId: 'opencode',
            currentModelId: 'builder-model',
            currentVariant: 'high',
        });
    });

    test('saves session agent selection without draft preservation for established sessions', () => {
        useSessionUIStore.setState({
            currentSessionId: 'session-1',
            currentDraftId: null,
            newSessionDraft: { open: false, directoryOverride: null, parentID: null },
        });

        applyDraftAwareAgentChange(
            'Builder',
            {
                currentSessionId: 'session-1',
                currentDraftId: null,
                newSessionDraftOpen: false,
            },
            selectionActions(),
        );

        expect(useConfigStore.getState().currentAgentName).toBe('Builder');
        expect(useConfigStore.getState().currentProviderId).toBe('opencode');
        expect(useConfigStore.getState().currentModelId).toBe('builder-model');
        expect(useSelectionStore.getState().getSessionAgentSelection('session-1')).toBe('Builder');
    });

    test('restores each target agent saved model and variant for established sessions', () => {
        useSessionUIStore.setState({
            currentSessionId: 'session-agent-restore',
            currentDraftId: null,
            newSessionDraft: { open: false, directoryOverride: null, parentID: null },
        });
        const selection = useSelectionStore.getState();
        selection.saveAgentModelForSession('session-agent-restore', 'Builder', 'opencode', 'builder-model');
        selection.saveAgentModelVariantForSession('session-agent-restore', 'Builder', 'opencode', 'builder-model', 'high');
        selection.saveAgentModelForSession('session-agent-restore', 'Orchestrator', 'anthropic', 'claude');

        applyDraftAwareAgentChange(
            'Builder',
            {
                currentSessionId: 'session-agent-restore',
                currentDraftId: null,
                newSessionDraftOpen: false,
            },
            selectionActions(),
        );
        expect(useConfigStore.getState().currentModelId).toBe('builder-model');
        expect(useConfigStore.getState().currentVariant).toBe('high');

        applyDraftAwareAgentChange(
            'Orchestrator',
            {
                currentSessionId: 'session-agent-restore',
                currentDraftId: null,
                newSessionDraftOpen: false,
            },
            selectionActions(),
        );
        expect(useConfigStore.getState().currentProviderId).toBe('anthropic');
        expect(useConfigStore.getState().currentModelId).toBe('claude');
        expect(useConfigStore.getState().currentVariant).toBe(undefined);
    });
});

describe('persistCycledThinkingVariant', () => {
    beforeEach(() => {
        useSessionUIStore.setState({
            currentSessionId: null,
            currentDraftId: DRAFT_ID,
            draftsById: {
                [DRAFT_ID]: {
                    id: DRAFT_ID,
                    text: '',
                    createdAt: 1,
                    updatedAt: 1,
                    selectedProjectId: null,
                    directoryOverride: '/repo',
                    parentID: null,
                },
            },
            draftOrder: [DRAFT_ID],
            newSessionDraft: { open: true, id: DRAFT_ID, directoryOverride: '/repo', parentID: null },
        });
        useSelectionStore.setState({
            sessionModelSelections: new Map(),
            sessionAgentSelections: new Map(),
            sessionPlanModeSelections: new Map(),
            defaultPlanModeSelection: false,
            draftPlanModeSelections: new Map(),
            sessionAgentModelSelections: new Map(),
            draftModelSelections: new Map(),
            draftAgentSelections: new Map(),
            draftAgentModelSelections: new Map(),
            draftAgentModelVariantSelections: new Map(),
            lastUsedProvider: null,
        });
        useConfigStore.setState({
            activeDirectoryKey: '__global__',
            providers,
            agents,
            settingsDefaultAgent: 'Orchestrator',
            currentAgentName: 'Builder',
            currentProviderId: 'opencode',
            currentModelId: 'builder-model',
            currentVariant: 'high',
            selectedProviderId: 'opencode',
            directoryScoped: {},
        });
    });

    test('persists cycled draft thinking variant as explicit model provenance', () => {
        useSessionUIStore.getState().updateNewSessionDraftSendConfig({
            providerID: 'opencode',
            modelID: 'builder-model',
            agent: 'Builder',
            variant: 'high',
            modelProvenance: 'agent-default',
        });

        persistCycledThinkingVariant(
            {
                currentSessionId: null,
                currentDraftId: DRAFT_ID,
                newSessionDraftOpen: true,
                currentAgentName: 'Builder',
                providerId: 'opencode',
                modelId: 'builder-model',
                nextVariant: 'high',
            },
            modelSelectionActions(),
        );

        expect(useSessionUIStore.getState().newSessionDraft.sendConfig).toEqual({
            providerID: 'opencode',
            modelID: 'builder-model',
            agent: 'Builder',
            variant: 'high',
            modelProvenance: 'explicit',
        });
        expect(useSelectionStore.getState().getDraftModelSelection(DRAFT_ID)).toEqual({
            providerId: 'opencode',
            modelId: 'builder-model',
        });
        expect(
            useSelectionStore.getState().getDraftAgentModelVariantForSelection(
                DRAFT_ID,
                'Builder',
                'opencode',
                'builder-model',
            ),
        ).toBe('high');
    });

    test('persists cycled thinking variant only to session maps for established sessions', () => {
        useSessionUIStore.setState({
            currentSessionId: 'session-1',
            currentDraftId: null,
            newSessionDraft: { open: false, directoryOverride: null, parentID: null },
        });

        persistCycledThinkingVariant(
            {
                currentSessionId: 'session-1',
                currentDraftId: null,
                newSessionDraftOpen: false,
                currentAgentName: 'Builder',
                providerId: 'opencode',
                modelId: 'builder-model',
                nextVariant: 'high',
            },
            modelSelectionActions(),
        );

        expect(
            useSelectionStore.getState().getAgentModelVariantForSession(
                'session-1',
                'Builder',
                'opencode',
                'builder-model',
            ),
        ).toBe('high');
        expect(useSessionUIStore.getState().newSessionDraft.sendConfig).toBe(undefined);
    });
});
