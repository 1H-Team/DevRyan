import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { BOT_CHUNK_LIMITS, chunkBotText } from './chunker.js';

describe('deterministic Bot index chunking', () => {
  test('normalizes line endings and chooses stable semantic boundaries with overlap', () => {
    const text = `${'alpha '.repeat(90)}\r\n\r\n${'beta '.repeat(90)}\r\n${'gamma '.repeat(90)}`;
    const first = chunkBotText(text, { maxChars: 320, overlapChars: 48 });
    const second = chunkBotText(text, { maxChars: 320, overlapChars: 48 });
    assert.deepEqual(first, second);
    assert.ok(first.length > 3);
    assert.deepEqual(first.map(({ ordinal }) => ordinal), first.map((_, index) => index));
    assert.ok(first.every(({ text: value, bytes }) => (
      !value.includes('\r') && bytes === Buffer.byteLength(value, 'utf8')
    )));
    assert.ok(first.slice(1).every((chunk, index) => chunk.start < first[index].end));
  });

  test('does not split surrogate pairs and returns no chunk for blank input', () => {
    const chunks = chunkBotText(`start ${'🙂'.repeat(300)} end`, {
      maxChars: 256,
      overlapChars: 32,
    });
    assert.ok(chunks.length > 1);
    assert.ok(chunks.every(({ text }) => {
      const first = text.charCodeAt(0);
      const last = text.charCodeAt(text.length - 1);
      return !(first >= 0xdc00 && first <= 0xdfff)
        && !(last >= 0xd800 && last <= 0xdbff);
    }));
    assert.deepEqual(chunkBotText(' \r\n '), []);
  });

  test('fails closed on source, overlap, and expansion caps', () => {
    assert.throws(() => chunkBotText('x', { maxChars: 255, overlapChars: 0 }), {
      code: 'bot_indexer_chunk_invalid',
    });
    assert.throws(() => chunkBotText('x', { maxChars: 256, overlapChars: 129 }), {
      code: 'bot_indexer_chunk_invalid',
    });
    assert.throws(() => chunkBotText('x'.repeat(BOT_CHUNK_LIMITS.maxSourceBytes + 1)), {
      code: 'bot_indexer_chunk_limit',
      statusCode: 413,
    });
  });
});
