import {test} from 'vitest';
import assert from 'node:assert/strict';
import {parseNativeImportChildProof,createNativeMigrationFiles} from './native-migration-files.js';
test('offline migration child proof requires exact parent kernel identity and grants no runtime admission',()=>{
 const nonce='a'.repeat(32),identity={nonce,pid:123},proof={protocol:'devryan.windows-native-import-child/1',nonce,pid:123,startIdentity:'win32:'+'b'.repeat(16),inJob:true,jobOwned:true,admission:false};
 assert.equal(parseNativeImportChildProof(proof,identity),proof);
 for(const changed of [{pid:124},{nonce:'c'.repeat(32)},{inJob:false},{jobOwned:false},{admission:true},{startIdentity:'pid-only'},{extra:true}])assert.throws(()=>parseNativeImportChildProof({...proof,...changed},identity),{code:'native_migration_owner_unverified'});
});
test('raw compiled migration writer cannot be constructed without actual Windows kernel admission',async()=>{
 await assert.rejects(createNativeMigrationFiles({},undefined),{code:'native_migration_owner_unverified'});
});
