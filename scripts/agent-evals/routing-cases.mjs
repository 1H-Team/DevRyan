// Evaluation-only fixtures: role expectations never enter the model's prompt.
export const ROUTING_CASES = Object.freeze({
  'routing-visual': { agent: 'designer', approved: false, kind: 'visual', explicit: true },
  'routing-approved-visual': { agent: 'designer', approved: true, kind: 'visual', explicit: true },
  'routing-direct-behavior': { agent: null, kind: 'behavior' },
  'routing-direct-visual': { agent: null, kind: 'visual' },
  'routing-substantial-design': { agent: 'designer', kind: 'visual' },
  'routing-footer-plan': { agent: null, kind: 'footer', readOnly: true },
  'routing-broad-discovery': { agent: 'explorer', kind: 'inventory', readOnly: true },
  'routing-behavior': { agent: 'fixer', approved: false, kind: 'behavior', explicit: true },
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
${ROUTING_CASES[caseId]?.kind === 'behavior' ? `test('zero is a price, without changing presentation', () => {
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
  if (scenario.kind === 'footer') return { caseId, prompt: 'The website footer Healthcare Services, Professionals and Medical Centers lists are empty even though active categories exist. Find the population code and make a concise plan to restore them. Plan only; do not edit files. Explain the observed cause and the regression checks needed.' };
  if (scenario.kind === 'inventory') return { caseId, prompt: 'Build a complete read-only usage map of the generated route inventory across identity, billing and session subsystems. Identify every elevated route and the ownership boundaries. Preserve all files. Finish with JSON counts using keys identity, billing, session and elevated.' };
  const scope = `The service-list fixture is ${runFiles.sourceRelativePath}; its acceptance test is ${runFiles.testRelativePath}.`;
  const change = scenario.kind === 'visual'
    ? 'Improve the cluttered service-list presentation: set service-row gap to 24px, service-pills gap to 8px, make the service-type pill white with #333 text, and place Procedure before Needs Review when present. Preserve labels and pricing behavior.'
    : 'Fix priceLabel so a zero price displays 0 instead of Add Price. Preserve all existing spacing, pill colors, markup, and ordering.';
  const delegation = scenario.explicit ? 'Use one managed implementation specialist through devryan_task; choose its role using your routing rules. Supply the exact owned file and acceptance criteria. Wait and disposition the result with continue. ' : '';
  const design = caseId === 'routing-substantial-design' ? 'Redesign the service-list hierarchy for desktop and mobile, including empty and review-needed states. Choose a coherent responsive presentation and implement its coupled markup and styles. ' : '';
  const execution = `${delegation}${design}Modify only ${runFiles.sourceRelativePath}; preserve the test and all other files. Run node --test ${runFiles.testRelativePath}. This fixture tests routing and source contracts, not browser rendering; no browser or external service is required.`;
  return {
    caseId,
    prompt: scenario.approved
      ? `${scope} ${change} Make a plan only, without editing files or dispatching implementation. Include these acceptance criteria and this execution constraint in the plan: ${execution}`
      : `${scope} ${change} Implement now; no planning approval is needed. ${execution}`,
    ...(scenario.approved ? { followUpPrompt: 'implement plan' } : {}),
  };
};

export const routingFixture = (caseId, filename) => {
  const kind = ROUTING_CASES[caseId]?.kind;
  if (kind === 'footer') return {
    source: `export function footerCategoryLinks(categories) {
  return categories.filter(category => category.active && category.publishedCount >= 5).slice(0, 4);
}
export const footerSections = ['Healthcare Services', 'Professionals', 'Medical Centers'];
`,
    test: `import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
const source = await readFile(new URL('./${filename}', import.meta.url), 'utf8');
const { footerCategoryLinks } = await import('data:text/javascript;base64,' + Buffer.from(source).toString('base64'));
assert.deepEqual(footerCategoryLinks([{active:true,publishedCount:2}]), []);
`,
  };
  if (kind === 'inventory') {
    const rows = Array.from({ length: 540 }, (_, i) => `  {id:'route${i}',domain:'${['identity','billing','session'][i % 3]}',elevated:${i % 4 === 0}},`).join('\n');
    return { source: `export const routingInventory = [\n${rows}\n];\n`,
      test: `import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
const source = await readFile(new URL('./${filename}', import.meta.url), 'utf8');
const { routingInventory } = await import('data:text/javascript;base64,' + Buffer.from(source).toString('base64'));
assert.equal(routingInventory.length,540);
` };
  }
  return { source: routingSource, test: routingTest(caseId, filename) };
};

// Retain only task-relevant booleans/counts, never the model's raw response.
export function collectRoutingEvidence(caseId, sessionTree, rootSessionId, sourceRelativePath) {
  const root = sessionTree.find(entry => entry.sessionId === rootSessionId);
  const text = (root?.messages ?? []).filter(message => message.info?.role === 'assistant')
    .flatMap(message => message.parts ?? []).filter(part => part.type === 'text').map(part => part.text ?? '').join('\n');
  if (ROUTING_CASES[caseId]?.kind === 'footer') return {
    located: Boolean(sourceRelativePath && text.includes(sourceRelativePath)),
    cause: /(?:count|threshold|minimum|>=|at least)[\s\S]{0,100}(?:5|five)|(?:5|five)[\s\S]{0,100}(?:count|threshold|minimum)/i.test(text),
    verification: /test|regression|verif/i.test(text),
  };
  if (ROUTING_CASES[caseId]?.kind === 'inventory') {
    for (const match of text.matchAll(/\{[^{}]+\}/g)) {
      try { const counts = JSON.parse(match[0]); if (['identity','billing','session','elevated'].every(key => Number.isSafeInteger(counts[key]))) return { counts: Object.fromEntries(['identity','billing','session','elevated'].map(key => [key, counts[key]])) }; } catch { /* Prose is not count evidence. */ }
    }
    return { counts: null };
  }
  return null;
}

// Observe canonical native timestamps; sum the union so nested task/tools do
// not double-count elapsed tool time. Retain no paths, inputs or output text.
export function collectRoutingMetrics(sessionTree, rootSessionId, sourcePath, startedAt, completedAt) {
  const intervals = [];
  let locatedAt = Infinity;
  for (const session of sessionTree) for (const message of session.messages ?? []) for (const part of message.parts ?? []) {
    const time = part.state?.time;
    if (part.type !== 'tool' || !Number.isFinite(time?.start) || !Number.isFinite(time?.end) || time.end < time.start) continue;
    intervals.push([Math.max(startedAt, time.start), time.end]);
    if (part.tool === 'read' && part.state.status === 'completed' && sourcePath
      && [part.state.input?.filePath, part.state.input?.path].includes(sourcePath)) locatedAt = Math.min(locatedAt, time.end);
  }
  intervals.sort((a, b) => a[0] - b[0]);
  let toolDurationMs = 0, end = startedAt;
  for (const [from, to] of intervals) { toolDurationMs += Math.max(0, to - Math.max(from, end)); end = Math.max(end, to); }
  return { componentLocationMs: Number.isFinite(locatedAt) ? Math.max(0, locatedAt - startedAt) : null,
    completionMs: completedAt - startedAt, toolDurationMs,
    childCount: sessionTree.filter(session => session.sessionId !== rootSessionId).length };
}
