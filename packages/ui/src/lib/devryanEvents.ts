import { canonicalEventType, DEVRYAN_EVENT_DIALECT } from '@/lib/eventTypes';

export type ScheduledTaskRanEvent = {
  type: 'scheduled-task-ran';
  projectId: string;
  taskId: string;
  ranAt: number;
  status: 'running' | 'success' | 'error';
  sessionId?: string;
};

export type ProjectMetadataChangedEvent = {
  type: 'project-metadata-changed';
  projectId: string;
};

export type OpenChamberStreamReadyEvent = {
  type: 'stream-ready';
};

export type BrowserAgentLeasesChangedEvent = {
  type: 'browser-agent-leases-changed';
  revision: number;
};

export type OpenChamberEvent = ScheduledTaskRanEvent
  | ProjectMetadataChangedEvent
  | OpenChamberStreamReadyEvent
  | BrowserAgentLeasesChangedEvent;
type Listener = (event: OpenChamberEvent) => void;

let eventSource: EventSource | null = null;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let heartbeatTimer: ReturnType<typeof setTimeout> | null = null;
let reconnectAttempt = 0;
const listeners = new Set<Listener>();

const MAX_RECONNECT_DELAY_MS = 30_000;
const HEARTBEAT_TIMEOUT_MS = 45_000;

const clearHeartbeatTimer = () => {
  if (!heartbeatTimer) {
    return;
  }
  clearTimeout(heartbeatTimer);
  heartbeatTimer = null;
};

const scheduleReconnect = () => {
  if (reconnectTimer || listeners.size === 0) {
    return;
  }
  const delay = Math.min(1_000 * Math.pow(2, Math.min(reconnectAttempt, 5)), MAX_RECONNECT_DELAY_MS);
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    reconnectAttempt += 1;
    connect();
  }, delay);
};

const cleanupSource = () => {
  clearHeartbeatTimer();
  if (eventSource) {
    eventSource.close();
  }
  eventSource = null;
};

const resetHeartbeatTimer = () => {
  clearHeartbeatTimer();
  if (listeners.size === 0) {
    return;
  }
  heartbeatTimer = setTimeout(() => {
    cleanupSource();
    scheduleReconnect();
  }, HEARTBEAT_TIMEOUT_MS);
};

const parseEnvelope = (raw: string): { type: string; properties: unknown } | null => {
  if (!raw || raw.trim().length === 0) {
    return null;
  }

  try {
    const parsed = JSON.parse(raw);
    const type = typeof parsed?.type === 'string' ? canonicalEventType(parsed.type) : '';
    const properties = parsed?.properties;
    if (!type) {
      return null;
    }
    return { type, properties };
  } catch {
    return null;
  }
};

export const parseOpenChamberEventEnvelope = (
  rawEnvelope: { type: string; properties: unknown },
): OpenChamberEvent | null => {
  const envelope = { ...rawEnvelope, type: canonicalEventType(rawEnvelope.type) };
  if (envelope.type === 'devryan:event-stream-ready') {
    return { type: 'stream-ready' };
  }

  if (envelope.type === 'devryan:heartbeat') {
    return null;
  }

  const parsed = envelope.properties && typeof envelope.properties === 'object'
    ? envelope.properties as Record<string, unknown>
    : null;

  if (envelope.type === 'devryan:project-metadata-changed') {
    const projectId = typeof parsed?.projectId === 'string' ? parsed.projectId.trim() : '';
    return projectId ? { type: 'project-metadata-changed', projectId } : null;
  }

  if (envelope.type === 'devryan:browser-agent-leases-changed') {
    const revision = typeof parsed?.revision === 'number' && Number.isSafeInteger(parsed.revision)
      ? parsed.revision
      : -1;
    return revision >= 0 ? { type: 'browser-agent-leases-changed', revision } : null;
  }

  if (envelope.type !== 'devryan:scheduled-task-ran') {
    return null;
  }

  const projectId = typeof parsed?.projectId === 'string' ? parsed.projectId : '';
  const taskId = typeof parsed?.taskId === 'string' ? parsed.taskId : '';
  const ranAt = typeof parsed?.ranAt === 'number' ? parsed.ranAt : Date.now();
  const rawStatus = parsed?.status;
  const status = rawStatus === 'running' || rawStatus === 'error' ? rawStatus : 'success';
  if (!projectId || !taskId) {
    return null;
  }

  return {
    type: 'scheduled-task-ran',
    projectId,
    taskId,
    ranAt,
    status,
    ...(typeof parsed?.sessionId === 'string' && parsed.sessionId.length > 0 ? { sessionId: parsed.sessionId } : {}),
  };
};

const dispatchFromEnvelope = (envelope: { type: string; properties: unknown }) => {
  const nextEvent = parseOpenChamberEventEnvelope(envelope);
  if (!nextEvent) return;
  if (nextEvent.type === 'stream-ready') reconnectAttempt = 0;
  for (const listener of listeners) {
    listener(nextEvent);
  }
};

const connect = () => {
  if (typeof window === 'undefined' || listeners.size === 0) {
    return;
  }
  if (typeof EventSource !== 'function') {
    return;
  }

  if (eventSource && eventSource.readyState !== EventSource.CLOSED) {
    return;
  }

  cleanupSource();

  const source = new EventSource(`/api/devryan/events?events=${DEVRYAN_EVENT_DIALECT}`);
  source.onopen = () => {
    resetHeartbeatTimer();
  };
  source.onmessage = (event) => {
    resetHeartbeatTimer();
    const envelope = parseEnvelope(event.data);
    if (!envelope) {
      return;
    }
    dispatchFromEnvelope(envelope);
  };

  source.onerror = () => {
    cleanupSource();
    scheduleReconnect();
  };

  eventSource = source;
};

export const subscribeOpenchamberEvents = (listener: Listener): (() => void) => {
  listeners.add(listener);
  connect();

  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) {
      if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }
      reconnectAttempt = 0;
      cleanupSource();
    }
  };
};
