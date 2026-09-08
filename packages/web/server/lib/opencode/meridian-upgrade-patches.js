import { MERIDIAN_HANDOFF_V1_EDITS, MERIDIAN_PREFIX_EDITS } from './meridian-passthrough-hotfix.js';

// Reviewed 1.68.0 already forks passthrough checkpoints. Keep that upstream
// logic, including its explicit target session IDs and replay provenance.
// Publication now accepts a session ID; retain its generation/pinning guards.
export const MERIDIAN_168_HANDOFF_EDITS = [
  ...MERIDIAN_HANDOFF_V1_EDITS.slice(0, 7),
  ...[
    ['                ', '\n              }\n            }\n          }\n          finalizePriorityPublication();'],
    ['                      ', '\n                    }\n                  }\n                }\n                if (pendingStructuredFrames.length > 0)'],
  ].map(([indent, suffix]) => {
    const before = `\n${indent}commitSessionTurn(currentSessionId);`;
    return [before + suffix, before + `\n${indent}if (checkpointTurn) requestMeta.passthroughHandoff?.diagnostic("passthrough.checkpoint_retained", { reason: "verified_handoff", toolCount: nextPassthroughToolCallIds?.length ?? 0 });` + suffix];
  }),
];

export const MERIDIAN_168_PREFIX_EDITS = [
  [
    '              return {\n                decision: "block",\n                reason: PASSTHROUGH_DENY_REASON',
    '              return {\n                ...earlyStopEnabled ? { continue: false, stopReason: "Awaiting client tool results." } : {},\n                decision: "block",\n                reason: PASSTHROUGH_DENY_REASON',
  ],
  MERIDIAN_PREFIX_EDITS[1],
  MERIDIAN_PREFIX_EDITS[3],
  [
    '    const append2 = [clientContext, cwdNote, GIT_STATUS_PROVENANCE_NOTE, REPLAY_PROVENANCE_NOTE].filter(Boolean).join("");',
    '    const append2 = [clientContext, cwdNote, passthrough ? "\\n\\n<meridian-note>Read Git state with the client tools when needed. Use conversation history and your previous tool results to distinguish your changes from pre-existing work.</meridian-note>" : GIT_STATUS_PROVENANCE_NOTE, REPLAY_PROVENANCE_NOTE].filter(Boolean).join("");',
  ],
];

export const MERIDIAN_168_EDITS = [...MERIDIAN_168_HANDOFF_EDITS, ...MERIDIAN_168_PREFIX_EDITS];
