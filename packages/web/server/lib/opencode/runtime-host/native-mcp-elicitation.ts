import { Effect } from 'effect';
import { Form } from '@opencode/core/form';
import { HostRefusal, refuseHost } from './host-refusal.js';
import { OperationPermitRef, requestPermit } from './native-admission-contract.js';

/** OpenCode 2.1.4 owns every MCP elicitation form with this sentinel session. */
export const MCP_ELICITATION_OWNER = 'global';
export const MCP_ELICITATION_KIND = 'mcp-elicitation';
const URL_FIELD_KEY = 'elicitation';
const SESSION_ID = /^ses[A-Za-z0-9_-]{1,252}$/;

/** The one in-flight tool call an elicitation was raised by. Host-owned. */
export interface McpElicitationAttribution {
  readonly sessionID: string;
  readonly messageID: string;
  readonly callID: string;
}
export type McpElicitationRefusal = 'disabled' | 'unattributed' | 'ambiguous' | 'url_refused' | 'unsupported_owner';
export interface McpElicitationRefusalRecord {
  readonly reason: McpElicitationRefusal;
  readonly server?: string;
  /** Field types only, never keys' values, URLs or messages. */
  readonly fieldKinds: readonly string[];
}

/** `DEVRYAN_MCP_ELICITATION=0|off|false` cancels every MCP elicitation (read on each use). */
export const mcpElicitationEnabled = (env: Readonly<Record<string, string | undefined>> = process.env): boolean => {
  const value = env.DEVRYAN_MCP_ELICITATION?.trim().toLowerCase();
  return value !== '0' && value !== 'off' && value !== 'false';
};

/** Only an absolute http(s) URL may ever be shown as an elicitation link. */
export const isElicitationUrl = (value: unknown): value is string => {
  if (typeof value !== 'string' || value.length > 8192) return false;
  try {
    const url = new URL(value);
    return (url.protocol === 'http:' || url.protocol === 'https:') && !url.username && !url.password;
  } catch {
    return false;
  }
};

type CallResolution =
  | { readonly kind: 'attributed'; readonly attribution: McpElicitationAttribution }
  | { readonly kind: 'unattributed' | 'ambiguous' };

/** In-flight remote MCP calls per location and server. Process-local and host-owned:
 * neither an MCP server nor a client request can register or name an entry. */
export interface McpElicitationCalls {
  readonly track: (directory: string, server: string, attribution: McpElicitationAttribution) => () => void;
  readonly resolve: (directory: string, server: string) => CallResolution;
  readonly active: (directory: string, server: string, attribution: McpElicitationAttribution) => boolean;
  /** Settles when that call ends (at once when it is no longer in flight). */
  readonly ended: (attribution: McpElicitationAttribution) => Promise<void>;
}

export function createMcpElicitationCalls(): McpElicitationCalls {
  const calls = new Map<string, Set<McpElicitationAttribution>>();
  const endings = new WeakMap<McpElicitationAttribution, Promise<void>>();
  const key = (directory: string, server: string) => `${directory}\0${server}`;
  return {
    track: (directory, server, attribution) => {
      const id = key(directory, server);
      const entry = Object.freeze({ sessionID: attribution.sessionID, messageID: attribution.messageID, callID: attribution.callID });
      let finish = () => {};
      endings.set(entry, new Promise<void>(resolve => { finish = resolve; }));
      const entries = calls.get(id) ?? new Set<McpElicitationAttribution>();
      entries.add(entry); calls.set(id, entries);
      let released = false;
      return () => {
        if (released) return;
        released = true; entries.delete(entry);
        if (!entries.size && calls.get(id) === entries) calls.delete(id);
        finish();
      };
    },
    resolve: (directory, server) => {
      const entries = calls.get(key(directory, server));
      if (!entries?.size) return { kind: 'unattributed' };
      if (entries.size > 1) return { kind: 'ambiguous' };
      const [attribution] = entries;
      return { kind: 'attributed', attribution };
    },
    active: (directory, server, attribution) => calls.get(key(directory, server))?.has(attribution) === true,
    ended: attribution => endings.get(attribution) ?? Promise.resolve(),
  };
}

