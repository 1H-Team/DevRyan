import { describe, expect, test } from 'bun:test';
import {
  BOT_EVENT_MAX_BYTES, BOT_SNAPSHOT_MAX_BYTES, BOT_SNAPSHOT_PART_CHARS,
  createBotSnapshotAssembler, encodeBotSnapshot, splitBotSnapshot,
} from './event-snapshot.js';

const envelope = (payload, id = 'fixture:0') => ({ id, sequence: 0, kind: 'snapshot.part', payload });

describe('Bot snapshot transport', () => {
  test('measures escaped controls, surrogate pairs and lone surrogates before allocating JSON', () => {
    const text = Array.from({ length: 65_536 }, (_, code) => String.fromCharCode(code)).join('');
    const encoded = encodeBotSnapshot({ text, nested: [null, true, false, -0, 1e25, '\uD800', '\uDC00', '🧑🏽‍💻'] });
    expect(encoded.bytes).toBe(Buffer.byteLength(encoded.text));
    expect(() => encodeBotSnapshot({ text: '\u0000'.repeat(Math.ceil(BOT_SNAPSHOT_MAX_BYTES / 6)) }))
      .toThrow('too large');
    const overhead = Buffer.byteLength(JSON.stringify({ text: '' }));
    expect(encodeBotSnapshot({ text: 'x'.repeat(BOT_SNAPSHOT_MAX_BYTES - overhead) }).bytes)
      .toBe(BOT_SNAPSHOT_MAX_BYTES);
    expect(() => encodeBotSnapshot({ text: 'x'.repeat(BOT_SNAPSHOT_MAX_BYTES - overhead + 1) })).toThrow('too large');
  });

  test('delivers a large complete snapshot atomically in bounded Unicode-safe parts', () => {
    const snapshot = { channels: Array.from({ length: 1_200 }, (_, id) => ({ id, title: '界🧑🏽‍💻\\\"'.repeat(30) })) };
    const encoded = encodeBotSnapshot(snapshot);
    expect(encoded.bytes).toBe(Buffer.byteLength(encoded.text));
    expect(encoded.bytes).toBeGreaterThan(BOT_EVENT_MAX_BYTES);
    const parts = splitBotSnapshot(encoded.text);
    const assembler = createBotSnapshotAssembler();
    let complete = null;
    for (const [index, part] of parts.entries()) {
      expect(Buffer.byteLength(JSON.stringify(envelope(part)))).toBeLessThan(BOT_EVENT_MAX_BYTES);
      complete = assembler.push(envelope(part));
      if (index < parts.length - 1) expect(complete).toBeNull();
    }
    expect(complete).toEqual({ id: 'fixture:0', sequence: 0, kind: 'snapshot', payload: snapshot });
  });

  test('rejects oversized graphs before serialization and never invokes accessors', () => {
    expect(() => encodeBotSnapshot({ text: 'x'.repeat(BOT_SNAPSHOT_MAX_BYTES + 1) })).toThrow('too large');
    let accessed = false;
    expect(() => encodeBotSnapshot({ get text() { accessed = true; return 'secret'; } })).toThrow('invalid');
    expect(accessed).toBe(false);
    const cycle = {}; cycle.self = cycle;
    expect(() => encodeBotSnapshot(cycle)).toThrow('invalid');
  });

  test('rejects missing, repeated, interleaved and oversized parts and clears partial state', () => {
    const parts = splitBotSnapshot(encodeBotSnapshot({ text: 'x'.repeat(BOT_SNAPSHOT_PART_CHARS * 2) }).text);
    const assembler = createBotSnapshotAssembler();
    expect(() => assembler.push(envelope(parts[1]))).toThrow('invalid');
    expect(assembler.push(envelope(parts[0]))).toBeNull();
    expect(() => assembler.push(envelope(parts[0]))).toThrow('invalid');
    expect(assembler.push(envelope(parts[0]))).toBeNull();
    expect(() => assembler.push(envelope(parts[1], 'different:0'))).toThrow('invalid');
    expect(() => assembler.push(envelope({ index: 0, total: 1, text: 'x'.repeat(BOT_SNAPSHOT_PART_CHARS + 1) }))).toThrow('invalid');
    expect(assembler.push(envelope(parts[0]))).toBeNull();
    assembler.reset();
    expect(() => assembler.push(envelope(parts[1]))).toThrow('invalid');
    const fresh = splitBotSnapshot(encodeBotSnapshot({ channels: [] }).text);
    expect(assembler.push(envelope(fresh[0]))?.payload).toEqual({ channels: [] });
  });

  test('rejects array subclasses before a custom serializer can bypass the byte preflight', () => {
    let serialized = false;
    class CustomArray extends Array {
      toJSON() { serialized = true; return 'fixture replacement'; }
    }
    expect(() => encodeBotSnapshot({ values: new CustomArray(1, 2, 3) })).toThrow('invalid');
    expect(serialized).toBe(false);
  });
});
