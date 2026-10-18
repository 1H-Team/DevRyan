// Stable identities shared by deterministic v2 UI and performance fixtures.
export const PERF_PARENT_SESSION_ID = 'ses_perfparent';
export const PERF_CHILD_SESSION_IDS = Object.freeze(['ses_perfchild1', 'ses_perfchild2', 'ses_perfchild3']);
// Root sessions seeded only on request, so the twelve-stream resource workload
// does not change the four-session fixture every other scenario uses.
export const PERF_EXTRA_STREAM_SESSION_IDS = Object.freeze(Array.from({ length: 8 }, (_, index) => `ses_perfextra${index + 1}`));
