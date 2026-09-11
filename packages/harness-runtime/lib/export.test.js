import { describe, expect, test } from 'bun:test';

import { createDiagnosticsExport, writeDiagnosticsZip } from './export.js';
import { createDiagnosticSanitizer } from './sanitizer.js';

const readStream = async (stream) => {
  let output = '';
  for await (const chunk of stream) output += chunk.toString();
  return output;
};

describe('diagnostics export preparation', () => {
  test('writes bundle v2 with per-session NDJSON, runtime records, manifests, and plain blobs', async () => {
    const records = [
      {
        type: 'open_code_event',
        at: 1,
        directory: '/repo',
        sessionID: 'child',
        payload: {
          type: 'session.created',
          properties: { info: { id: 'child', parentID: 'root' } },
        },
      },
      { type: 'prompt', at: 2, directory: '/repo', sessionID: 'root', payload: { text: 'root' } },
      {
        type: 'prompt',
        at: 3,
        directory: '/repo',
        sessionID: 'child',
        payload: {
          text: {
            type: 'blob',
            path: `sessions/child/blobs/${'a'.repeat(64)}.txt.gz`,
          },
        },
      },
      { type: 'log', at: 4, directory: '/repo', payload: { text: 'runtime' } },
      { type: 'prompt', at: 5, directory: '/other', sessionID: 'unrelated', payload: { text: 'skip' } },
      { type: 'lifecycle', event: 'objective_state', at: 6, directory: '/repo', sessionID: 'root',
        payload: { messageID: 'msg_root', state: 'completed', createdAt: 1 } },
      { type: 'lifecycle', event: 'objective_state', at: 6, directory: '/other', sessionID: 'unrelated',
        payload: { messageID: 'msg_unrelated', state: 'completed', createdAt: 1 } },
    ];
    const sanitizer = createDiagnosticSanitizer({ knownSecrets: ['second-pass-secret'] });
    const bundle = await createDiagnosticsExport({
      scope: { scope: 'task', sessionID: 'root', directory: '/repo' },
      sanitizer,
      now: () => 123,
      journal: {
        readRecords: async () => records,
        readBlob: async () => 'second-pass-secret blob',
        listSessionManifests: async () => [
          { version: 1, sessionID: 'root', title: 'Root' },
          { version: 1, sessionID: 'child', title: 'Child' },
        ],
      },
      receipts: [{ directory: '/repo', metadata: { sessionID: 'child' } }],
      evidence: [{ sessionID: 'child', checkpointID: 'chk_1' }],
    });

    expect(bundle.manifest).toMatchObject({
      version: 2,
      includedSessionIDs: ['child', 'root'],
      runtimeRecordCount: 1,
    });
    expect(bundle.files.map((file) => file.name)).toEqual(expect.arrayContaining([
      'sessions/child.ndjson',
      'sessions/root.ndjson',
      'sessions/index.json',
      'runtime.ndjson',
      `blobs/sessions/child/blobs/${'a'.repeat(64)}.txt`,
    ]));
    const index = JSON.parse(bundle.files.find((file) => file.name === 'sessions/index.json').data);
    expect(index.sessions.map((entry) => entry.title).sort()).toEqual(['Child', 'Root']);
    const fileData = await Promise.all(bundle.files.map(async (file) => (
      typeof file.data === 'string' ? file.data : readStream(file.openStream())
    )));
    expect(fileData.join('\n')).not.toContain('second-pass-secret');
    const trace = JSON.parse(bundle.files.find((file) => file.name === 'DevRyan-trace.json').data);
    expect(trace.metadata.roots.map((root) => root.rootSessionId)).toEqual(['root']);
    expect(JSON.stringify(trace)).not.toContain('unrelated');
  });

  test('passes session, runtime, and blob entries to the ZIP writer as streams', async () => {
    const streamed = [];
    let buffered = 0;
    let ended = false;
    const bundle = await createDiagnosticsExport({
      scope: { scope: 'runtime' },
      sanitizer: createDiagnosticSanitizer(),
      journal: {
        listSegmentPaths: async () => ['/journal/segment.ndjson'],
        iterateRecords: async function* () {
          yield { type: 'control', at: 1, sessionID: 'ses_1', action: 'abort', payload: {} };
        },
        readRecords: () => {
          throw new Error('streaming export must not buffer all records');
        },
        readBlob: async () => '',
      },
    });

    await writeDiagnosticsZip(bundle, {
      createArchive: () => ({
        addBuffer() { buffered += 1; },
        addReadStream(stream, name) { streamed.push({ stream, name }); },
        end() { ended = true; },
      }),
    });

    expect(buffered).toBe(7); // Includes the bounded DevRyan Chrome Trace projection.
    expect(streamed.map((entry) => entry.name)).toEqual([
      'sessions/ses_1.ndjson',
      'runtime.ndjson',
    ]);
    expect(await readStream(streamed[0].stream)).toBe('{"type":"control","at":1,"sessionID":"ses_1","action":"abort","payload":{}}\n');
    expect(ended).toBe(true);
  });

  test('encodes traversal-like session ids in ZIP entry names', async () => {
    const bundle = await createDiagnosticsExport({
      scope: { scope: 'runtime' },
      sanitizer: createDiagnosticSanitizer(),
      journal: {
        readRecords: async () => [
          { type: 'prompt', at: 1, sessionID: '..', payload: {} },
        ],
      },
    });

    expect(bundle.files.map((file) => file.name)).toContain('sessions/%2E%2E.ndjson');
    expect(bundle.files.map((file) => file.name)).not.toContain('sessions/...ndjson');
  });
});

