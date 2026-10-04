import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import {
  classifyForm,
  formQuestionFields,
  projectFormList,
  toV1PermissionReplied,
  toV1PermissionRequest,
  toV1PermissionRequests,
  toV1QuestionRejected,
  toV1QuestionReplied,
  toV1QuestionRequest,
  toV2FormAnswer,
  toV2PermissionReply,
  toV2PermissionRequest,
  toV2QuestionForm,
} from './interaction.js';

const readVector = (name) => JSON.parse(
  readFileSync(new URL(`../__vectors__/${name}`, import.meta.url), 'utf8'),
);

const frameData = (vector) => vector.frames
  .filter((frame) => frame.startsWith('data: '))
  .map((frame) => JSON.parse(frame.slice('data: '.length)));

const framesOfType = (vector, type) => frameData(vector).filter((frame) => frame.type === type);

const restBody = (vector, label) => {
  const entry = vector.rest.find((rest) => rest.label === label);
  if (!entry) throw new Error(`missing rest ${label}`);
  return entry.body;
};

const formVector = readVector('05-question-form.json');
const permissionVector = readVector('06-permission.json');

const [questionForm, typedForm, externalForm] = framesOfType(formVector, 'form.created').map((frame) => frame.data.form);
const [questionReplied, typedReplied] = framesOfType(formVector, 'form.replied').map((frame) => frame.data);
const [externalCancelled] = framesOfType(formVector, 'form.cancelled').map((frame) => frame.data);

describe('forms -> v1 questions (05-question-form vector)', () => {
  it('projects the question tool form exactly', () => {
    expect(toV1QuestionRequest(questionForm)).toEqual({
      id: 'frm_000000000001normalized0000',
      sessionID: 'ses_fffffffffffenormalized0000',
      questions: [
        {
          question: 'Pick a color?',
          header: 'Color',
          options: [{ label: 'Red', description: 'warm' }, { label: 'Blue', description: 'cool' }],
          custom: true,
        },
        {
          question: 'Pick sizes?',
          header: 'Sizes',
          options: [{ label: 'S', description: 'small' }, { label: 'M', description: 'medium' }],
          multiple: true,
          custom: true,
        },
      ],
      tool: { messageID: 'msg_000000000002normalized0000', callID: 'call_s05_question' },
    });
  });

  it('maps every typed field, not only question-kind forms', () => {
    const request = toV1QuestionRequest(typedForm);
    expect(request?.tool).toBeUndefined();
    expect(request?.questions).toEqual([
      { question: 'Free text', header: 'Free text', options: [], custom: true },
      { question: 'Choice', header: 'Choice', options: [{ label: 'A', description: '' }, { label: 'B', description: '' }], custom: false },
      { question: 'Number', header: 'Number', options: [], custom: true },
      { question: 'Integer', header: 'Integer', options: [], custom: true },
      {
        question: 'Flag',
        header: 'Flag',
        options: [{ label: 'Yes', description: '' }, { label: 'No', description: '' }],
        custom: false,
      },
      { question: 'Many', header: 'Many', options: [{ label: 'X', description: '' }, { label: 'Y', description: '' }], multiple: true, custom: false },
    ]);
  });

  it('cancels a form with an external field and never leaks its URL', () => {
    const classified = classifyForm(externalForm);
    expect(classified).toEqual({
      action: 'cancel',
      formID: 'frm_000000000003normalized0000',
      sessionID: 'ses_fffffffffffenormalized0000',
      diagnostic: {
        code: 'opencode_v2_form_unsupported',
        reason: 'external_field',
        formID: 'frm_000000000003normalized0000',
        sessionID: 'ses_fffffffffffenormalized0000',
        fieldKeys: ['connect'],
      },
    });
    expect(JSON.stringify(classified)).not.toContain('example.invalid');
    expect(toV1QuestionRequest(externalForm)).toBeNull();
  });

  it('splits pending form lists into questions and forms to cancel', () => {
    const pending = projectFormList(restBody(formVector, 'form.list.pending').data);
    expect(pending.questions).toEqual([toV1QuestionRequest(questionForm)]);
    expect(pending.cancel).toEqual([]);

    const external = projectFormList(restBody(formVector, 'form.list.external').data);
    expect(external.questions).toEqual([]);
    expect(external.cancel.map((entry) => entry.formID)).toEqual(['frm_000000000003normalized0000']);
    expect(projectFormList([null, { id: 'frm_x' }]).ignored).toHaveLength(2);
    expect(projectFormList(undefined)).toEqual({ questions: [], cancel: [], ignored: [] });
  });

  it('cancels forms with no askable or unknown fields', () => {
    const base = { id: 'frm_1', sessionID: 'ses_1', title: 't' };
    expect(classifyForm({ ...base, fields: [{ key: 'h', type: 'string', hidden: true }] }))
      .toMatchObject({ action: 'cancel', diagnostic: { reason: 'no_fields' } });
    expect(classifyForm({ ...base, fields: [{ key: 'z', type: 'future' }] }))
      .toMatchObject({ action: 'cancel', diagnostic: { reason: 'invalid_field', fieldKeys: ['z'] } });
    expect(classifyForm({ fields: [] })).toMatchObject({ action: 'ignore', diagnostic: { reason: 'invalid_form' } });
  });

  it('skips hidden fields so answers stay index-aligned with questions', () => {
    const form = {
      id: 'frm_1',
      sessionID: 'ses_1',
      title: 't',
      fields: [
        { key: 'a', type: 'string', hidden: true },
        { key: 'b', type: 'string', title: 'B' },
      ],
    };
    expect(formQuestionFields(form).map((field) => field.key)).toEqual(['b']);
    expect(toV2FormAnswer(form, [['typed']])).toEqual({ ok: true, answer: { b: 'typed' } });
  });
});

