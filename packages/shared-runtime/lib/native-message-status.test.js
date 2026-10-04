import { expect, test } from 'bun:test';
import { isNativeStatusMessage, isNativeStatusRecord, isNativeTurnParent } from './native-message-status.js';

const metadata = { devryan: { v: 1, origin: 'interview', statusOnly: true } };
test('only the native status row excludes a parent; raw users and real continuations remain parents', () => {
  expect(isNativeStatusMessage({type:'synthetic',metadata})).toBe(true);
  expect(isNativeTurnParent({type:'synthetic',metadata})).toBe(false);
  for (const row of [{type:'user',metadata}, {type:'synthetic'},
    {type:'synthetic',metadata:{source:'shell',jobID:'job_1'}}, {type:'compaction'},
    {type:'synthetic',metadata:{devryan:{v:1,origin:'foreign',statusOnly:true}}}]) {
    expect(isNativeStatusMessage(row)).toBe(false); expect(isNativeTurnParent(row)).toBe(true);
  }
  expect(isNativeStatusRecord({info:{role:'user',metadata}})).toBe(false);
  expect(isNativeStatusRecord({info:{role:'user'},nativeStatus:{source:'native-sequence',kind:'status-only'}})).toBe(true);
});
