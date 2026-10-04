import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {REVIEWED_CLAUDE_CREDENTIALS} from './reviewed-claude-transform.js';
const fail=()=>Object.assign(new Error('native_claude_credentials_unverified'),{code:'native_claude_credentials_unverified',status:503});
/** A sealed, retained module, not a runtime dependency search or unconfined proxy. */
export async function loadReviewedClaudeCredentials(asset){
 if(!asset||asset.sha256!==REVIEWED_CLAUDE_CREDENTIALS.sha256||!path.isAbsolute(asset.path??'')||path.basename(asset.path)!==REVIEWED_CLAUDE_CREDENTIALS.path||await fs.realpath(asset.path)!==asset.path)throw fail();
 const stat=await fs.lstat(asset.path);if(!stat.isFile()||(stat.mode&0o777)!==REVIEWED_CLAUDE_CREDENTIALS.mode||stat.size>65536)throw fail();
 const bytes=await fs.readFile(asset.path);if(createHash('sha256').update(bytes).digest('hex')!==asset.sha256)throw fail();
 return import('data:text/javascript;base64,'+bytes.toString('base64'));
}
