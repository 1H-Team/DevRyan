// Meridian ends a silent Claude stream with an SSE error event of type
// `upstream_timeout` and the message `Upstream stalled: no data for <n>ms`.
// Match only that observed shape, never arbitrary prose mentioning a timeout.
const UPSTREAM_STALL_MESSAGE = /^Upstream stalled: no data for [1-9][0-9]{0,12}ms$/;
// OpenCode 2.x reformats the same event as `<type>: <message>`.
const UPSTREAM_STALL_TEXT = /^upstream_timeout: Upstream stalled: no data for [1-9][0-9]{0,12}ms$/;
const UPSTREAM_STALL_ENVELOPE_MAX_LENGTH = 4096;

/** The OpenCode 2.x `upstream_timeout: Upstream stalled: no data for <n>ms` text form. */
export const isUpstreamStallText = (value) => typeof value === 'string' && UPSTREAM_STALL_TEXT.test(value);

/** The bounded JSON envelope `{"type":"upstream_timeout","message":"Upstream stalled: no data for <n>ms"}`. */
export const isUpstreamStallEnvelope = (value) => {
  if (typeof value !== 'string' || value.length > UPSTREAM_STALL_ENVELOPE_MAX_LENGTH) return false;
  try {
    const envelope = JSON.parse(value);
    return envelope !== null && typeof envelope === 'object' && !Array.isArray(envelope)
      && envelope.type === 'upstream_timeout' && typeof envelope.message === 'string'
      && UPSTREAM_STALL_MESSAGE.test(envelope.message);
  } catch { return false; }
};
