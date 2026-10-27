import { Effect } from 'effect';
import { Bus } from '@opencode/core/bus';
import { Session } from '@opencode/core/session';
import { SessionEvent } from '@opencode/core/session/event';
import { SessionMessage } from '@opencode/core/session/message';
import { SessionSchema } from '@opencode/core/session/schema';
import { Event } from '@opencode/schema/event';
import { HostRefusal, refuseHost } from './host-refusal.js';

/** Private status notice: the original durable event projects into history
 * without admitting input that an already active runner could consume. */
export function persistInterviewNotification(input: {
  readonly bus: Bus.Interface;
  readonly sessions: Session.Interface;
  readonly body: { readonly sessionID: SessionSchema.ID; readonly id: SessionMessage.ID; readonly text: string; readonly resume: false };
  readonly metadata: Record<string, unknown>;
  readonly recheck: () => Effect.Effect<void>;
}) {
  return Effect.gen(function* () {
    const { body } = input;
    const session = yield* input.sessions.get(body.sessionID);
    if (session.id !== body.sessionID || session.time.archived || session.revert) {
      return yield* refuseHost(new HostRefusal('native_interview_scope_invalid', 403, 'session.synthetic', body.sessionID));
    }
    // The owner issues this sealed ID. Original native projection derives the
    // message ID from the event ID; no separate storage or inbox is involved.
    const id = Event.ID.make(body.id.replace(/^msg_/, 'evt_'));
    yield* input.recheck();
    const event = yield* input.bus.publish(SessionEvent.Synthetic, {
      sessionID: body.sessionID, text: body.text, metadata: input.metadata,
    }, { id, location: session.location });
    return SessionMessage.ID.fromEvent(event.id);
  });
}
