// Harness-owned toy port (self-test corpus of the client conformance harness):
// the transport toy's logger, a module port in the toy port map.
export function log(kind, detail) {
  return `${kind}:${detail}`;
}
