import { beforeEach, describe, expect, test } from 'bun:test';
import type { Agent, Model, Provider } from '@opencode-ai/sdk/v2';
import { applyDraftAwareAgentChange, applyDraftAwareModelChange } from './draftAwareAgentChange';
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
    };
}

describe('applyDraftAwareAgentChange', () => {
    beforeEach(() => {
        useSessionUIStore.setState({
            currentSessionId: null,
            currentDraftId: DRAFT_ID,
            newSessionDraft: { open: true, directoryOverride: '/repo', parentID: null },
        });
        useSelectionStore.setState({
            sessionModelSelections: new Map(),
            sessionAgentSelections: new Map(),
            sessionPlanModeSelections: new Map(),
            defaultPlanModeSelection: false,
            draftPlanModeSelection: false,
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

    test('falls back to an available model when the target agent configured model is unavailable', () => {
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
            },
        }]);
    });

    test('restores a manual model only for the agent that selected it', () => {
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
        expect(useConfigStore.getState().currentProviderId).toBe('opencode');
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

        expect(resolveCurrentDraftSendConfig(DRAFT_ID)).toEqual({
            providerID: 'anthropic',
            modelID: 'claude',
            agent: 'Orchestrator',
            variant: undefined,
            planMode: false,
        });
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
            },
        }]);
    });

    test('does not carry a keyboard-selected model into another agent', () => {
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
                saveDraftSendConfig: (_draftId, sendConfig) => {
                    useSessionUIStore.getState().updateNewSessionDraftSendConfig(sendConfig);
                },
            },
        );

        applyDraftAwareAgentChange(
            'Builder',
            {
                currentSessionId: null,
                currentDraftId: DRAFT_ID,
                newSessionDraftOpen: true,
            },
            {
                ...selectionActions(),
                saveDraftSendConfig: (_draftId, sendConfig) => {
                    useSessionUIStore.getState().updateNewSessionDraftSendConfig(sendConfig);
                },
            },
        );

        expect(resolveCurrentDraftSendConfig(DRAFT_ID)).toEqual({
            providerID: 'opencode',
            modelID: 'builder-model',
            agent: 'Builder',
            variant: 'high',
            planMode: false,
        });
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
