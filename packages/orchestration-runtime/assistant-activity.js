// Startup evidence is semantic output, never an empty message or a busy status.
export const isManagedAssistantActivityPart = (part) => (
  ((part?.type === 'text' || part?.type === 'reasoning')
    && typeof part.text === 'string' && part.text.trim().length > 0)
  || (part?.type === 'tool' && typeof part.callID === 'string' && part.callID.length > 0)
);

// Retain only identities for actively watched children, never transcript content.
// Parts can precede message metadata; bounded identity buffers bridge that ordering.
export const createManagedAssistantActivityRegistry = ({ now = Date.now } = {}) => {
  const watchers = new Map();
  const changeWatchers = new Map();
  const boundedSet = (map, key, value) => {
    map.set(key, value);
    if (map.size > 128) map.delete(map.keys().next().value);
  };
  const rememberAssistant = (entry, messageId, createdAt, completedAt) => {
    if (typeof messageId !== 'string' || !messageId || messageId.length > 256
      || messageId === entry.input.excludedMessageId || !Number.isFinite(createdAt)
      || createdAt < entry.input.after) return;
    boundedSet(entry.messages, messageId, {
      completed: entry.messages.get(messageId)?.completed === true || Number.isFinite(completedAt),
    });
  };
  const deliver = (entry, messageId) => {
    const message = entry.messages.get(messageId);
    if (!message) return;
    if (entry.progress.has(messageId)) {
      const observedAt = entry.progress.get(messageId);
      entry.progress.delete(messageId);
      if (!message.completed && Number.isFinite(observedAt) && observedAt >= entry.input.after) {
        entry.onProgress?.({ messageId, observedAt });
      }
    }
    if (entry.parts.has(messageId)) {
      const observedAt = entry.parts.get(messageId);
      if (Number.isFinite(observedAt) && observedAt >= entry.input.after) entry.onActivity({ messageId, observedAt });
    }
  };
  return {
    // Canonical reads can identify an assistant whose metadata predated this
    // subscription. Binding alone is not activity: only buffered real events
    // may be delivered, with their original observation times.
    bind(input, assistants) {
      const entries = watchers.get(input.sessionId);
      if (!entries || !Array.isArray(assistants)) return;
      for (const entry of entries) {
        if (entry.input.directory !== input.directory || entry.input.after !== input.after
          || (entry.input.excludedMessageId ?? null) !== (input.excludedMessageId ?? null)) continue;
        for (const assistant of assistants.slice(-128)) {
          rememberAssistant(entry, assistant.messageId, assistant.createdAt, assistant.completedAt);
          deliver(entry, assistant.messageId);
        }
      }
    },
    subscribeChanges(input, onChange) {
      const entry = { input, onChange };
      const entries = changeWatchers.get(input.sessionId) ?? new Set();
      entries.add(entry); changeWatchers.set(input.sessionId, entries);
      return () => {
        entries.delete(entry);
        if (!entries.size && changeWatchers.get(input.sessionId) === entries) changeWatchers.delete(input.sessionId);
      };
    },
    subscribe(input, onActivity, onProgress) {
      const entry = { input, onActivity, onProgress, messages: new Map(), parts: new Map(),
        progress: new Map(), eventIds: new Map(), lengths: new Map() };
      const entries = watchers.get(input.sessionId) ?? new Set();
      entries.add(entry);
      watchers.set(input.sessionId, entries);
      return () => {
        entries.delete(entry);
        if (entries.size === 0 && watchers.get(input.sessionId) === entries) watchers.delete(input.sessionId);
      };
    },
    observe(payload, directory = null) {
      const properties = payload?.properties;
      const changedSession = properties?.sessionID ?? properties?.info?.sessionID ?? properties?.info?.id;
      // Deltas update activity/watchdog observers only. Terminal/status
      // hints wake canonical observation without polling once per streamed byte.
      const reconnect = payload?.type === 'server.connected';
      const changed = ['session.status', 'session.idle', 'session.error', 'session.deleted', 'session.interrupted'].includes(payload?.type)
        || payload?.type === 'message.updated' && (properties?.info?.role === 'user' || Number.isFinite(properties?.info?.time?.completed));
      if (reconnect || changed) {
        const entries = reconnect ? [...changeWatchers.values()].flatMap(value => [...value]) : [...(changeWatchers.get(changedSession) ?? [])];
        for (const entry of entries) {
          if (directory && entry.input.directory && directory !== entry.input.directory) continue;
          entry.onChange();
        }
      }
      if (payload?.type !== 'message.updated' && payload?.type !== 'message.part.updated'
        && payload?.type !== 'message.part.delta') return;
      const info = properties?.info;
      const part = properties?.part;
      const sessionId = properties?.sessionID ?? info?.sessionID ?? part?.sessionID;
      const entries = watchers.get(sessionId);
      if (!entries) return;
      const messageId = info?.id ?? part?.messageID ?? properties?.messageID;
      if (typeof messageId !== 'string' || messageId.length > 256) return;
      for (const entry of entries) {
        if (directory && entry.input.directory && directory !== entry.input.directory) continue;
        if (messageId === entry.input.excludedMessageId) continue;
        if (info) {
          if (info.role !== 'assistant' || !Number.isFinite(info.time?.created)
            || info.time.created < entry.input.after) continue;
          rememberAssistant(entry, messageId, info.time.created, info.time.completed);
        }
        if (typeof entry.onProgress === 'function') {
          const delta = payload.type === 'message.part.delta'
            && (properties.field === 'text' || properties.field === 'reasoning')
            && typeof properties.delta === 'string' && properties.delta.trim().length > 0;
          const text = (part?.type === 'text' || part?.type === 'reasoning')
            && typeof part.text === 'string' && part.text.trim().length > 0;
          const id = typeof payload.id === 'string' && payload.id.length > 0 && payload.id.length <= 256 ? payload.id : null;
          const partId = properties.partID ?? part?.id;
          // Native deltas are live-only. Exact event IDs distinguish repeated
          // '.' output from duplicate delivery; snapshots must actually grow.
          if ((delta && id || text) && typeof partId === 'string' && partId.length <= 256
            && !(id && entry.eventIds.has(id))) {
            if (id) boundedSet(entry.eventIds, id, true);
            const key = JSON.stringify([messageId, partId]);
            const length = text ? part.text.length : 0;
            if (delta || length > (entry.lengths.get(key) ?? 0)) {
              boundedSet(entry.lengths, key, delta ? (entry.lengths.get(key) ?? 0) + properties.delta.length : length);
              boundedSet(entry.progress, messageId, now());
            }
          }
        }
        if (isManagedAssistantActivityPart(part)
          || (payload.type === 'message.part.delta'
            && (properties.field === 'text' || properties.field === 'reasoning')
            && typeof properties.delta === 'string' && properties.delta.trim())) {
          if (!entry.parts.has(messageId)) boundedSet(entry.parts, messageId, now());
        }
        deliver(entry, messageId);
      }
    },
    clear() { watchers.clear(); changeWatchers.clear(); },
  };
};
