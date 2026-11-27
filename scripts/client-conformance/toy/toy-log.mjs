// Harness-owned toy port (self-test corpus of the client conformance harness):
// the transport toy's logger, a module port in the toy port map.
export function log(kind, detail) {
  return `${kind}:${detail}`;
}

// A session id the module draws once, when it loads (package C0f): a data port export of the transport toy, whose
// value the recording keeps with its container (format 5, `load.portData`), so a replay's module has the very value.
export const logSession = crypto.randomUUID();
