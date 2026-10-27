import {test} from 'vitest';
import assert from 'node:assert/strict';
import {nativeBundleFileOperations} from './native-bundle-file-operations.js';

test('constructor-owned Windows writes and SQLite output require native ownership and settlement',async()=>{
 const calls=[];let active=false;
 const windowsOwner={ensureDirectory:async directory=>calls.push(['directory',directory]),write:async(file,bytes,options)=>calls.push(['write',file,bytes.toString(),options]),
  beginSqliteOutput:(root,name)=>({ready:Promise.resolve().then(()=>{active=true;}),assertHeld:()=>{assert.equal(active,true);},commit:async()=>{calls.push(['commit']);active=false;},cancel:async()=>{calls.push(['cancel']);active=false;}})};
 const operations=nativeBundleFileOperations({windowsOwner});
 await operations.writeFresh('/private/file','fixture');
 assert.deepEqual(calls,[['directory','/private'],['write','/private/file','fixture',{expected:null}]]);
 const result=await operations.withSqliteOutput('/private/sqlite/db',file=>{assert.equal(active,true);assert.equal(file,'/private/sqlite/db');return 42;});
 assert.equal(result,42);assert.deepEqual(calls.at(-1),['commit']);assert.equal(active,false);
 await assert.rejects(operations.withSqliteOutput('/private/sqlite/db',()=>{throw Error('fixture_sqlite_error');}),/sqlite_error/);
 assert.deepEqual(calls.at(-1),['cancel']);
});
test('unconfirmed SQLite cleanup remains an explicit aggregate failure; missing APIs never create through Node',async()=>{
 const windowsOwner={ensureDirectory:async()=>{},beginSqliteOutput:()=>({ready:Promise.resolve(),assertHeld:()=>{},commit:async()=>{throw Error('fixture_commit_error');},cancel:async()=>{throw Error('fixture_cleanup_unconfirmed');}})};
 await assert.rejects(nativeBundleFileOperations({windowsOwner}).withSqliteOutput('/private/sqlite/db',()=>{}),error=>error instanceof AggregateError&&error.errors.length===2);
 await assert.rejects(nativeBundleFileOperations({windowsOwner:{}}).writeFresh('/private/file','fixture'),{code:'private_windows_storage_authority_unavailable'});
});
