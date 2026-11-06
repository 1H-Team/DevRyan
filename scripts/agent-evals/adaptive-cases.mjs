import { ROUTING_CASES, routingSource, routingTest } from './routing-cases.mjs';

// Delegation-arm expectations for live trials of the `adaptiveDelegation`
// policy. Evaluation-only: no expectation, owner or arm enters the prompt.
//
// The arm is never configured here. It is read from the evaluated run's own
// fingerprints (start and finish), so a run is graded against the routing
// branch its host actually rendered. A run without that evidence is held.

export const DELEGATION_ARMS = Object.freeze(['baseline', 'adaptive']);

const policyOf = (fingerprint) => (
  fingerprint?.schemaVersion === 1
  && fingerprint.policies !== null && typeof fingerprint.policies === 'object' && !Array.isArray(fingerprint.policies)
  && typeof fingerprint.policies.adaptiveDelegation === 'boolean'
    ? fingerprint.policies.adaptiveDelegation
    : null
);

/**
 * Selects the delegation arm from raw harness evidence. Both the start and the
 * finish fingerprint must carry a boolean `adaptiveDelegation` and agree;
 * anything else returns `{ arm: null, reason }` and the run is held.
 */
export const resolveDelegationArm = (harnessEvidence) => {
  const start = policyOf(harnessEvidence?.startFingerprint);
  const finish = policyOf(harnessEvidence?.finishFingerprint);
  if (start === null || finish === null) return Object.freeze({ arm: null, reason: 'policy_unattested' });
  if (start !== finish) return Object.freeze({ arm: null, reason: 'policy_changed_during_run' });
  return Object.freeze({ arm: start ? 'adaptive' : 'baseline', reason: null });
};

// Route shapes. `routing` grades with the existing routing graders and the
// given scenario object (for the baseline arm of an existing case this is the
// unchanged ROUTING_CASES entry). `direct` means the root implements: no
// implementation child, optional read-only companions, and, when
// `declaredChecks`, a completed root `devryan_task` `declare_checks` before the
// first edit. Every direct edit must be followed by a passing owned test run.
const routing = (scenario) => Object.freeze({ route: 'routing', scenario: Object.freeze({ ...scenario }) });
const direct = (options = {}) => Object.freeze({
  route: 'direct', declaredChecks: true, readOnly: false, companions: Object.freeze([]), maxChildren: 0,
  planTurnReadOnly: false, ...options,
});
const sameInBothArms = (alternatives) => Object.freeze({ baseline: Object.freeze(alternatives), adaptive: Object.freeze(alternatives) });

// The five existing cases whose expectations encode the specialists-by-default
// branch. Their baseline alternative is the unchanged ROUTING_CASES entry.
export const ARM_PINNED_ROUTING_CASES = Object.freeze({
  // Known one-file repair: adaptive implements directly after declare_checks.
  'routing-natural-behavior': Object.freeze({
    baseline: Object.freeze([routing(ROUTING_CASES['routing-natural-behavior'])]),
    adaptive: Object.freeze([direct()]),
  }),
  // Small fully specified visual change: adaptive "may be direct"; Designer
  // ownership (the baseline shape) remains acceptable.
  'routing-natural-visual': Object.freeze({
    baseline: Object.freeze([routing(ROUTING_CASES['routing-natural-visual'])]),
    adaptive: Object.freeze([direct(), routing(ROUTING_CASES['routing-natural-visual'])]),
  }),
  // Adaptive has no mechanical-edit exception: direct work declares checks.
  'routing-direct-typo': Object.freeze({
    baseline: Object.freeze([routing(ROUTING_CASES['routing-direct-typo'])]),
    adaptive: Object.freeze([direct()]),
  }),
  // Plan mode stays read-only in both arms; adaptive implements the approved
  // plan directly. A planning Explorer is the only permitted child.
  'routing-plan-mode-behavior': Object.freeze({
    baseline: Object.freeze([routing(ROUTING_CASES['routing-plan-mode-behavior'])]),
    adaptive: Object.freeze([direct({ companions: Object.freeze(['explorer']), maxChildren: 1, planTurnReadOnly: true })]),
  }),
  // Discovery routing is not policy-gated: Explorer-first in both arms.
  'routing-broad-discovery': sameInBothArms([routing(ROUTING_CASES['routing-broad-discovery'])]),
});

