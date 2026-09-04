// ---------------------------------------------------------------------------
// Diff-snapshot trimming.
//
// OpenCode attaches a git diff snapshot to user messages as `info.summary`.
// Each entry carries the full patch text, so a workspace with a large untracked
// tree produces a summary far bigger than the conversation itself (observed:
// 10,345 entries / ~87MB on a single user message, making one
// `GET /session/:id/message` return ~92MB).
//
// Two different consumers need two different trims:
//   * managed orchestration never reads the summary at all -> drop it outright.
//   * the UI renders per-turn added/removed badges from the entry metadata, so
//     it must keep the entries but not their bodies.
//
// `patch` is the field this OpenCode version populates; `before`/`after`/
// `from`/`to` are older shapes kept here so mixed-version payloads stay covered.
// ---------------------------------------------------------------------------

const DIFF_CONTENT_FIELDS = ['patch', 'before', 'after', 'from', 'to'];

const isRecord = (value) => (
  value !== null && typeof value === 'object' && !Array.isArray(value)
);

/** Drop `info.summary` entirely. For consumers that never read it. */
export const stripMessageDiffSummary = (record) => {
  if (!isRecord(record) || !isRecord(record.info) || record.info.summary === undefined) {
    return record;
  }
  const { summary: _summary, ...info } = record.info;
  return { ...record, info };
};

/** Remove patch bodies from one diff entry, preserving its metadata. */
export const stripDiffEntryContent = (entry) => {
  if (!isRecord(entry)) return entry;
  let stripped = entry;
  for (const field of DIFF_CONTENT_FIELDS) {
    if (typeof entry[field] !== 'string') continue;
    if (stripped === entry) stripped = { ...entry };
    delete stripped[field];
  }
  return stripped;
};

const stripSummaryContent = (summary) => {
  if (!isRecord(summary) || !Array.isArray(summary.diffs)) return summary;
  const diffs = summary.diffs.map(stripDiffEntryContent);
  return diffs.some((entry, index) => entry !== summary.diffs[index])
    ? { ...summary, diffs }
    : summary;
};

/**
 * Keep diff metadata (file/status/additions/deletions) but drop patch bodies.
 * For the UI, which renders diff counts but never the snapshot text.
 */
export const stripMessageDiffContent = (record) => {
  if (!isRecord(record) || !isRecord(record.info)) return record;
  const summary = stripSummaryContent(record.info.summary);
  if (summary === record.info.summary) return record;
  return { ...record, info: { ...record.info, summary } };
};

/** Same trim for a bare session object, whose summary sits at the top level. */
export const stripSessionDiffContent = (session) => {
  if (!isRecord(session)) return session;
  const summary = stripSummaryContent(session.summary);
  if (summary === session.summary) return session;
  return { ...session, summary };
};

/**
 * Live-stream variant: trims the diff bodies carried by an OpenCode SSE event
 * payload (`{ type, properties }`). `message.updated` wraps the message as
 * `properties.info`, `session.updated` wraps the session the same way; every
 * other event type is returned untouched. Returns the same reference when
 * nothing was stripped so hub replay and fan-out can skip re-serialisation.
 */
export const stripEventDiffContent = (payload) => {
  if (!isRecord(payload) || !isRecord(payload.properties)) return payload;
  if (payload.type === 'message.updated') {
    const properties = stripMessageDiffContent(payload.properties);
    return properties === payload.properties ? payload : { ...payload, properties };
  }
  if (payload.type === 'session.updated') {
    const info = stripSessionDiffContent(payload.properties.info);
    return info === payload.properties.info
      ? payload
      : { ...payload, properties: { ...payload.properties, info } };
  }
  return payload;
};
