import { expect, test, vi } from 'vitest';
import { createNativeSearchOutput } from './native-search-output.js';

test('search caps stop the producer and preserve complete JSON records across chunks', () => {
  const output = [], stop = vi.fn();
  const reader = createNativeSearchOutput({ tool: 'grep', emit: bytes => output.push(bytes), stop, maxBytes: 256, maxRecords: 2 });
  reader.write(Buffer.from('{"type":"match","text":"é'));
  reader.write(Buffer.from('"}\n{"type":"match"}\n{"type":"match"}\n'));
  expect(stop).toHaveBeenCalledTimes(1);
  const text = Buffer.concat(output).toString();
  expect(text.endsWith('\n')).toBe(true);
  expect(text.trim().split('\n').map(line => JSON.parse(line))).toHaveLength(2);
  expect(reader.metadata()).toMatchObject({ returnedRecords: 2, limitRecords: 2, reason: 'record_limit' });
});

test('oversized records never enter the parser or grow the retained buffer', () => {
  const output = [], stop = vi.fn();
  const reader = createNativeSearchOutput({ tool: 'grep', emit: bytes => output.push(bytes), stop, maxBytes: 32, maxRecords: 20 });
  reader.write(Buffer.alloc(1024 * 1024, 120));
  expect(stop).toHaveBeenCalledTimes(1); expect(output).toEqual([]);
  expect(reader.metadata()).toMatchObject({ returnedBytes: 0, reason: 'byte_limit' });
});

test('complete small output remains unchanged and incomplete output fails closed', () => {
  const output = [], stop = vi.fn();
  const reader = createNativeSearchOutput({ tool: 'glob', emit: bytes => output.push(bytes), stop });
  reader.write(Buffer.from('src/é.ts\n'));
  reader.finish(); expect(reader.metadata()).toBeNull(); expect(stop).not.toHaveBeenCalled();
  expect(Buffer.concat(output).toString()).toBe('src/é.ts\n');
  reader.write(Buffer.from('torn'));
  expect(() => reader.finish()).toThrow('native_read_incomplete_line');
});
