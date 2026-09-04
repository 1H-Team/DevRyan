import { describe, expect, it } from 'vitest';

import { createSseDiffStripper } from './proxy.js';

const encoder = new TextEncoder();

const diffEntry = (index) => ({
  file: `src/file-${index}.ts`,
  status: 'modified',
  additions: index,
  deletions: 1,
  patch: `@@ -1 +1 @@\n-old-${index}\n+new-${index}`,
  before: `old-${index}`,
  after: `new-${index}`,
  from: `old-${index}`,
  to: `new-${index}`,
});

const messageUpdatedEvent = ({ directory = null, id = 'msg_1', diffs = 2 } = {}) => {
  const payload = {
    type: 'message.updated',
    properties: {
      info: {
        id,
        role: 'user',
        sessionID: 'ses_1',
        summary: {
          additions: 3,
          deletions: 2,
          files: diffs,
          diffs: Array.from({ length: diffs }, (_, index) => diffEntry(index)),
        },
      },
    },
  };
  return directory ? { directory, payload } : payload;
};

const runAll = (stripper, chunks) => chunks.map((chunk) => stripper.push(chunk)).join('') + stripper.flush();

const parseBlocks = (text) => text
  .split('\n\n')
  .filter((block) => block.length > 0)
  .map((block) => {
    const data = block.split('\n').filter((line) => line.startsWith('data:')).map((line) => line.slice(5).trim()).join('\n');
    return { block, data: data ? JSON.parse(data) : null };
  });

