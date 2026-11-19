// Harness-owned toy dependency (self-test corpus of the client conformance
// harness): a sink the scheduler toy writes to, no port of any family. The
// mocked-module toys mock it with an object whose methods the engine calls.
// Product code never imports it.
export const sink = {
  write(items) { return items.length; },
};
