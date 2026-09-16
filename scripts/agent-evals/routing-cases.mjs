// Evaluation-only fixtures: role expectations never enter the model's prompt.
export const ROUTING_CASES = Object.freeze({
  'routing-visual': { agent: 'designer', approved: false },
  'routing-approved-visual': { agent: 'designer', approved: true },
  'routing-behavior': { agent: 'fixer', approved: false },
});

export const isRoutingCase = (caseId) => Object.hasOwn(ROUTING_CASES, caseId);

export const routingSource = `export const rowStyle = '.service-row{display:flex;gap:4px}.service-pills{display:flex;gap:2px}.service-type{background:green;color:white}';
export function servicePills(needsReview) {
  return (needsReview ? '<span>Needs Review</span>' : '') + '<span class="service-type">Procedure</span>';
}
export function priceLabel(price) {
  return price ? String(price) : 'Add Price';
}
`;

export const routingTest = (caseId, sourceFilename) => `import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
const source = await readFile(new URL('./${sourceFilename}', import.meta.url), 'utf8');
const { rowStyle, servicePills, priceLabel } = await import('data:text/javascript;base64,' + Buffer.from(source).toString('base64'));
test('preserves service content and pricing', () => {
  assert.equal(priceLabel(null), 'Add Price');
  assert.equal(priceLabel(125), '125');
  assert.match(servicePills(false), /Procedure/);
  assert.doesNotMatch(servicePills(false), /Needs Review/);
});
${caseId === 'routing-behavior' ? `test('zero is a price, without changing presentation', () => {
  assert.equal(priceLabel(0), '0');
  assert.equal(rowStyle, ${JSON.stringify(routingSource.match(/rowStyle = '(.*)';/)[1])});
  assert.equal(servicePills(true), '<span>Needs Review</span><span class="service-type">Procedure</span>');
});` : `test('implements the specified row and pill presentation', () => {
  assert.match(rowStyle, /\\.service-row\\s*\\{[^}]*gap:\\s*24px/);
  assert.match(rowStyle, /\\.service-pills\\s*\\{[^}]*gap:\\s*8px/);
  assert.match(rowStyle, /\\.service-type\\s*\\{[^}]*background:\\s*(?:white|#fff(?:fff)?)[;}]/);
  assert.match(rowStyle, /\\.service-type\\s*\\{[^}]*color:\\s*(?:#333|#333333)[;}]/);
  assert.ok(servicePills(true).indexOf('Procedure') < servicePills(true).indexOf('Needs Review'));
  assert.equal(priceLabel(0), 'Add Price'); // Behavior is outside this visual assignment.
});`}
`;

export const buildRoutingDefinition = (caseId, runFiles) => {
  const scenario = ROUTING_CASES[caseId];
  if (!scenario) throw new TypeError(`Unknown routing case: ${caseId}`);
  const scope = `The service-list fixture is ${runFiles.sourceRelativePath}; its acceptance test is ${runFiles.testRelativePath}.`;
  const change = scenario.agent === 'designer'
    ? 'Improve the cluttered service-list presentation: set service-row gap to 24px, service-pills gap to 8px, make the service-type pill white with #333 text, and place Procedure before Needs Review when present. Preserve labels and pricing behavior.'
    : 'Fix priceLabel so a zero price displays 0 instead of Add Price. Preserve all existing spacing, pill colors, markup, and ordering.';
  const execution = `Use one managed implementation specialist through devryan_task; choose its role using your routing rules. Supply the exact owned file and acceptance criteria. Wait and disposition the result with continue. Modify only ${runFiles.sourceRelativePath}; preserve the test and all other files. Run node --test ${runFiles.testRelativePath}. This fixture tests routing and source contracts, not browser rendering; no browser or external service is required.`;
  return {
    caseId,
    prompt: scenario.approved
      ? `${scope} ${change} Make a plan only, without editing files or dispatching implementation. Include these acceptance criteria and this execution constraint in the plan: ${execution}`
      : `${scope} ${change} Implement now; no planning approval is needed. ${execution}`,
    ...(scenario.approved ? { followUpPrompt: 'implement plan' } : {}),
  };
};
