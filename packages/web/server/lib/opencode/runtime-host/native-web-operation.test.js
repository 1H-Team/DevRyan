import { describe, expect, it } from 'vitest';

import { nativeWebOperation } from './native-web-operation.js';

const spec = (method, path, extra = {}) => ({ operation: 'questions.reply', method, path, directory: '/repo', ...extra });

describe('nativeWebOperation', () => {
  it('binds session form effects to the path session', () => {
    expect(nativeWebOperation(spec('POST', '/api/session/ses_a/form/frm_1/reply', { body: { answer: { q0: 'x' } } }))).toEqual({
      sessionID: 'ses_a', directory: '/repo', effects: [{ operation: 'form.reply', input: { id: 'frm_1', answer: { q0: 'x' } } }],
    });
    expect(nativeWebOperation(spec('DELETE', '/api/session/ses_a/form/frm_1'))).toEqual({
      sessionID: 'ses_a', directory: '/repo', effects: [{ operation: 'form.cancel', input: { id: 'frm_1' } }],
    });
  });

  it('binds a global MCP elicitation form to its attributed session only', () => {
    expect(nativeWebOperation(spec('POST', '/api/session/global/form/frm_1/reply', { body: { answer: { count: 3 } }, elicitationSessionID: 'ses_owner' })))
      .toEqual({ sessionID: 'ses_owner', directory: '/repo', effects: [{ operation: 'form.reply', input: { id: 'frm_1', answer: { count: 3 } } }] });
    expect(nativeWebOperation(spec('DELETE', '/api/session/global/form/frm_1', { elicitationSessionID: 'ses_owner' })))
      .toEqual({ sessionID: 'ses_owner', directory: '/repo', effects: [{ operation: 'form.cancel', input: { id: 'frm_1' } }] });
  });

  it('refuses a global form without a real attributed session or outside form effects', () => {
    for (const elicitationSessionID of [undefined, '', 'global', 'ses/../x', 'prj_x']) {
      expect(() => nativeWebOperation(spec('POST', '/api/session/global/form/frm_1/reply', { body: { answer: {} }, elicitationSessionID })))
        .toThrow(expect.objectContaining({ code: 'native_web_operation_unavailable' }));
    }
    for (const [method, path] of [['POST', '/api/session/global/prompt'], ['POST', '/api/session/global/form/frm_1'],
      ['PATCH', '/api/session/global'], ['POST', '/api/session/global/permission/per_1/reply']]) {
      expect(() => nativeWebOperation(spec(method, path, { body: {}, elicitationSessionID: 'ses_owner' })))
        .toThrow(expect.objectContaining({ code: 'native_web_operation_unavailable' }));
    }
  });
});
