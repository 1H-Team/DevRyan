import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { gradeCompactionRetention, gradeManagedTaskAcceptance, gradeQaProject } from './acceptance-graders.mjs';
import { createQaProjectFixture, removeQaProjectFixture } from './project-fixture.mjs';

const edit = (fixture, file, change) => {
  const target = path.join(fixture.fixtureRoot,file);
  writeFileSync(target,change(readFileSync(target,'utf8')));
};
const dispose = (fixture) => { removeQaProjectFixture(fixture); rmSync(fixture.evidenceDirectory,{recursive:true,force:true}); };
const repair = (fixture) => {
  edit(fixture,'src/tasks.mjs',(source) => source
    .replace("  return { id, title:", "  const priority = Object.hasOwn(input, 'priority') ? input.priority : 'normal';\n  if (!['low','normal','high'].includes(priority)) throw new Error('Invalid priority');\n  return { priority, id, title:")
    .replace('const completed = tasks.filter','const completed = active.filter')
    .replace("  return tasks.map((task) => task.id === event.id ? { ...task, ...event.patch, id: task.id, revision: event.revision } : task);",
      "  if (Object.hasOwn(event.patch, 'priority') && !['low','normal','high'].includes(event.patch.priority)) throw new Error('Invalid priority');\n  return tasks.map((task) => task.id === event.id && event.revision > task.revision ? { ...task, ...event.patch, id: task.id, revision: event.revision } : task);"));
  edit(fixture,'src/store.mjs',(source) => source.replace("  let pending = Promise.resolve();", "  tasks = tasks.map(task => ({priority:'normal', ...task}));\n  let pending = Promise.resolve();"));
};

test('independent probes detect seed defects and accept actual domain/API/restart repairs', () => {
  const fixture = createQaProjectFixture({runId:'grader-contract'});
  try {
    const baseline = gradeQaProject({fixture,phase:'baseline'});
    assert.equal(baseline.passed,false);
    assert.equal(baseline.checks.find((item) => item.id === 'project.summary').passed,false);
    assert.equal(baseline.checks.find((item) => item.id === 'project.monotonic-events').passed,false);
    assert.equal(baseline.checks.find((item) => item.id === 'project.priority-domain').passed,false);
    repair(fixture);
    const candidate = gradeQaProject({fixture,phase:'implemented'});
    assert.equal(candidate.passed,true,JSON.stringify(candidate.checks));
    // Deliberate fault after GREEN proves the executable contract catches regressions.
    edit(fixture,'src/tasks.mjs',(source) => source.replace('const completed = active.filter','const completed = tasks.filter'));
    const fault = gradeQaProject({fixture,phase:'implemented'});
    assert.equal(fault.checks.find((item) => item.id === 'project.summary').passed,false);
    assert.equal(fault.checks.find((item) => item.id === 'project.http-and-restart').passed,false);
  } finally { dispose(fixture); }
});

test('plan grading requires a saved plan and catches implementation edits, not just test outcomes', () => {
  const fixture = createQaProjectFixture({runId:'plan-contract'});
  try {
    assert.equal(gradeQaProject({fixture,phase:'plan'}).passed,false);
    mkdirSync(path.join(fixture.fixtureRoot,'.opencode/plans'),{recursive:true});
    writeFileSync(path.join(fixture.fixtureRoot,'.opencode/plans/task.md'),'Revision 2: preserve creation order and add a priority filter.\n');
    assert.equal(gradeQaProject({fixture,phase:'plan'}).passed,true);
    edit(fixture,'src/tasks.mjs',(source) => source + '\n// Implementation changed during planning.\n');
    assert.equal(gradeQaProject({fixture,phase:'plan'}).checks.find((item) => item.id === 'project.plan-only').passed,false);
  } finally { dispose(fixture); }
});

test('host-owned plan evidence must be a real nonempty matching file in the owned evidence directory', () => {
  const fixture = createQaProjectFixture({runId:'host-plan-contract'});
  try {
    const content = 'Host saved plan revision 2: implement the priority filter and preserve creation order.\n';
    const file = path.join(fixture.evidenceDirectory,'saved-plan.md');
    writeFileSync(file,content);
    const savedPlan = {path:file,sha256:createHash('sha256').update(content).digest('hex')};
    assert.equal(gradeQaProject({fixture,phase:'plan',savedPlan}).passed,true);
    assert.equal(gradeQaProject({fixture,phase:'plan',savedPlan:{...savedPlan,sha256:'0'.repeat(64)}}).passed,false);
    assert.equal(gradeQaProject({fixture,phase:'plan',savedPlan:{...savedPlan,path:path.join(fixture.fixtureRoot,'README.md')}}).passed,false);
    writeFileSync(file,'');
    assert.equal(gradeQaProject({fixture,phase:'plan',savedPlan}).passed,false);
  } finally { dispose(fixture); }
});

