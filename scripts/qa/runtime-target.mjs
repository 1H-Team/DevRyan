// Checks against the OpenCode version live QA qualifies. The target itself is
// resolved only by resolveQaTargetOpenCodeVersion (version-policy.js): the host
// pin by default, or the explicit DEVRYAN_QA_OPENCODE_VERSION candidate so a
// runtime is qualified before the pin moves. Evidence records which applied.
import fs from 'node:fs';
import { openCodeBaseVersion } from '../../packages/web/server/lib/opencode/opencode-update-runtime.js';
import { resolveQaTargetOpenCodeVersion, SUPPORTED_NATIVE_OPENCODE_VERSIONS } from '../../packages/web/server/lib/opencode/version-policy.js';
import { resolveLoopbackOpenCodeFixtureGeneration } from '../perf/loopback-opencode-fixtures.mjs';

const describeTarget = target => target.source === 'host-pin' ? 'the pinned runtime' : `the ${target.source} candidate`;

// Fixture launches follow the same QA version target as live qualification.
// An explicit generation is checked before a fixture can launch;
// it never changes the production pin or starts an installed OpenCode runtime.
export function resolveQaFixtureGeneration(generation, target = resolveQaTargetOpenCodeVersion()) {
  if (generation !== undefined) return resolveLoopbackOpenCodeFixtureGeneration(generation);
  const base = typeof target?.version === 'string' ? openCodeBaseVersion(target.version) : '';
  if (SUPPORTED_NATIVE_OPENCODE_VERSIONS.includes(base)) return 2;
  throw new Error('QA fixture target must name the verified 2.0.20, 2.0.24 or 2.0.26 transport, or explicitly select generation 2');
}

// Compare the exact native runtime release, permitting its branded build suffix.
export function assertQaCandidateRuntimeVersion(observed, target = resolveQaTargetOpenCodeVersion()) {
  if (typeof target?.version !== 'string' || !target.version || typeof target.source !== 'string') {
    throw new Error('QA runtime target must name an exact version and its source');
  }
  const observedBase = typeof observed === 'string' ? openCodeBaseVersion(observed) : null;
  if (observedBase !== target.version) {
    const expected = `${describeTarget(target)} ${target.version}`;
    throw new Error(observed === undefined || observed === null || observed === ''
      ? `Candidate OpenCode version is unavailable; expected ${expected}`
      : `Candidate OpenCode version ${JSON.stringify(String(observed))} does not match ${expected}`);
  }
  return { version: target.version, source: target.source };
}

// The retained plugin SDK is a pure tool compatibility dependency. It is pinned
// by the package manifest rather than inferred from the runnable runtime version.
export function qaPluginSdkVersionForRuntime(version) {
  const base = typeof version === 'string' ? openCodeBaseVersion(version.trim()) : '';
  if (!/^2\.\d+\.\d+(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/.test(base)) {
    throw new Error(`Plugin SDK lookup requires an exact OpenCode version 2, got ${JSON.stringify(version)}`);
  }
  const manifest = JSON.parse(fs.readFileSync(new URL('../../packages/web/package.json', import.meta.url), 'utf8'));
  const pin = manifest.devDependencies?.['@opencode-ai/plugin'];
  if (typeof pin !== 'string' || !/^\d+\.\d+\.\d+$/.test(pin)) throw new Error('Missing exact compatibility plugin SDK pin');
  return pin;
}