describe('v1 question reply -> v2 Form.Answer', () => {
  it('reproduces the recorded question-tool reply', () => {
    const request = /** @type {{ answer: unknown }} */ (formVector.rest
      .find((rest) => rest.label === 'session.form.reply').request);
    expect(toV2FormAnswer(questionForm, [['Red'], ['S', 'M']])).toEqual({ ok: true, answer: request.answer });
  });

  it('reproduces the recorded typed-form reply from v1 labels', () => {
    const request = /** @type {{ answer: unknown }} */ (formVector.rest
      .find((rest) => rest.label === 'session.form.reply.typed').request);
    const result = toV2FormAnswer(typedForm, [['hello'], ['A'], ['1.5'], ['2'], ['Yes'], ['X']]);
    expect(result).toEqual({ ok: true, answer: request.answer });
  });

  it('keeps custom answers when the field allows them and rejects them otherwise', () => {
    expect(toV2FormAnswer(questionForm, [['Green'], ['L']])).toEqual({ ok: true, answer: { q0: 'Green', q1: ['L'] } });
    expect(toV2FormAnswer(typedForm, [['x'], ['Z']])).toMatchObject({ ok: false, code: 'invalid_answer', key: 'c' });
  });

  it('validates boolean, number and integer answers', () => {
    expect(toV2FormAnswer(typedForm, [[], [], ['abc']])).toMatchObject({ ok: false, key: 'n' });
    expect(toV2FormAnswer(typedForm, [[], [], [], ['2.5']])).toMatchObject({ ok: false, key: 'i' });
    expect(toV2FormAnswer(typedForm, [[], [], [], [], ['maybe']])).toMatchObject({ ok: false, key: 'b' });
    expect(toV2FormAnswer(typedForm, [[], [], [], [], ['no']])).toEqual({ ok: true, answer: { b: false } });
  });

  it('omits unanswered optional fields and enforces required ones', () => {
    expect(toV2FormAnswer(typedForm, [])).toEqual({ ok: true, answer: {} });
    const form = { id: 'frm_1', sessionID: 'ses_1', title: 't', fields: [{ key: 'r', type: 'string', required: true }] };
    expect(toV2FormAnswer(form, [[]])).toMatchObject({ ok: false, code: 'invalid_answer', key: 'r' });
    expect(toV2FormAnswer(form, 'nope')).toMatchObject({ ok: false, code: 'invalid_answer' });
    expect(toV2FormAnswer(form, ['nope'])).toMatchObject({ ok: false, key: 'r' });
  });

  it('leaves out fields made inactive by when-conditions', () => {
    const form = {
      id: 'frm_1',
      sessionID: 'ses_1',
      title: 't',
      fields: [
        { key: 'kind', type: 'string', options: [{ value: 'a', label: 'Alpha' }, { value: 'b', label: 'Beta' }] },
        { key: 'detail', type: 'string', when: [{ key: 'kind', op: 'eq', value: 'b' }] },
        { key: 'tags', type: 'multiselect', options: [{ value: 't1', label: 'T1' }] },
        { key: 'extra', type: 'string', when: [{ key: 'tags', op: 'neq', value: 't1' }] },
      ],
    };
    expect(toV2FormAnswer(form, [['Alpha'], ['ignored'], ['T1'], ['ignored too']]))
      .toEqual({ ok: true, answer: { kind: 'a', tags: ['t1'] } });
    expect(toV2FormAnswer(form, [['Beta'], ['kept'], [], ['kept too']]))
      .toEqual({ ok: true, answer: { kind: 'b', detail: 'kept' } });
  });

  it('refuses to answer a form that must be cancelled', () => {
    expect(toV2FormAnswer(externalForm, [['x']])).toMatchObject({ ok: false, code: 'unsupported_form' });
  });
});