test('task export retains native-shaped managed timings and exact child scope from runtime records', async () => {
  const event = (rootSessionId, childSessionId) => ({ type: 'open_code_event', at: 60, sessionID: null, directory: null,
    payload: { type: 'openchamber:managed-task', properties: { owner: 'devryan',
      task: { owner: 'devryan', taskId: `task_${rootSessionId}`, rootSessionId, childSessionId,
        sequence: 1, status: 'completed', createdAt: 10, startedAt: 14, finishedAt: 40,
        childPromptedAt: 15, firstAssistantPartAt: 18 },
      resultEnvelope: { envelopeId: `envelope_${rootSessionId}`, createdAt: 41, acknowledgedAt: 51 } } } });
  const sanitizer = createDiagnosticSanitizer();
  const records = [event('root', 'child'), event('unrelated', 'other-child'),
    { type: 'prompt', at: 20, sessionID: 'child', directory: '/repo', payload: { text: 'included-child' } },
    { type: 'prompt', at: 20, sessionID: 'other-child', directory: '/repo', payload: { text: 'excluded-child' } }]
    .map(record => sanitizer.sanitizeRecord(record));
  const bundle = await createDiagnosticsExport({ scope: { scope: 'task', sessionID: 'root', directory: '/repo' },
    journal: { readRecords: async () => records } });
  expect(bundle.manifest.includedSessionIDs).toEqual(['child', 'root']);
  const trace = JSON.parse(bundle.files.find(file => file.name === 'DevRyan-trace.json').data);
  expect(trace.metadata.roots).toHaveLength(1);
  expect(trace.metadata.roots[0]).toMatchObject({ rootSessionId: 'root', measurements: {
    queueMs: { observed: 1, unknown: 0, total: 4 }, firstResponseMs: { observed: 1, unknown: 0, total: 3 },
    resultConsumptionMs: { observed: 1, unknown: 0, total: 10 } } });
  const rootRows = await readStream(bundle.files.find(file => file.name === 'sessions/root.ndjson').openStream());
  expect(rootRows).toContain('task_root'); expect(rootRows).not.toContain('unrelated');
  expect(bundle.files.some(file => file.name.includes('other-child') || file.name.includes('unrelated'))).toBe(false);
});
