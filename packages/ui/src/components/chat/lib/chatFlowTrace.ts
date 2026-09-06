export const CHAT_FLOW_TRACE_SCHEMA_VERSION = 1 as const;

export type ChatFlowTraceRuntime = 'web' | 'electron';

export type ChatFlowTraceAction =
    | 'plan.initial'
    | 'plan.revision'
    | 'queue.add'
    | 'queue.auto-send'
    | 'queue.send-now'
    | 'steer.direct';

export interface ChatFlowTraceAssertion {
    name: string;
    passed: boolean;
}

export interface ChatFlowTraceEventInput {
    action: ChatFlowTraceAction;
    /** Overrides the artifact's primary session when a runtime run spans multiple sessions. */
    sessionId?: string;
    observedAt?: string;
    queueItemId?: string;
    queuePosition?: number;
    turnId?: string;
    userMessageId?: string;
    assistantMessageIds?: string[];
    assistantParentMessageId?: string;
    planVersion?: number;
    planSourceMessageId?: string;
    abortReason?: 'manual' | 'steered';
    statusBefore?: string;
    statusAfter?: string;
    assertions: ChatFlowTraceAssertion[];
}

export interface ChatFlowTraceEvent extends ChatFlowTraceEventInput {
    sequence: number;
    runtime: ChatFlowTraceRuntime;
    sessionId: string;
}

export interface ChatFlowTraceArtifact {
    schemaVersion: typeof CHAT_FLOW_TRACE_SCHEMA_VERSION;
    runId: string;
    runtime: ChatFlowTraceRuntime;
    projectDirectory: string;
    sessionId: string;
    events: ChatFlowTraceEvent[];
}

export const createChatFlowTraceArtifact = ({
    runId,
    runtime,
    projectDirectory,
    sessionId,
    events,
}: {
    runId: string;
    runtime: ChatFlowTraceRuntime;
    projectDirectory: string;
    sessionId: string;
    events: ChatFlowTraceEventInput[];
}): ChatFlowTraceArtifact => ({
    schemaVersion: CHAT_FLOW_TRACE_SCHEMA_VERSION,
    runId,
    runtime,
    projectDirectory,
    sessionId,
    events: events.map((event, index) => ({
        ...event,
        sequence: index + 1,
        runtime,
        sessionId: event.sessionId ?? sessionId,
        ...(event.assistantMessageIds ? { assistantMessageIds: [...event.assistantMessageIds] } : {}),
        assertions: event.assertions.map((assertion) => ({ ...assertion })),
    })),
});