// New behaviour-matrix cases. Each states its expectation in both arms.
export const ADAPTIVE_CASES = Object.freeze({
  // An explicit specialist request outranks adaptive direct work.
  'adaptive-explicit-fixer': Object.freeze({
    kind: 'behavior',
    expectations: sameInBothArms([routing({ agent: 'fixer', kind: 'behavior', maxChildren: 2 })]),
  }),
  // A located question: at most one Explorer, nothing edited, exact answer.
  'adaptive-narrow-lookup': Object.freeze({
    kind: 'lookup',
    readOnly: true,
    expectations: sameInBothArms([direct({ declaredChecks: false, readOnly: true, companions: Object.freeze(['explorer']), maxChildren: 1 })]),
  }),
  // Observe a failed check, edit, and finish only on a passing check that
  // follows the last edit (an edit after a passing run must be re-verified).
  'adaptive-check-discipline': Object.freeze({
    kind: 'repair',
    checkOrder: true,
    expectations: Object.freeze({
      baseline: Object.freeze([routing({ agent: 'fixer', kind: 'repair', maxChildren: 2 })]),
      adaptive: Object.freeze([direct()]),
    }),
  }),
  // Two independent defects in disjoint files: parallel Fixers in one
  // dispatch, each editing, every result dispositioned. Not one cohesive
  // unit, so adaptive keeps specialists.
  'adaptive-independent-phases': Object.freeze({
    kind: 'phases',
    secondarySource: true,
    parallelStart: true,
    expectations: sameInBothArms([routing({ agent: 'fixer', kind: 'phases', maxChildren: 3, minOwners: 2 })]),
  }),
});

export const isAdaptiveCase = (caseId) => Object.hasOwn(ADAPTIVE_CASES, caseId);
export const isArmPinnedCase = (caseId) => Object.hasOwn(ARM_PINNED_ROUTING_CASES, caseId) || isAdaptiveCase(caseId);
export const delegationArmExpectations = (caseId) => (
  ARM_PINNED_ROUTING_CASES[caseId] ?? ADAPTIVE_CASES[caseId]?.expectations ?? null
);
export const runFileOptionsFor = (caseId) => (ADAPTIVE_CASES[caseId]?.secondarySource ? { secondarySource: true } : {});

const clampSource = `export function clampEvalValue(value, minimum, maximum) {
  if (value < minimum) return minimum;
  return value; // Intentional evaluation defect: values above maximum are not clamped.
}
`;

const priceSource = `export function priceLabel(price) {
  return price ? String(price) : 'Add Price';
}
`;

export const CLAMP_COMMENT = '// Clamps value into [minimum, maximum].';
const CLAMP_COMMENT_PATTERN = CLAMP_COMMENT.replace(/[.*+?^$()|[\]\\/{}]/g, '\\$&');
export const LOOKUP_ANSWER = Object.freeze({
  missingLabel: 'Add Price',
  line: routingSource.split('\n').findIndex(line => line.includes("'Add Price'")) + 1,
});

const loader = `import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
const load = async (name) => {
  const text = await readFile(new URL('./' + name, import.meta.url), 'utf8');
  return { text, module: await import('data:text/javascript;base64,' + Buffer.from(text).toString('base64')) };
};
`;

export const adaptiveFixture = (caseId, runFiles) => {
  const kind = ADAPTIVE_CASES[caseId]?.kind;
  const filename = runFiles.sourcePath.split(/[\\/]/).at(-1);
  if (kind === 'behavior') return { source: routingSource, test: routingTest(caseId, filename, 'behavior') };
  if (kind === 'lookup') return {
    source: routingSource,
    test: `${loader}const { module: { priceLabel, servicePills } } = await load(${JSON.stringify(filename)});
test('preserves the service-list contract', () => {
  assert.equal(priceLabel(null), 'Add Price');
  assert.equal(priceLabel(125), '125');
  assert.match(servicePills(false), /Procedure/);
});
`,
  };
  if (kind === 'repair') return {
    source: clampSource,
    test: `${loader}const { text, module: { clampEvalValue } } = await load(${JSON.stringify(filename)});
test('clamps values at both boundaries', () => {
  assert.equal(clampEvalValue(-2, 0, 10), 0);
  assert.equal(clampEvalValue(4, 0, 10), 4);
  assert.equal(clampEvalValue(14, 0, 10), 10);
});
test('documents the clamp contract directly above the function', () => {
  assert.match(text, /^${CLAMP_COMMENT_PATTERN}\\r?\\nexport function clampEvalValue\\b/m);
});
`,
  };
  if (kind === 'phases') {
    const secondary = runFiles.secondarySourcePath?.split(/[\\/]/).at(-1);
    if (!secondary) throw new TypeError(`${caseId} requires a secondary run-owned source file`);
    return {
      source: priceSource,
      secondarySource: clampSource,
      test: `${loader}const { module: { priceLabel } } = await load(${JSON.stringify(filename)});
const { module: { clampEvalValue } } = await load(${JSON.stringify(secondary)});
test('phase A: zero is a price', () => {
  assert.equal(priceLabel(0), '0');
  assert.equal(priceLabel(125), '125');
  assert.equal(priceLabel(null), 'Add Price');
});
test('phase B: clamps values at both boundaries', () => {
  assert.equal(clampEvalValue(-2, 0, 10), 0);
  assert.equal(clampEvalValue(4, 0, 10), 4);
  assert.equal(clampEvalValue(14, 0, 10), 10);
});
`,
    };
  }
  throw new TypeError(`Unknown adaptive case: ${caseId}`);
};