describe('form events -> v1 question events', () => {
  it('maps form.replied with the form back to the labels the card showed', () => {
    expect(toV1QuestionReplied(questionReplied, questionForm)).toEqual({
      sessionID: 'ses_fffffffffffenormalized0000',
      requestID: 'frm_000000000001normalized0000',
      answers: [['Red'], ['S', 'M']],
    });
    expect(toV1QuestionReplied(typedReplied, typedForm)?.answers)
      .toEqual([['hello'], ['A'], ['1.5'], ['2'], ['Yes'], ['X']]);
  });

  it('reads q<i> keys in order when the form is unknown', () => {
    expect(toV1QuestionReplied(questionReplied)?.answers).toEqual([['Red'], ['S', 'M']]);
    expect(toV1QuestionReplied({ id: 'frm_1', sessionID: 's', answer: { q1: true } })?.answers).toEqual([[], ['Yes']]);
    expect(toV1QuestionReplied({ sessionID: 's' })).toBeNull();
  });

  it('maps form.cancelled to question.rejected', () => {
    expect(toV1QuestionRejected(externalCancelled)).toEqual({
      sessionID: 'ses_fffffffffffenormalized0000',
      requestID: 'frm_000000000003normalized0000',
    });
    expect(toV1QuestionRejected(null)).toBeNull();
  });

  it('round-trips a v1 question through the question-tool form shape', () => {
    const request = toV1QuestionRequest(questionForm);
    expect(toV2QuestionForm(request)).toEqual(questionForm);
    expect(toV2QuestionForm({ id: 'q', sessionID: 's', questions: [] })).toBeNull();
  });
});

describe('permissions (06-permission vector)', () => {
  const [asked, askedRejected] = framesOfType(permissionVector, 'permission.asked').map((frame) => frame.data);
  const replies = framesOfType(permissionVector, 'permission.replied').map((frame) => frame.data);

  it('projects permission.asked to the v1 request with edit aliases', () => {
    const patch = asked.metadata.files[0].patch;
    expect(toV1PermissionRequest(asked)).toEqual({
      id: 'per_000000000001normalized0000',
      sessionID: 'ses_fffffffffffenormalized0000',
      permission: 'edit',
      patterns: ['notes.txt'],
      metadata: { files: asked.metadata.files, filepath: 'notes.txt', diff: patch },
      always: ['*'],
      tool: { messageID: 'msg_000000000002normalized0000', callID: 'call_s06_write' },
    });
  });

  it('projects the pending lists identically to the event', () => {
    const fromList = toV1PermissionRequests(restBody(permissionVector, 'permission.request.list.pending').data);
    const fromSession = toV1PermissionRequests(restBody(permissionVector, 'session.permission.list.pending').data);
    expect(fromList).toEqual([toV1PermissionRequest(asked)]);
    expect(fromSession).toEqual(fromList);
    expect(toV1PermissionRequests([null, { id: 'per_x' }])).toEqual([]);
  });

  it('renames v2 tool actions and defaults absent lists', () => {
    expect(toV1PermissionRequest({ id: 'per_1', sessionID: 's', action: 'shell', resources: ['ls'] })).toEqual({
      id: 'per_1', sessionID: 's', permission: 'bash', patterns: ['ls'], metadata: {}, always: [],
    });
  });

  it('passes permission.replied through after validation', () => {
    expect(replies.map(toV1PermissionReplied)).toEqual([
      { sessionID: 'ses_fffffffffffenormalized0000', requestID: 'per_000000000001normalized0000', reply: 'once' },
      { sessionID: 'ses_fffffffffffenormalized0000', requestID: 'per_000000000002normalized0000', reply: 'reject' },
    ]);
    expect(toV1PermissionReplied({ sessionID: 's', requestID: 'r', reply: 'later' })).toBeNull();
  });

  it('maps a v1 reply body to the recorded v2 decision bodies', () => {
    const once = permissionVector.rest.find((rest) => rest.label === 'session.permission.reply.once').request;
    const reject = permissionVector.rest.find((rest) => rest.label === 'session.permission.reply.reject').request;
    expect(toV2PermissionReply({ reply: 'once' })).toEqual({ ok: true, body: once });
    expect(toV2PermissionReply({ reply: 'reject', message: 'not now' })).toEqual({ ok: true, body: reject });
    expect(toV2PermissionReply({ response: 'always' })).toEqual({ ok: true, body: { decision: 'always' } });
    expect(toV2PermissionReply({ reply: 'maybe' })).toMatchObject({ ok: false, code: 'invalid_reply' });
  });

  it('round-trips the recorded requests through the reverse helper', () => {
    expect(toV2PermissionRequest(toV1PermissionRequest(asked))).toEqual(asked);
    expect(toV2PermissionRequest(toV1PermissionRequest(askedRejected))).toEqual(askedRejected);
  });
});
