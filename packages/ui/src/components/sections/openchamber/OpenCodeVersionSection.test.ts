import {describe,expect,test} from 'bun:test';
import {compareUpstreamVersion,parseBundledRuntimeVersion,parseLatestUpstreamVersion} from './openCodeVersionState';
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
describe('upstream version comparison',()=>{
 test('compares numeric components rather than strings',()=>{
  expect(compareUpstreamVersion('2.0.26','2.0.26')).toBe('up-to-date');
  expect(compareUpstreamVersion('2.0.24','2.0.26')).toBe('update-available');
  expect(compareUpstreamVersion('2.0.26','2.0.24')).toBe('up-to-date');
  expect(compareUpstreamVersion('2.0.9','2.0.26')).toBe('update-available');
  expect(compareUpstreamVersion('2.0.26','2.0.9')).toBe('up-to-date');
  expect(compareUpstreamVersion('2.0.99','2.1.0')).toBe('update-available');
  expect(compareUpstreamVersion('2.1.0','2.0.99')).toBe('up-to-date');
 });
 test('returns unknown when either identity is unavailable or unparseable',()=>{
  for(const current of [null,undefined,'','2.0','2.0.26-beta.1','v2.0.26'])expect(compareUpstreamVersion(current,'2.0.26')).toBe('unknown');
  expect(compareUpstreamVersion('2.0.26',null)).toBe('unknown');
 });
 test('accepts only stable 2.x latest payloads',()=>{
  expect(parseLatestUpstreamVersion({latestVersion:'2.0.26'})).toBe('2.0.26');
  for(const value of [null,{},{latestVersion:2},{latestVersion:'1.18.0'},{latestVersion:'3.0.0'},{latestVersion:'2.0.26-beta.1'},{latestVersion:'2.0'},{latestVersion:' 2.0.26'},{latestVersion:'02.0.1'}])
   expect(parseLatestUpstreamVersion(value)).toBeNull();
 });
});
