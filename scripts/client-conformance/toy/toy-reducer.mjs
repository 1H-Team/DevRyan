// Harness-owned toy reducer (self-test corpus of the client conformance
// harness). It mutates a draft copy-on-write the way the engine's reducer
// does: a field it changes gets a new object, everything else keeps its
// identity. It reads the clock and randomness, keeps a Set and a Map in state
// and appends new keys in arrival order. Product code never imports it.
export function createState() {
  return { sessions: {}, order: [], hidden: new Set(), status: new Map(), revision: 0 };
}

export function applyEvent(draft, event) {
  switch (event.type) {
    case 'session.created': {
      draft.sessions = { ...draft.sessions, [event.id]: { id: event.id, title: event.title, messages: [] } };
      draft.order = [...draft.order, event.id];
      break;
    }
    case 'message.added': {
      const session = draft.sessions[event.session];
      if (!session) return false;
      const message = { id: event.id ?? `m-${Math.random().toString(36).slice(2, 10)}`, text: event.text, time: Date.now() };
      draft.sessions = { ...draft.sessions, [session.id]: { ...session, messages: [...session.messages, message] } };
      break;
    }
    case 'message.hidden': draft.hidden.add(event.id); break;
    case 'status': draft.status.set(event.session, { type: event.status, offset: event.offset ?? -0 }); break;
    case 'probe': return draft.revert ? 'reverting' : 'idle';
    case 'fail': throw new TypeError(`unknown session ${event.session}`);
    default: return false;
  }
  draft.revision += 1;
  return true;
}