test('successful implementation cannot hide overwritten user edits or weakened public tests', () => {
  const fixture = createQaProjectFixture({runId:'preservation-contract'});
  try {
    repair(fixture);
    writeFileSync(path.join(fixture.fixtureRoot,'test/tasks.test.mjs'),'// removed tests\n');
    writeFileSync(path.join(fixture.fixtureRoot,'docs/user-notes.md'),'Replaced\n');
    const result = gradeQaProject({fixture,phase:'implemented'});
    assert.equal(result.passed,false);
    assert.equal(result.checks.find((item) => item.id === 'project.user-edit-and-requirements').passed,false);
    assert.equal(result.checks.find((item) => item.id === 'project.original-tests-retained').passed,false);
    assert.equal(result.checks.find((item) => item.id === 'project.http-and-restart').passed,true);
  } finally { dispose(fixture); }
});

const managed = () => ({
  rootSessionId:'ses_parent',childSessionIds:['ses_child'],activeBarriers:[],dispatches:[{taskId:'task_one',childSessionId:'ses_child'}],
  snapshot:{available:true,tasks:[{taskId:'task_one',rootSessionId:'ses_parent',childSessionId:'ses_child',status:'completed'}],
    resultEnvelopes:[{taskId:'task_one',status:'completed',action:'continue'}]},
});
test('managed acceptance requires exact tasks/results, cleared barriers, and matching unique dispatches', () => {
  assert.equal(gradeManagedTaskAcceptance(managed()).passed,true);
  const duplicate = managed(); duplicate.dispatches.push({...duplicate.dispatches[0]});
  assert.equal(gradeManagedTaskAcceptance(duplicate).passed,false);
  const unrelated = managed(); unrelated.dispatches[0].taskId = 'task_other';
  assert.equal(gradeManagedTaskAcceptance(unrelated).passed,false);
  const barrier = managed(); barrier.activeBarriers.push('barrier_one');
  assert.equal(gradeManagedTaskAcceptance(barrier).passed,false);
  const incomplete = managed(); incomplete.snapshot.resultEnvelopes[0].action = 'pending';
  assert.equal(gradeManagedTaskAcceptance(incomplete).passed,false);
});

const retention = () => ({
  mode:'natural',
  boundaries:[1,2].map((index) => ({source:'opencode',eventId:`event_${index}`,summaryMessageId:`msg_${index}`,
    trigger:'threshold',requestKind:'none',observedAt:1000 * index,contextBefore:190000,thresholdTokens:180000})),
  expected:{objectiveRevision:'rev_2',planRevision:'plan_2',phase:'implementation',repositoryHead:'a'.repeat(40),
    preservedFileHashes:{'docs/user-notes.md':'b'.repeat(64)},remainingTaskIds:['task_pending'],completedActionIds:['diagnose'],
    rejectedActionIds:['priority_sort'],requiredBehaviorCheckIds:['project.priority-domain','project.persistence']},
  observed:{objectiveRevision:'rev_2',planRevision:'plan_2',phase:'implementation',repositoryHead:'a'.repeat(40),
    preservedFileHashes:{'docs/user-notes.md':'b'.repeat(64)},remainingTaskIds:['task_pending'],performedActionIds:['priority_filter'],
    behaviorChecks:[{id:'project.priority-domain',passed:true,evidenceId:'grade_1'},{id:'project.persistence',passed:true,evidenceId:'grade_2'}]},
});
test('compaction retention requires two observed native boundaries and authoritative behavior evidence', () => {
  assert.equal(gradeCompactionRetention(retention()).passed,true);
  const manualAuto = retention(); manualAuto.boundaries[0].requestKind = 'manual-auto';
  assert.equal(gradeCompactionRetention(manualAuto).checks[0].passed,false);
  const missingSummary = retention(); delete missingSummary.boundaries[0].summaryMessageId;
  assert.equal(gradeCompactionRetention(missingSummary).checks[0].passed,false);
  const short = retention(); short.boundaries = short.boundaries.slice(0,1);
  assert.equal(gradeCompactionRetention(short).checks[0].passed,false);
  const belowThreshold = retention(); belowThreshold.boundaries[1].contextBefore = 20;
  assert.equal(gradeCompactionRetention(belowThreshold).checks[0].passed,false);
  const mixed = retention(); mixed.boundaries[1].source = 'provider-adapter';
  assert.equal(gradeCompactionRetention(mixed).checks[0].passed,false);
  const manual = retention(); manual.mode = 'manual'; manual.boundaries.forEach((boundary) => {boundary.trigger='manual';boundary.requestKind='manual';});
  assert.equal(gradeCompactionRetention(manual).passed,true);
});

test('compaction recaps cannot pass forgotten revisions, work, rejected approaches, or failed continuation', () => {
  for (const mutate of [
    (value) => {value.observed.planRevision='plan_1';},
    (value) => {value.observed.remainingTaskIds=[];},
    (value) => {value.observed.performedActionIds.push('diagnose');},
    (value) => {value.observed.performedActionIds.push('priority_sort');},
    (value) => {value.observed.preservedFileHashes['docs/user-notes.md']='c'.repeat(64);},
    (value) => {value.observed.behaviorChecks[0].passed=false;},
    (value) => {value.observed.behaviorChecks.pop();},
  ]) {
    const value = retention(); mutate(value); assert.equal(gradeCompactionRetention(value).passed,false);
  }
});