type FormMutation = 'form.reply' | 'form.cancel';
export interface NativeFormOptions {
  /** The location the decorated Form registry belongs to. */
  readonly directory: string | undefined;
  readonly calls: McpElicitationCalls | undefined;
  /** Admission for a reply or cancel, bound to a real session's permit. */
  readonly mutate: <A, E, R>(name: FormMutation, sessionID: string, input: unknown, action: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>;
  /** Best-effort journal entry for a refused elicitation; never awaited by the MCP call. */
  readonly recordRefusal?: (record: McpElicitationRefusalRecord) => Promise<void>;
  readonly enabled?: () => boolean;
}

interface OwnedElicitation {
  readonly attribution: McpElicitationAttribution;
  readonly directory: string;
  readonly server: string;
  readonly url: boolean;
}

const record = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const withoutStamp = (metadata: Form.Info['metadata']): Record<string, unknown> => {
  const { devryan: _stamp, ...rest } = metadata ?? {};
  void _stamp;
  return rest;
};

/** Form registry decorator. Session forms keep their owner's admission. Forms of
 * the `global` sentinel are MCP elicitations: one is shown only when exactly one
 * in-flight reviewed MCP call of the same location and server can own it; its
 * reply and cancel then need that session's permit. Everything else is cancelled
 * before a form exists, so the MCP tool call returns instead of hanging. */
export function decorateNativeForms(inner: Form.Interface, options: NativeFormOptions): Form.Interface {
  const owned = new Map<string, OwnedElicitation>();
  const enabled = options.enabled ?? (() => mcpElicitationEnabled());
  const refuse = (input: Form.CreateInput, reason: McpElicitationRefusal): Effect.Effect<Form.TerminalState> => Effect.sync(() => {
    const server = typeof input.metadata?.server === 'string' && input.metadata.server.length <= 256 ? input.metadata.server : undefined;
    const fieldKinds = [...new Set(input.fields.map(field => field.type))];
    if (options.recordRefusal) void options.recordRefusal({ reason, ...(server ? { server } : {}), fieldKinds }).catch(() => {});
    return { status: 'cancelled', message: `DevRyan cancelled this MCP input request (${reason})` } satisfies Form.TerminalState;
  });
  const elicit = (input: Form.CreateInput) => Effect.gen(function* () {
    if (input.metadata?.kind !== MCP_ELICITATION_KIND) return yield* refuse(input, 'unsupported_owner');
    if (!enabled()) return yield* refuse(input, 'disabled');
    if (input.fields.some(field => field.type === 'external' && !isElicitationUrl(field.url))) return yield* refuse(input, 'url_refused');
    const server = input.metadata.server;
    if (typeof server !== 'string' || !server || !options.directory || !options.calls) return yield* refuse(input, 'unattributed');
    const resolved = options.calls.resolve(options.directory, server);
    if (resolved.kind !== 'attributed') return yield* refuse(input, resolved.kind);
    const { attribution } = resolved;
    if (!SESSION_ID.test(attribution.sessionID)) return yield* refuse(input, 'unattributed');
    const id = input.id ?? Form.ID.create();
    if (owned.has(id)) return yield* new Form.AlreadyExistsError({ id });
    owned.set(id, { attribution, directory: options.directory, server,
      url: input.fields.length === 1 && input.fields[0].type === 'external' && input.fields[0].key === URL_FIELD_KEY });
    const stamped: Form.CreateInput = { ...input, id,
      metadata: { ...withoutStamp(input.metadata), devryan: { sessionID: attribution.sessionID, messageID: attribution.messageID, callID: attribution.callID } } };
    // A Stop or settled call takes its pending request with it: the native ask
    // is interrupted, which cancels the form (`form.cancelled` clears the card).
    const calls = options.calls;
    return yield* inner.ask(stamped).pipe(
      Effect.raceFirst(Effect.promise(() => calls.ended(attribution)).pipe(
        Effect.as({ status: 'cancelled', message: 'The MCP tool call that asked has ended' } satisfies Form.TerminalState))),
      Effect.ensuring(Effect.sync(() => { owned.delete(id); })));
  });
  // A form outside the pending registry answers with its native error.
  const elicitation = (id: Form.ID, operation: FormMutation) => Effect.gen(function* () {
    const entry = owned.get(id);
    if (entry) return entry;
    const state = yield* inner.state(id);
    if (state.status !== 'pending') return yield* new Form.AlreadySettledError({ id });
    return yield* refuseHost(new HostRefusal('native_mcp_elicitation_unattributed', 403, operation));
  });
  // The MCP server's own completion notice settles its URL request. It carries
  // no permit and can only report completion back to the server that asked.
  const serverCompletion = (entry: OwnedElicitation, answer: Form.Answer) => Effect.gen(function* () {
    if (!entry.url || Object.keys(answer).length !== 1 || answer[URL_FIELD_KEY] !== true) return false;
    if ((yield* OperationPermitRef) || requestPermit()) return false;
    return options.calls?.active(entry.directory, entry.server, entry.attribution) === true;
  });
  // A client request carries its web permit: it must be the attributed session's,
  // whatever session the client claimed (core binding, before admission).
  const bindRequest = (sessionID: string, operation: FormMutation) => Effect.suspend(() => {
    const permit = requestPermit();
    return permit && permit.sessionID !== sessionID
      ? refuseHost(new HostRefusal('native_permit_lineage_mismatch', 403, operation, sessionID)) : Effect.void;
  });
  return Form.Service.of({ ...inner,
    create: input => input.sessionID === MCP_ELICITATION_OWNER
      ? new Form.InvalidFormError({ message: 'DevRyan accepts MCP input requests only through Form.ask' })
      : inner.create(input),
    ask: input => input.sessionID === MCP_ELICITATION_OWNER ? elicit(input) : inner.ask(input),
    reply: input => Effect.gen(function* () {
      const pending = yield* inner.get(input.id);
      if (pending.sessionID !== MCP_ELICITATION_OWNER) {
        return yield* options.mutate('form.reply', pending.sessionID, { ...input, pending: { sessionID: pending.sessionID } }, inner.reply(input));
      }
      const entry = yield* elicitation(input.id, 'form.reply');
      if (record(input.answer) && (yield* serverCompletion(entry, input.answer))) return yield* inner.reply(input);
      const sessionID = entry.attribution.sessionID;
      yield* bindRequest(sessionID, 'form.reply');
      return yield* options.mutate('form.reply', sessionID, { ...input, pending: { sessionID } }, inner.reply(input));
    }),
    cancel: (id, cancelOptions) => Effect.gen(function* () {
      const pending = yield* inner.get(id);
      if (pending.sessionID !== MCP_ELICITATION_OWNER) {
        return yield* options.mutate('form.cancel', pending.sessionID, { id, pending: { sessionID: pending.sessionID } }, inner.cancel(id, cancelOptions));
      }
      const sessionID = (yield* elicitation(id, 'form.cancel')).attribution.sessionID;
      yield* bindRequest(sessionID, 'form.cancel');
      return yield* options.mutate('form.cancel', sessionID, { id, pending: { sessionID } }, inner.cancel(id, cancelOptions));
    }),
  });
}
