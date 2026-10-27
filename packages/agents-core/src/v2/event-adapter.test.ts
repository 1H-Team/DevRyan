import { describe, expect, test } from 'bun:test';
import { mapV2EventToV1 } from './event-adapter';

const SESSION = 'ses_attributed00000000000000';
const event = (type: string, data: Record<string, unknown>) => ({ type, data });
const synthesized = (input: Record<string, unknown>) => mapV2EventToV1(input).slice(1);
const elicitation = (id: string, devryan?: Record<string, unknown>) => ({
  form: {
    id,
    sessionID: 'global',
    title: 'linear is requesting input',
    metadata: { kind: 'mcp-elicitation', server: 'linear', message: 'Team?', ...(devryan ? { devryan } : {}) },
    fields: [{ key: 'team', type: 'string', title: 'Team' }],
  },
});

describe('form events -> v1 question lifecycle', () => {
  test('a host-attributed MCP elicitation asks, replies and rejects under its session', () => {
    expect(synthesized(event('form.created', elicitation('frm_e1', { sessionID: SESSION, messageID: 'msg_1', callID: 'call_1' })))).toEqual([{
      type: 'question.asked',
      properties: { id: 'frm_e1', sessionID: SESSION, questions: [{ question: 'Team', header: 'Team', options: [] }] },
    }]);
    expect(synthesized(event('form.replied', { id: 'frm_e1', sessionID: 'global', answer: { team: 'core' } }))).toEqual([{
      type: 'question.replied', properties: { sessionID: SESSION, requestID: 'frm_e1', answers: [['core']] },
    }]);
    // Resolution consumed the attribution: a replay cannot reach the session again.
    expect(synthesized(event('form.replied', { id: 'frm_e1', sessionID: 'global', answer: {} }))).toEqual([]);

    synthesized(event('form.created', elicitation('frm_e2', { sessionID: SESSION })));
    expect(synthesized(event('form.cancelled', { id: 'frm_e2', sessionID: 'global' }))).toEqual([{
      type: 'question.rejected', properties: { sessionID: SESSION, requestID: 'frm_e2' },
    }]);
  });

  test('an unattributed or forged global form is never synthesized', () => {
    for (const devryan of [undefined, { sessionID: 'global' }, { sessionID: 42 }]) {
      expect(synthesized(event('form.created', elicitation('frm_u', devryan)))).toEqual([]);
    }
    const otherKind = { form: { ...elicitation('frm_k', { sessionID: SESSION }).form, metadata: { kind: 'probe', devryan: { sessionID: SESSION } } } };
    expect(synthesized(event('form.created', otherKind))).toEqual([]);
    expect(synthesized(event('form.cancelled', { id: 'frm_u', sessionID: 'global' }))).toEqual([]);
    expect(synthesized(event('form.replied', { id: 'frm_unknown', sessionID: 'global', answer: {} }))).toEqual([]);
  });

  test('session forms keep their own session', () => {
    expect(synthesized(event('form.created', { form: { id: 'frm_s', sessionID: 'ses_owner', title: 'Questions',
      fields: [{ key: 'q0', type: 'string', title: 'Pick' }] } }))[0]).toMatchObject({ type: 'question.asked', properties: { sessionID: 'ses_owner' } });
    expect(synthesized(event('form.cancelled', { id: 'frm_s', sessionID: 'ses_owner' }))).toEqual([{
      type: 'question.rejected', properties: { sessionID: 'ses_owner', requestID: 'frm_s' },
    }]);
  });
});
