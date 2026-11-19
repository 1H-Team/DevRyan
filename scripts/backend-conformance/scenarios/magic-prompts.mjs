// The pilot's scenarios (BH2; design file 31 §4.2, §9 "Why magic-prompts"):
// the four routes of packages/web/server/lib/magic-prompts/routes.js, as the
// server registers them through the feature routes (groups.mjs).
//
// Principal classes the managed policy distinguishes for this group: the local
// administrator (every route); a managed administrator (every route); a
// managed member such as a developer (GET only: PUT and DELETE are refused by
// the policy gate); and an unauthenticated request from outside loopback (the
// tunnel boundary refuses it, an edge exchange). The reference produces the
// first and the last; the managed classes need the Supabase-backed runtime,
// so their steps are waived on the reference with that reason (design §6).
import fs from 'node:fs';
import path from 'node:path';
import { PRINCIPALS, defineScenario, jsonBody, rawBody, step } from '../scenario.mjs';

const principals = Object.fromEntries(['local-admin', 'managed-admin', 'managed-developer', 'remote-unauthenticated'].map((name) => [name, PRINCIPALS[name]]));
const JSON_TYPE = [['Content-Type', 'application/json']];
const BASE = '/api/magic-prompts';
const MANAGED_WAIVER = { outcome: 'inconclusive', checks: ['principal-unavailable'], reason: 'managed principals need the Supabase-backed runtime, which the reference group host does not run (design §6, pilot scope; inventory B12)' };
const DEPRECATED = ['git.commit.draft.visible', 'git.commit.draft.instructions', 'git.commit.plan.visible', 'git.commit.plan.instructions'];

const get = (principal = 'local-admin', extra = {}) => ({ method: 'GET', target: BASE, principal, ...extra });
const put = (id, body, principal = 'local-admin', headers = JSON_TYPE) => ({ method: 'PUT', target: `${BASE}/${id}`, headers, body, principal });
const del = (id, principal = 'local-admin') => ({ method: 'DELETE', target: id === null ? BASE : `${BASE}/${id}`, principal });

/** The data file as the runtime writes it. */
const promptFile = (overrides) => `${JSON.stringify({ version: 1, overrides }, null, 2)}`;

/** Reads and writes for each principal class, the value matrices, validation failures and the edge-answered cases. */
export const READS_AND_WRITES = defineScenario({
  id: 'magic-prompts.reads-and-writes', group: 'magic-prompts',
  description: 'every route for each principal class, the id, text and body matrices, validation failures, malformed JSON and a remote request',
  principals,
  fixture: () => {},
  steps: (v) => {
    const visible = v.id('id.visible', 'git.pr.generate.visible');
    const instructions = v.id('id.instructions', 'git.pr.generate.instructions');
    const longest = v.id('id.160', 'a'.repeat(160));
    const tooLong = v.id('id.161', 'b'.repeat(161));
    const upper = v.id('id.upper', 'Git.PR.Generate.Visible');
    const text = v.text('text.first', 'Write the PR description.');
    const second = v.text('text.second', 'Write it shorter.');
    const longText = v.text('text.200000', 'x'.repeat(200_000));
    const overLong = v.text('text.200001', 'y'.repeat(200_001));
    const managedText = v.text('text.managed', 'managed edit');
    return [
      step.exchange('get-empty', get()),
      step.exchange('put-visible', put(visible, jsonBody({ text }))),
      step.exchange('get-after-put', get()),
      step.exchange('put-replace', put(visible, jsonBody({ text: second }))),
      step.exchange('put-id-160', put(longest, jsonBody({ text }))),
      step.exchange('put-id-161', put(tooLong, jsonBody({ text }))),
      step.exchange('put-id-upper', put(upper, jsonBody({ text }))),
      step.exchange('put-id-space', put(`%20${instructions}`, jsonBody({ text }))),
      ...DEPRECATED.map((id, index) => step.exchange(`put-deprecated-${index + 1}`, put(v.id(`id.deprecated.${index + 1}`, id), jsonBody({ text })))),
      step.exchange('put-visible-blank', put(visible, jsonBody({ text: v.text('text.blank', '   ') }))),
      step.exchange('put-text-empty', put(instructions, jsonBody({ text: v.text('text.empty', '') }))),
      step.exchange('put-text-200000', put(instructions, jsonBody({ text: longText }))),
      step.exchange('put-text-200001', put(instructions, jsonBody({ text: overLong }))),
      step.exchange('put-text-number', put(instructions, jsonBody({ text: 12 }))),
      step.exchange('put-body-array', put(instructions, jsonBody([text]))),
      // The shared JSON parser is strict: a body that is not an object or array never reaches the group.
      step.exchange('put-body-null', { ...put(instructions, rawBody('null')), edge: true }),
      step.exchange('put-text-lone-surrogate', put(instructions, rawBody(`{"text":"${v.text('text.lone-surrogate-escape', '\\ud800')}"}`))),
      step.exchange('put-duplicate-keys', put(instructions, rawBody(`{"text":"${v.text('text.duplicate-first', 'a')}","text":"${v.text('text.duplicate-second', 'b')}"}`))),
      step.exchange('put-text-2-53-plus-1', put(instructions, rawBody(`{"text":${v.text('text.2-53-plus-1', '9007199254740993')}}`))),
      // Non-UTF-8 bytes, registered as their latin1 text (one character per byte).
      step.exchange('put-non-utf8', put(instructions, rawBody(`{"text":"${v.text('text.non-utf8', '\xff\xfe')}"}`, 'latin1'))),
      step.exchange('put-text-plain', put(instructions, rawBody(`{"text":"${v.text('text.plain', 'plain')}"}`), 'local-admin', [['Content-Type', 'text/plain']])),
      step.exchange('put-malformed-json', { ...put(instructions, rawBody('{"text":')), edge: true }),
      step.exchange('get-remote', { ...get('remote-unauthenticated'), edge: true }),
      step.exchange('put-remote', { ...put(visible, jsonBody({ text })), principal: 'remote-unauthenticated', edge: true }),
      step.exchange('get-managed-admin', get('managed-admin')),
      step.exchange('put-managed-admin', put(visible, jsonBody({ text: managedText }), 'managed-admin')),
      step.exchange('get-managed-developer', get('managed-developer')),
      step.exchange('put-managed-developer', put(visible, jsonBody({ text: managedText }), 'managed-developer')),
      step.exchange('delete-managed-developer', del(visible, 'managed-developer')),
      step.exchange('delete-one', del(visible)),
      step.exchange('delete-absent', del(visible)),
      step.exchange('delete-invalid', del(upper)),
      step.exchange('get-before-reset', get()),
      step.exchange('delete-all', del(null)),
      step.exchange('get-after-reset', get()),
    ];
  },
  waivers: Object.fromEntries(['get-managed-admin', 'put-managed-admin', 'get-managed-developer', 'put-managed-developer', 'delete-managed-developer'].map((id) => [id, MANAGED_WAIVER])),
});

