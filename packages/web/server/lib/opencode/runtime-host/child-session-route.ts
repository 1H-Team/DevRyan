import { Schema } from 'effect';
import { Agent } from '@opencode/core/agent';
import { Model } from '@opencode/core/model';
import { Permission } from '@opencode/core/permission';
import { SessionSchema } from '@opencode/core/session/schema';
import type { Session } from '@opencode/core/session';
import { HostRefusal } from './host-refusal.js';
import { requestPermit } from './native-admission-contract.js';

const ChildInput = Schema.Struct({
  parentID: SessionSchema.ID, id: Schema.optional(SessionSchema.ID), title: Schema.optional(Schema.String),
  agent: Schema.optional(Agent.ID), model: Schema.optional(Model.Ref),
  permissions: Schema.optional(Permission.Ruleset), metadata: Schema.optional(SessionSchema.Metadata),
  location: Schema.optional(Schema.Struct({ directory: Schema.String })),
});
type CreateChild = (input: Parameters<Session.Interface['create']>[0], expectedDirectory?: string) => Promise<SessionSchema.Info>;
const MAX_BYTES = 1024 * 1024;

/** Host-only child creation preserves the parent's permit and native location. */
export async function childSessionRoute(request: Request, createChild: CreateChild): Promise<Response> {
  if (request.method !== 'POST') return Response.json({ code: 'method_not_allowed' }, { status: 405, headers: { allow: 'POST' } });
  if (!requestPermit()) throw new HostRefusal('native_permit_required', 403, 'session.create');
  const chunks: Uint8Array[] = [];
  const reader = request.body?.getReader();
  let size = 0;
  try {
    if (reader) for (;;) {
      const next = await reader.read();
      if (next.done) break;
      size += next.value.byteLength;
      if (size > MAX_BYTES) {
        await reader.cancel();
        return Response.json({ code: 'request_body_too_large' }, { status: 413 });
      }
      chunks.push(next.value);
    }
  } finally { reader?.releaseLock(); }
  let input: typeof ChildInput.Type;
  try {
    input = Schema.decodeUnknownSync(ChildInput, { onExcessProperty: 'error' })(JSON.parse(Buffer.concat(chunks).toString('utf8')));
  } catch { return Response.json({ code: 'invalid_child_session' }, { status: 400 }); }
  if (!/^ses[0-9A-Za-z_-]{1,128}$/.test(input.parentID)
    || (input.id !== undefined && (!/^ses[0-9A-Za-z_-]{1,128}$/.test(input.id) || input.id === input.parentID))) {
    return Response.json({ code: 'invalid_child_session' }, { status: 400 });
  }
  if (requestPermit()?.sessionID !== input.parentID) throw new HostRefusal('native_permit_lineage_mismatch', 403, 'session.create');
  const { location, ...child } = input;
  return Response.json({ data: await createChild(child, location?.directory) });
}
