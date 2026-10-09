export const TARGET_OPENCODE_VERSION = '2.0.26';

// Retained bundles use their matching compiled controller for rollback.
export const SUPPORTED_NATIVE_OPENCODE_VERSIONS = Object.freeze(['2.0.20', '2.0.24', TARGET_OPENCODE_VERSION]);

// The Bot runtime container image pins its own OpenCode build
// (packages/bots-runtime/docker/opencode/Dockerfile). The two roll independently:
// the host pin can move ahead while the container image waits for a rebuilt,
// re-verified release.
export const BOT_TARGET_OPENCODE_VERSION = '2.0.26';

const EXACT_VERSION = /^2\.\d+\.\d+(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

/**
 * The OpenCode version live QA expects the candidate runtime to report.
 *
 * QA can qualify a candidate runtime before the host pin moves (an upgrade is
 * qualified on the candidate, then the pin follows), so the target is
 * overridable, but only explicitly and only as an exact version. Evidence must
 * record `source` so a run against a non-pinned runtime is never mistaken for
 * a pin-verified one.
 */
export const resolveQaTargetOpenCodeVersion = (env = process.env) => {
  const raw = typeof env?.DEVRYAN_QA_OPENCODE_VERSION === 'string' ? env.DEVRYAN_QA_OPENCODE_VERSION.trim() : '';
  if (!raw) return { version: TARGET_OPENCODE_VERSION, source: 'host-pin' };
  if (!EXACT_VERSION.test(raw)) {
    throw new Error(`DEVRYAN_QA_OPENCODE_VERSION must be an exact OpenCode version in major 2, got ${JSON.stringify(raw)}`);
  }
  return { version: raw, source: 'DEVRYAN_QA_OPENCODE_VERSION' };
};
