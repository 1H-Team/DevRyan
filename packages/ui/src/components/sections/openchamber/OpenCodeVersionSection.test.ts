import {describe,expect,test} from 'bun:test';
import {parseBundledRuntimeVersion} from './openCodeVersionState';
describe('bundled runtime version metadata',()=>{
 test('uses verified native metadata while retaining unavailable readiness',()=>{
  expect(parseBundledRuntimeVersion({source:'verified-native-bundle',targetVersion:'2.0.20',detectedVersion:'2.0.20'})).toEqual({version:'2.0.20',ready:true});
  expect(parseBundledRuntimeVersion({source:'verified-native-bundle',targetVersion:'2.0.20',detectedVersion:null})).toEqual({version:'2.0.20',ready:false});
  expect(parseBundledRuntimeVersion({source:'verified-native-bundle',targetVersion:'2.0.20',detectedVersion:'1.18.31'})).toEqual({version:'2.0.20',ready:false});
 });
 test('rejects unverified or unsupported identities',()=>{
  for(const value of [null,{}, {source:'PATH',targetVersion:'2.0.20',detectedVersion:'2.0.20'}, {source:'verified-native-bundle',targetVersion:'1.18.31'}])expect(parseBundledRuntimeVersion(value)).toBeNull();
 });
});
