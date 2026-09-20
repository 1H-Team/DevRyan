const asString = (value) => (
  typeof value === 'string' && value.trim().length > 0 ? value.trim() : ''
);

const explicitSessionID = (record) => asString(record?.sessionID)
    || asString(record?.payload?.sessionID)
    || asString(record?.payload?.properties?.sessionID)
    || asString(record?.payload?.properties?.info?.sessionID);

const managedTask = (record) => {
  const event = record?.payload, properties = event?.properties, task = properties?.task;
  if (event?.type !== 'openchamber:managed-task' || properties?.owner !== 'devryan'
    || task?.owner !== 'devryan') return null;
  const root = asString(task.rootSessionId), explicit = explicitSessionID(record);
  return root && (!explicit || explicit === root) ? task : null;
};

export const resolveRecordSessionID = (record) => {
  const explicit = explicitSessionID(record);
  if (explicit) return explicit;
  if (asString(record?.usageObservation?.sessionID)) return asString(record.usageObservation.sessionID);
  if (asString(record?.payload?.properties?.part?.sessionID)) return asString(record.payload.properties.part.sessionID);

  const task = managedTask(record);
  if (task) return asString(task.rootSessionId);
  const eventType = asString(record?.payload?.type);
  if (eventType === 'openchamber:managed-task-removed' && record.payload.properties?.owner === 'devryan') {
    return asString(record.payload.properties.rootSessionId);
  }
  return eventType.startsWith('session.')
    ? asString(record?.payload?.properties?.info?.id)
    : '';
};
export const resolveSessionRelation = (record) => {
  // Only the title owner establishes this relation. A helper is deleted after
  // generation; its durable diagnostic keeps it in task-scoped exports.
  if (record?.type === 'lifecycle' && record.event === 'session_title_generation') {
    const sessionID = asString(record.payload?.helperSessionID), parentID = asString(record.sessionID);
    if (sessionID && parentID && sessionID !== parentID) return { sessionID, parentID };
  }
  const task = managedTask(record);
  if (task) {
    const sessionID = asString(task.childSessionId), parentID = asString(task.rootSessionId);
    return sessionID && sessionID !== parentID ? { sessionID, parentID } : null;
  }
  if (!asString(record?.payload?.type).startsWith('session.')) return null;
  const info = record?.payload?.properties?.info;
  const sessionID = asString(info?.id ?? info?.sessionID);
  const parentID = asString(info?.parentID ?? info?.parentId);
  return sessionID && parentID ? { sessionID, parentID } : null;
};
