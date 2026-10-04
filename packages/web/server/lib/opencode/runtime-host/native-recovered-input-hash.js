import { createHash } from 'node:crypto';
import { Schema } from 'effect';
import { SessionInbox } from '@opencode/schema/session-inbox';

const item=Schema.toEncoded(SessionInbox.Item);
export const recoveredInputHash=value=>createHash('sha256').update(JSON.stringify(Schema.decodeUnknownSync(item)(value,{onExcessProperty:'error'}),
  (_key,value)=>value!==null&&typeof value==='object'&&!Array.isArray(value)
    ?Object.fromEntries(Object.keys(value).sort().map(key=>[key,value[key]])):value)).digest('hex');