const NO_BROWSER = 'This fixture tests routing and source contracts, not browser rendering; no browser or external service is required.';

export const buildAdaptiveDefinition = (caseId, runFiles) => {
  const kind = ADAPTIVE_CASES[caseId]?.kind;
  const source = runFiles.sourceRelativePath, test = runFiles.testRelativePath;
  if (kind === 'behavior') return { caseId, prompt: [
    `The service-list fixture is ${source}; its acceptance test is ${test}.`,
    'Fix priceLabel so a zero price displays 0 instead of Add Price. Preserve all existing spacing, pill colors, markup, and ordering.',
    'Implement now; no planning approval is needed. Delegate this implementation to Fixer through devryan_task; do not edit files yourself.',
    `Modify only ${source}; preserve the test and all other files. Run node --test ${test}. ${NO_BROWSER}`,
  ].join(' ') };
  if (kind === 'lookup') return { caseId, prompt: [
    `In ${source}, find the exact string priceLabel returns when price is missing, and the 1-based line number of that return statement.`,
    'Do not edit, create or delete any file.',
    'Finish with this JSON object filled from the file: {"missingLabel":string,"line":number}.',
  ].join(' ') };
  if (kind === 'repair') return { caseId, prompt: [
    `In ${source}, clampEvalValue does not clamp values above maximum; its acceptance test is ${test}.`,
    `First run node --test ${test} and observe the failure.`,
    `Then fix the upper bound and add the comment line ${CLAMP_COMMENT} directly above the function.`,
    'Implement now; no planning approval is needed.',
    `Modify only ${source}; preserve the test and all other files. Finish only after node --test ${test} passes on the final content. ${NO_BROWSER}`,
  ].join(' ') };
  if (kind === 'phases') return { caseId, prompt: [
    'Two independent defects, in disjoint files with no shared state or interface:',
    `(1) in ${source}, priceLabel shows Add Price for a zero price; it must display 0.`,
    `(2) in ${runFiles.secondarySourceRelativePath}, clampEvalValue does not clamp values above maximum.`,
    `The acceptance test ${test} covers both. Implement now; no planning approval is needed.`,
    `Modify only ${source} and ${runFiles.secondarySourceRelativePath}; preserve the test and all other files. Run node --test ${test}. ${NO_BROWSER}`,
  ].join(' ') };
  throw new TypeError(`Unknown adaptive case: ${caseId}`);
};

// Retain only the parsed answer comparison, never the model's raw response.
export const collectAdaptiveEvidence = (caseId, sessionTree, rootSessionId) => {
  if (ADAPTIVE_CASES[caseId]?.kind !== 'lookup') return null;
  const root = (Array.isArray(sessionTree) ? sessionTree : []).find(entry => entry?.sessionId === rootSessionId);
  const text = (root?.messages ?? []).filter(message => message?.info?.role === 'assistant')
    .flatMap(message => message.parts ?? []).filter(part => part?.type === 'text').map(part => part.text ?? '').join('\n');
  let answer = null;
  for (const match of text.matchAll(/\{[^{}]+\}/g)) {
    try {
      const value = JSON.parse(match[0]);
      if (typeof value?.missingLabel === 'string' && Number.isSafeInteger(value.line)) answer = value;
    } catch { /* Prose is not answer evidence. */ }
  }
  return answer
    ? { answered: true, labelMatches: answer.missingLabel === LOOKUP_ANSWER.missingLabel, lineMatches: answer.line === LOOKUP_ANSWER.line }
    : { answered: false, labelMatches: false, lineMatches: false };
};
