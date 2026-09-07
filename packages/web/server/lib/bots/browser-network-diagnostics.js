// A second allowlist at the host boundary: computer images are independently
// versioned and cannot supply arbitrary network data to the journal or renderer.
const MAX_ENTRIES = 100;
const MAX_BYTES = 64 * 1024;
const TTL_MS = 5 * 60 * 1000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const TRANSITIONS = new Set([
  'control_taken', 'control_returned', 'control_expired', 'control_release_failed',
  'navigate', 'relaunch', 'page_reset', 'browser_closed', 'profile_reset',
  'egress_token_rotated', 'target_changed',
]);
const integer = (value) => Number.isSafeInteger(value) && value >= 0;
const reason = (value) => typeof value === 'string' && /^[A-Za-z0-9_.:-]{1,128}$/u.test(value);

export function projectBrowserNetworkTrail(value, { projectOrigin, projectPath, now }) {
  if (!value || typeof value !== 'object' || !UUID.test(value.streamId)
    || !Array.isArray(value.entries)) return undefined;
  const entries = [];
  let bytes = Buffer.byteLength(JSON.stringify({ streamId: value.streamId, entries: [] }), 'utf8');
  let previous = 0;
  for (const raw of value.entries.slice(-MAX_ENTRIES)) {
    if (!raw || !integer(raw.sequence) || raw.sequence <= previous || !integer(raw.observedAt)
      || raw.observedAt <= now - TTL_MS || raw.observedAt > now + 5_000
      || !integer(raw.generation)) continue;
    const entry = { sequence: raw.sequence, observedAt: raw.observedAt, generation: raw.generation };
    if (raw.kind === 'lifecycle') {
      if (!TRANSITIONS.has(raw.reason)) continue;
      Object.assign(entry, { kind: raw.kind, reason: raw.reason });
      if (typeof raw.failureCode === 'string' && /^DEVRYAN_BOT_[A-Z0-9_]{1,96}$/u.test(raw.failureCode)) {
        entry.failureCode = raw.failureCode;
      }
    } else {
      if (!['response', 'failure', 'cookie_block', 'proxy_failure'].includes(raw.kind)) continue;
      const origin = projectOrigin(raw.origin);
      if (!origin) continue;
      Object.assign(entry, { kind: raw.kind, origin });
      if (raw.kind !== 'proxy_failure') {
        const path = projectPath(raw.path);
        if (!path || !['Document', 'Fetch', 'XHR'].includes(raw.requestType)) continue;
        Object.assign(entry, { path, requestType: raw.requestType });
      }
      if (raw.kind === 'response') {
        if (!Number.isInteger(raw.statusCode) || raw.statusCode < 100 || raw.statusCode > 599) continue;
        entry.statusCode = raw.statusCode;
      } else {
        if (!reason(raw.reason)) continue;
        entry.reason = raw.reason;
        if (raw.kind === 'proxy_failure' && Number.isInteger(raw.statusCode)
          && raw.statusCode >= 400 && raw.statusCode <= 599) entry.statusCode = raw.statusCode;
      }
    }
    previous = raw.sequence;
    const size = Buffer.byteLength(JSON.stringify(entry), 'utf8') + 1;
    entries.push({ entry: Object.freeze(entry), size });
    bytes += size;
    while (bytes > MAX_BYTES && entries.length) bytes -= entries.shift().size;
  }
  return Object.freeze({ streamId: value.streamId, entries: Object.freeze(entries.map(({ entry }) => entry)) });
}

export function createBrowserNetworkJournal({ recordDiagnostic, now }) {
  // Stream IDs change when the computer process restarts; sequence numbers do
  // not reset on navigation, control transitions, or Chromium recovery.
  const cursors = new Map();
  return Object.freeze({
    observe(botId, trail) {
      if (!trail) return;
      const key = `${botId}:${trail.streamId}`;
      const current = cursors.get(key);
      let sequence = current?.sequence || 0;
      for (const entry of trail.entries) {
        if (entry.sequence <= sequence) continue;
        if (entry.sequence > sequence + 1) {
          recordDiagnostic({ type: 'gap', event: 'bot.computer.network_gap', payload: {
            botId, streamId: trail.streamId, firstMissingSequence: sequence + 1,
            lastMissingSequence: entry.sequence - 1, reason: 'network_trail_retention',
          } });
        }
        recordDiagnostic({ type: 'connection', event: 'bot.computer.network', payload: {
          botId, streamId: trail.streamId, ...entry,
        } });
        sequence = entry.sequence;
        cursors.set(key, { sequence, observedAt: now() });
      }
      if (current && !trail.entries.length) cursors.set(key, { ...current, observedAt: now() });
      for (const [id, cursor] of cursors) {
        if (cursor.observedAt <= now() - TTL_MS || cursors.size > 256) cursors.delete(id);
      }
    },
    clear() { cursors.clear(); },
  });
}
