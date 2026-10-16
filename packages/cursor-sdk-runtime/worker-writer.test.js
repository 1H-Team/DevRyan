import { expect, test } from 'bun:test';
import { EventEmitter } from 'node:events';
import { createCursorWorkerWriter } from './worker-writer.js';

const fixture = () => {
  const stdout = new EventEmitter(), writes = [];
  stdout.write = (text, done) => {writes.push({text,done}); return false;};
  return {writes,stdout,writer:createCursorWorkerWriter(stdout)};
};
test('terminal drainage awaits unawaited callbacks and retains their original failures', async () => {
  const f=fixture(); void f.writer.write({type:'usage'});
  let settled=false; const drainage=f.writer.drain().then(()=>{settled=true;});
  await Promise.resolve(); expect(settled).toBe(false);
  f.writes[0].done(); await drainage; expect(settled).toBe(true);
  void f.writer.write({type:'usage'});
  const error=Error('pipe failed'); f.writes[1].done(error);
  await expect(f.writer.drain()).rejects.toBe(error);
});
test('count and byte limits retain a bounded negative report and never a successful terminal', async () => {
  for(const oversized of [false,true]) {
    const f=fixture();
    if(oversized) void f.writer.write({type:'message',text:'x'.repeat(8*1024*1024)});
    else for(let i=0;i<4097;i++) void f.writer.write({type:'usage'});
    expect(f.writes.length).toBe(oversized?0:4096);
    for(const entry of f.writes) entry.done();
    await expect(f.writer.drain()).rejects.toMatchObject({code:'CURSOR_STREAM_QUEUE_OVERFLOW'});
    await expect(f.writer.report({type:'done'})).rejects.toThrow();
    const report=f.writer.report({type:'error',code:'CURSOR_STREAM_QUEUE_OVERFLOW'});
    await Promise.resolve(); await Promise.resolve();
    f.writes.at(-1).done(); await report;
    expect(f.writer.failed).toBe(true);
  }
});
test('stdout error events remain visible even without a returned callback error', async () => {
  const f=fixture(), error=Error('stream error'); f.stdout.emit('error',error);
  await expect(f.writer.drain()).rejects.toBe(error);
});

test('long provider failures fit the reserved report without poisoning the shared writer', async () => {
  const f = fixture();
  for (const event of [
    {type:'error',requestID:'failed',error:'\u0000'.repeat(30000),errorDetails:{name:'RateLimitError',code:'RESOURCE_EXHAUSTED',source:'provider'}},
    {type:'final-result',requestID:'failed',result:{ok:false,error:'\u0000'.repeat(30000),errorDetails:{name:'RateLimitError',code:'RESOURCE_EXHAUSTED',source:'provider'}}},
  ]) {
    const report = f.writer.report(event);
    await Promise.resolve(); await Promise.resolve();
    const entry = f.writes.at(-1), saved = JSON.parse(entry.text);
    expect(Buffer.byteLength(entry.text)).toBeLessThanOrEqual(8192);
    expect((saved.result || saved).errorDetails).toEqual({name:'RateLimitError',code:'RESOURCE_EXHAUSTED',source:'provider'});
    entry.done(); await report;
    expect(f.writer.failed).toBe(false);
  }
  const sibling = f.writer.write({type:'done',requestID:'sibling'});
  f.writes.at(-1).done(); await sibling; await f.writer.drain();
});

test('a failed reserved report propagates the pipe failure', async () => {
  const f = fixture(), error = Error('report pipe failed');
  const report = f.writer.report({type:'error',error:'provider refused'});
  await Promise.resolve(); await Promise.resolve();
  f.writes[0].done(error);
  await expect(report).rejects.toBe(error);
});
