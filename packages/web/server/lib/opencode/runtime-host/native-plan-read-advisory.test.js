import { describe, expect, it } from 'vitest';
import { createNativePlanReadAdvisory, PLAN_READ_ADVISORY_THRESHOLD } from './native-plan-read-advisory.js';

const scope = { sessionID: 'ses_root', directory: '/project' };
function fixture({ readOnly = true, tasks = [{ agent: 'explorer', status: 'completed', createdAt: 200 }], enabled } = {}) {
  const journal = [], state = { tasks, objectiveID: 'msg_objective', policyReads: 0 };
  const advise = createNativePlanReadAdvisory({
    readManagedState: async () => ({ tasks: state.tasks }),
    readPrimaryRecord: async sessionID => ({ sessionID, directory: '/project', anchorID: state.objectiveID }),
    readPlanPolicy: async () => { state.policyReads++; return { readOnly }; },
    readObjectiveStart: async ({ objectiveID }) => (objectiveID === 'msg_objective' ? 100 : 300),
    recordDiagnostic: entry => journal.push(entry),
    ...(enabled ? { enabled } : {}),
  });
  return { advise, journal, state };
}
const reads = async (advise, count, tool = 'read') => {
  const results = [];
  for (let index = 0; index < count; index++) results.push(await advise({ ...scope, tool }));
  return results;
};

describe('plan-mode read advisory', () => {
  it('advises from the fourth plan-mode read or grep after a settled Explorer and journals every count', async () => {
    const { advise, journal, state } = fixture();
    const results = await reads(advise, 5, 'grep');
    expect(results.slice(0, PLAN_READ_ADVISORY_THRESHOLD - 1)).toEqual([undefined, undefined, undefined]);
    expect(results[3]).toMatchObject({ code: 'plan_mode_reread_after_explorer', count: 4 });
    expect(results[4]).toMatchObject({ count: 5 });
    expect(journal.map(entry => [entry.event, entry.payload.count, entry.payload.tool])).toEqual(
      [1, 2, 3, 4, 5].map(count => ['plan_mode_read_after_explorer', count, 'grep']));
    expect(state.policyReads).toBe(1);
  });

  it.each([
    ['normal mode', { readOnly: false }],
    ['no Explorer', { tasks: [{ agent: 'fixer', status: 'completed', createdAt: 200 }] }],
    ['a running Explorer', { tasks: [{ agent: 'explorer', status: 'running', createdAt: 200 }] }],
    ['an Explorer from an earlier objective', { tasks: [{ agent: 'explorer', status: 'completed', createdAt: 50 }] }],
    ['the kill switch', { enabled: () => false }],
  ])('stays silent for %s', async (_name, options) => {
    const { advise, journal } = fixture(options);
    expect(await reads(advise, 6)).toEqual(Array(6).fill(undefined));
    expect(journal).toEqual([]);
  });

  it('ignores other tools, restarts the count for a new objective and never throws', async () => {
    const { advise, state } = fixture();
    expect(await advise({ ...scope, tool: 'glob' })).toBeUndefined();
    await reads(advise, 3);
    state.objectiveID = 'msg_next_objective';
    state.tasks = [{ agent: 'explorer', status: 'completed', createdAt: 400 }];
    expect(await reads(advise, 3)).toEqual([undefined, undefined, undefined]);
    expect(await advise({ ...scope, tool: 'read' })).toMatchObject({ count: 4 });
    const failing = createNativePlanReadAdvisory({ readManagedState: async () => { throw Error('scheduler unavailable'); },
      readPrimaryRecord: async () => null, readPlanPolicy: async () => ({}), readObjectiveStart: async () => 0 });
    expect(await failing({ ...scope, tool: 'read' })).toBeUndefined();
  });
});
