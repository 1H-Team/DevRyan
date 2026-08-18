export function deriveDirectoryCompatibilityEvents(payload, now = Date.now()) {
  if (!payload || payload.type !== 'session.status') return [];

  const properties = payload.properties && typeof payload.properties === 'object' ? payload.properties : {};
  const statusInfo = properties.status && typeof properties.status === 'object' ? properties.status : {};
  const info = properties.info && typeof properties.info === 'object' ? properties.info : {};
  const sessionId = typeof properties.sessionID === 'string' ? properties.sessionID.trim() : '';
  const status = typeof statusInfo.type === 'string'
    ? statusInfo.type.trim()
    : (typeof info.type === 'string' ? info.type.trim() : '');

  if (!sessionId || !status) return [];

  return [
    {
      type: 'openchamber:session-status',
      properties: {
        sessionId,
        sessionID: sessionId,
        status,
        timestamp: now,
        metadata: {
          attempt: typeof statusInfo.attempt === 'number'
            ? statusInfo.attempt
            : (typeof info.attempt === 'number' ? info.attempt : undefined),
          message: typeof statusInfo.message === 'string'
            ? statusInfo.message
            : (typeof info.message === 'string' ? info.message : undefined),
          next: typeof statusInfo.next === 'number'
            ? statusInfo.next
            : (typeof info.next === 'number' ? info.next : undefined),
        },
        needsAttention: false,
      },
    },
    {
      type: 'openchamber:session-activity',
      properties: {
        sessionId,
        sessionID: sessionId,
        phase: status === 'busy' || status === 'retry' ? 'busy' : 'idle',
      },
    },
  ];
}
