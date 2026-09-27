// Which DevRyan UI path asked for a session abort. The UI sends one of these in
// ABORT_SOURCE_HEADER on every `session.abort`; the web server journals it and
// classifies operator stops from it. One list so the hosts cannot drift.
export const ABORT_SOURCE_HEADER = 'X-DevRyan-Abort-Source';

export const ABORT_SOURCES = Object.freeze([
  'stop_button',
  'double_escape',
  'steered_send',
  'session_removal',
  'revert',
  'redo',
  'abort_guard',
  'provider_retry',
  'stall_watchdog',
  'status_row',
]);

const ABORT_SOURCE_SET = new Set(ABORT_SOURCES);

/** Returns the source when it is a known value, otherwise 'unknown'. */
export const normalizeAbortSource = (value) => (
  typeof value === 'string' && ABORT_SOURCE_SET.has(value) ? value : 'unknown'
);