/** The write lock: concurrent PUTs, and a PUT with a DELETE of the same id (§5.6). */
export const WRITE_LOCK = defineScenario({
  id: 'magic-prompts.write-lock', group: 'magic-prompts',
  description: 'concurrent writes, each judged against every order the reference produces one at a time',
  principals,
  fixture: (root, v) => { fs.writeFileSync(path.join(root, 'magic-prompts.json'), promptFile({ 'git.commit.generate.visible': v.text('text.seeded', 'seeded'), 'git.commit.draft.visible': v.text('text.deprecated-filtered', 'deprecated, filtered on read') })); },
  steps: (v) => {
    const first = v.id('id.first', 'git.pr.generate.visible');
    const other = v.id('id.other', 'git.commit.generate.visible');
    return [
      step.exchange('get-seeded', get()),
      step.concurrent('two-puts', [['first', put(first, jsonBody({ text: v.text('text.first', 'first writer') }))], ['other', put(other, jsonBody({ text: v.text('text.other', 'other writer') }))]]),
      step.concurrent('put-and-delete', [['put', put(first, jsonBody({ text: v.text('text.again', 'written again') }))], ['delete', del(first)]]),
      step.exchange('get-after', get()),
    ];
  },
});

/** State across a restart, a file changed under the arm, and kills after a write and during one (§5.4). */
export const RESTARTS = defineScenario({
  id: 'magic-prompts.restarts', group: 'magic-prompts',
  description: 'a restart between a write and a read, external edits, a kill after a write and a kill during one',
  principals,
  fixture: () => {},
  steps: (v) => {
    const id = v.id('id.visible', 'git.pr.generate.visible');
    return [
      step.exchange('put', put(id, jsonBody({ text: v.text('text.before', 'before the restart') }))),
      step.restart('restart'),
      step.exchange('get-after-restart', get()),
      step.external('external-edit', { op: 'write', path: 'magic-prompts.json', data: Buffer.from(promptFile({ [id]: v.text('text.external', 'written by someone else') })) }),
      step.exchange('get-after-external', get()),
      step.external('external-malformed', { op: 'write', path: 'magic-prompts.json', data: Buffer.from(v.text('text.malformed-file', '{not json')) }),
      step.exchange('get-malformed-file', get()),
      step.exchange('put-over-malformed', put(id, jsonBody({ text: v.text('text.repair', 'repaired') }))),
      step.killAfter('kill-after-write', 'response-end', put(id, jsonBody({ text: v.text('text.killed-after', 'answered, then killed') }))),
      step.exchange('get-after-kill', get()),
      step.killAfter('kill-during-write', 'request-sent', put(id, jsonBody({ text: v.text('text.killed-during', 'killed while it was written') }))),
      step.exchange('get-after-kill-during', get()),
      step.external('external-delete', { op: 'delete', path: 'magic-prompts.json' }),
      step.exchange('get-after-delete', get()),
    ];
  },
});

export const SCENARIOS = Object.freeze([READS_AND_WRITES, WRITE_LOCK, RESTARTS]);
