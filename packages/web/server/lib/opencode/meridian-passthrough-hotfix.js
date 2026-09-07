// Exact, reversible edits to the source-hash-checked Meridian 1.62.6 bundle.
// The HTTP installer owns the single atomic entrypoint replacement.
export const MERIDIAN_HANDOFF_HELPER = 'devryan-meridian-passthrough-handoff.js';
export const MERIDIAN_HANDOFF_IMPORT = `import { settlePassthroughQuery } from "./${MERIDIAN_HANDOFF_HELPER}";\n`;
export const MERIDIAN_HANDOFF_EDITS = [
  ...[
    '              claudeLog("passthrough.noncanonical_session_evicted", { mode: "non_stream" });',
    '                    claudeLog("passthrough.noncanonical_session_evicted", { mode: "stream" });',
  ].map(before => [before, before + '\n' + before.match(/^ */)[0] + 'requestMeta.passthroughHandoff?.diagnostic("passthrough.checkpoint_rejected", { reason: requestAbort.controller.signal.aborted ? "client_abort" : "noncanonical_session_evicted", toolCount: 0 });']),
  [
    '          claudeLog("passthrough.checkpoint_replay", {',
    '          diagnosticLog2.session(requestMeta.requestId + " passthrough.checkpoint_replay reason=incomplete_or_mismatched_results", requestMeta.requestId);\n          claudeLog("passthrough.checkpoint_replay", {',
  ],
  [
    '      yield* guardUpstreamIdle(sdkQuery, UPSTREAM_IDLE_MS,',
    '      yield* guardUpstreamIdle(settlePassthroughQuery(sdkQuery, { signal, queryOptions: params.options, ...requestMeta.passthroughHandoff }), UPSTREAM_IDLE_MS,',
  ],
  [
    '        let earlyStopFired = false;\n        const envelopeViolations = [];',
    `        let earlyStopFired = false;
        requestMeta.passthroughHandoff = earlyStopEnabled ? {
          checkpoint: () => earlyStopFired ? {
            assistantUuid: earlyStop.toolCallAssistantUuid,
            toolCallIds: [...earlyStop.expected]
          } : null,
          verified: (checkpoint) => { requestMeta.passthroughHandoff.verifiedCheckpoint = checkpoint; },
          diagnostic: (event, detail) => diagnosticLog2.session(
            requestMeta.requestId + " " + event + " reason=" + detail.reason + " tools=" + detail.toolCount,
            requestMeta.requestId
          )
        } : undefined;
        const envelopeViolations = [];`,
  ],
  [
    '            if (checkpointTurn && (!earlyStopFired || !sawCanonicalResult)) {',
    '            if (requestAbort.controller.signal.aborted || checkpointTurn && (!earlyStopFired || (!sawCanonicalResult && requestMeta.passthroughHandoff?.verifiedCheckpoint?.sessionId !== currentSessionId))) {',
  ],
  [
    '                  if (exitedBeforeCanonicalTerminal || checkpointTurn && (!earlyStopFired || !sawCanonicalResult)) {',
    '                  if (requestAbort.controller.signal.aborted || exitedBeforeCanonicalTerminal || checkpointTurn && (!earlyStopFired || (!sawCanonicalResult && requestMeta.passthroughHandoff?.verifiedCheckpoint?.sessionId !== currentSessionId))) {',
  ],
  [
    '              commitSessionTurn();\n            }\n          }\n          const responseSessionId',
    '              commitSessionTurn();\n              if (checkpointTurn) requestMeta.passthroughHandoff?.diagnostic("passthrough.checkpoint_retained", { reason: "verified_handoff", toolCount: nextPassthroughToolCallIds?.length ?? 0 });\n            }\n          }\n          const responseSessionId',
  ],
  [
    '                    commitSessionTurn();\n                  }\n                }\n                const classifyNow',
    '                    commitSessionTurn();\n                    if (checkpointTurn) requestMeta.passthroughHandoff?.diagnostic("passthrough.checkpoint_retained", { reason: "verified_handoff", toolCount: nextPassthroughToolCallIds?.length ?? 0 });\n                  }\n                }\n                const classifyNow',
  ],
];

export const stripMeridianHandoffPatch = source => {
  let original = source.replace(MERIDIAN_HANDOFF_IMPORT, '');
  for (const [before, after] of MERIDIAN_HANDOFF_EDITS) original = original.replace(after, before);
  return original;
};

export const patchMeridianHandoff = source => {
  let patched = source;
  for (const [before, after] of MERIDIAN_HANDOFF_EDITS) {
    if (patched.split(before).length !== 2) throw new Error('Meridian handoff source anchors are incompatible');
    patched = patched.replace(before, after);
  }
  return MERIDIAN_HANDOFF_IMPORT + patched;
};