describe('createSseDiffStripper', () => {
  it('strips diff bodies from a message.updated block and keeps id/event lines', () => {
    const stripper = createSseDiffStripper();
    const block = `id: evt-1\nevent: message\ndata: ${JSON.stringify(messageUpdatedEvent())}\n\n`;

    const output = runAll(stripper, [encoder.encode(block)]);

    expect(output.startsWith('id: evt-1\nevent: message\ndata: ')).toBe(true);
    expect(output.endsWith('\n\n')).toBe(true);
    const [parsed] = parseBlocks(output);
    expect(parsed.data.type).toBe('message.updated');
    expect(parsed.data.properties.info.summary).toEqual({
      additions: 3,
      deletions: 2,
      files: 2,
      diffs: [
        { file: 'src/file-0.ts', status: 'modified', additions: 0, deletions: 1 },
        { file: 'src/file-1.ts', status: 'modified', additions: 1, deletions: 1 },
      ],
    });
    for (const field of ['patch', 'before', 'after', 'from', 'to']) {
      expect(output).not.toContain(`"${field}"`);
    }
  });

  it('strips inside the /global/event envelope and keeps the directory', () => {
    const stripper = createSseDiffStripper();
    const block = `data: ${JSON.stringify(messageUpdatedEvent({ directory: '/work/repo' }))}\n\n`;

    const [parsed] = parseBlocks(runAll(stripper, [block]));

    expect(parsed.data.directory).toBe('/work/repo');
    expect(parsed.data.payload.properties.info.summary.diffs).toEqual([
      { file: 'src/file-0.ts', status: 'modified', additions: 0, deletions: 1 },
      { file: 'src/file-1.ts', status: 'modified', additions: 1, deletions: 1 },
    ]);
    expect(parsed.block).not.toContain('"patch"');
  });

  it('reassembles JSON split across chunks, including a multi-byte character at the cut', () => {
    const stripper = createSseDiffStripper();
    const event = messageUpdatedEvent();
    event.properties.info.summary.diffs[0].file = 'src/naïve-é.ts';
    const bytes = encoder.encode(`data: ${JSON.stringify(event)}\n\n`);
    // Cut inside the multi-byte "ï" and again a few bytes later.
    const cutAt = Buffer.from(bytes).indexOf(Buffer.from('ï')) + 1;
    const chunks = [bytes.subarray(0, cutAt), bytes.subarray(cutAt, cutAt + 7), bytes.subarray(cutAt + 7)];

    const outputs = chunks.map((chunk) => stripper.push(chunk));
    // Nothing leaves before the block is complete.
    expect(outputs[0]).toBe('');
    expect(outputs[1]).toBe('');
    const [parsed] = parseBlocks(outputs[2] + stripper.flush());
    expect(parsed.data.properties.info.summary.diffs[0]).toEqual({
      file: 'src/naïve-é.ts', status: 'modified', additions: 0, deletions: 1,
    });
  });

  it('finds a block boundary split across two chunks', () => {
    const stripper = createSseDiffStripper();
    const block = `data: ${JSON.stringify(messageUpdatedEvent())}\n`;

    expect(stripper.push(block)).toBe('');
    const output = stripper.push('\n');
    expect(output.endsWith('\n\n')).toBe(true);
    expect(output).not.toContain('"patch"');
    expect(stripper.flush()).toBe('');
  });

  it('normalises CRLF blocks, even when the CR sits at a chunk edge', () => {
    const stripper = createSseDiffStripper();
    const event = JSON.stringify(messageUpdatedEvent());
    const chunks = [`id: evt-9\r\ndata: ${event}\r`, `\n\r\n`];

    const output = runAll(stripper, chunks);

    expect(output).toBe(`id: evt-9\ndata: ${JSON.stringify({
      ...messageUpdatedEvent(),
      properties: { info: { ...messageUpdatedEvent().properties.info, summary: {
        additions: 3, deletions: 2, files: 2,
        diffs: [
          { file: 'src/file-0.ts', status: 'modified', additions: 0, deletions: 1 },
          { file: 'src/file-1.ts', status: 'modified', additions: 1, deletions: 1 },
        ],
      } } },
    })}\n\n`);
  });

  it('passes heartbeats, comments and blocks without diffs through byte-for-byte', () => {
    const stripper = createSseDiffStripper();
    const partUpdated = JSON.stringify({
      type: 'message.part.updated',
      properties: { part: { id: 'prt_1', type: 'text', text: 'hello' } },
    });
    const chunks = [
      ':heartbeat\n\n',
      `id: evt-2\ndata: ${partUpdated}\n\n`,
      'data: {"type":"server.heartbeat","properties":{}}\n\n',
    ];

    expect(runAll(stripper, chunks)).toBe(chunks.join(''));
  });

  it('leaves a block untouched when its data only mentions "diffs" in text, or is not JSON', () => {
    const stripper = createSseDiffStripper();
    const textPart = JSON.stringify({
      type: 'message.part.updated',
      properties: { part: { type: 'text', text: 'the "diffs" key and "patch": "x" appear in prose' } },
    });
    const chunks = [
      `data: ${textPart}\n\n`,
      'data: {"diffs": not json\n\n',
      'event: ping\n\n',
    ];

    expect(runAll(stripper, chunks)).toBe(chunks.join(''));
  });

  it('forwards the partial tail unparsed on stream end', () => {
    const stripper = createSseDiffStripper();
    const partial = 'data: {"type":"message.updated","properties":{"info":{"summary":{"diffs":[{"patch":"x"';

    expect(stripper.push(partial)).toBe('');
    expect(stripper.flush()).toBe(partial);
  });

  it('streams an oversized block through verbatim instead of buffering it', () => {
    const stripper = createSseDiffStripper({ maxBlockChars: 64 });
    const huge = `data: ${JSON.stringify(messageUpdatedEvent({ diffs: 4 }))}`;
    const first = huge.slice(0, 80);
    const rest = `${huge.slice(80)}\n\n`;
    const next = `data: ${JSON.stringify(messageUpdatedEvent({ id: 'msg_2', diffs: 1 }))}\n\n`;

    const firstOut = stripper.push(first);
    const restOut = stripper.push(rest);
    const nextOut = stripper.push(next);

    expect(firstOut).toBe(first);
    expect(restOut).toBe(rest);
    // The block after the oversized one is parsed and trimmed again.
    expect(nextOut).not.toContain('"patch"');
    expect(parseBlocks(nextOut)[0].data.properties.info.id).toBe('msg_2');
    expect(stripper.flush()).toBe('');
  });

  it('keeps the original block when the strip callback throws', () => {
    const stripper = createSseDiffStripper({ strip: () => { throw new Error('boom'); } });
    const block = `data: ${JSON.stringify(messageUpdatedEvent())}\n\n`;

    expect(runAll(stripper, [block])).toBe(block);
  });
});
