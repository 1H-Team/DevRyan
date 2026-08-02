const asString = (value) => (
  typeof value === 'string' && value.trim().length > 0 ? value.trim() : ''
);

export const resolveRecordSessionID = (record) => {
  const explicit = asString(record?.sessionID)
    || asString(record?.payload?.sessionID)
    || asString(record?.payload?.properties?.sessionID)
    || asString(record?.payload?.properties?.info?.sessionID);
  if (explicit) return explicit;

  const eventType = asString(record?.payload?.type);
  return eventType.startsWith('session.')
    ? asString(record?.payload?.properties?.info?.id)
    : '';
};
export const resolveSessionRelation = (record) => {
  if (!asString(record?.payload?.type).startsWith('session.')) return null;
  const info = record?.payload?.properties?.info;
  const sessionID = asString(info?.id ?? info?.sessionID);
  const parentID = asString(info?.parentID ?? info?.parentId);
  return sessionID && parentID ? { sessionID, parentID } : null;
};
