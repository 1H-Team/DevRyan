import type {MigrationDatabase} from './bundle-migration-inventory.js';
import type {VerifiedBundleContinuation} from './bundle-owned-continuations.js';
/** Read-only, never an admission/dispatch grant. The constructor owner installs its fence before launch. */
export function verifyBundleRecoveredInputs(db:MigrationDatabase,webDataDirectory:string,options?:{readonly cancelledOnly?:boolean}):Promise<readonly VerifiedBundleContinuation[]>;
