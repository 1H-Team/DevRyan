// DevRyan: the interview service, documents and HTTP surface are owned by the
// host; these tests cover the bridge against a fake owner. Upstream's tests of
// the plugin-built runtime, dashboard and /implement were removed (UPSTREAM.md).
import { describe, expect, mock, test } from 'bun:test';
import {
  applyInterviewCommandParts,
  createReviewedSlimInterviewBridge,
  markerText,
  type ReviewedSlimInterviewBridgeOwner,
  reviewedSlimInterviewCommandDeclaration,
} from './interview-bridge';
import type { V2CommandDefinition, V2SessionContextEvent } from './types';

function createOwner(overrides?: {
  active?: string | null;
  inject?: string;
  accept?: ReviewedSlimInterviewBridgeOwner['assertAcceptedCommand'];
}) {
  const handleCommandExecuteBefore = mock(
    async (
      _input: { command: string; sessionID: string; arguments: string },
      output: { parts: Array<Record<string, unknown>> },
    ) => {
      if (overrides?.inject)
        output.parts.push({ type: 'text', text: overrides.inject });
    },
  );
  const handleEvent = mock(async (_input: { event: unknown }) => {});
  const owner = {
    runtime: {},
    service: {
      handleCommandExecuteBefore,
      handleEvent,
      getActiveInterviewId: mock(async () => overrides?.active ?? null),
    },
    submitCommand: mock(async (_invocation: unknown) => {}),
    assertAcceptedCommand: mock(overrides?.accept ?? (async () => {})),
    dispose: mock(async () => {}),
  };
  return owner;
}

function contextEvent(
  sessionID: string,
  messages: V2SessionContextEvent['messages'],
): V2SessionContextEvent {
  return { sessionID, agent: 'orchestrator', model: {}, system: [], tools: {}, messages };
}

function userText(id: string | undefined, text: string) {
  return { ...(id ? { id } : {}), role: 'user', content: [{ type: 'text', text }] };
}

describe('markerText', () => {
  test('renders args byte-exact', () => {
    expect(markerText('build a notes app')).toBe(
      '<omos-interview-command>build a notes app</omos-interview-command>',
    );
    expect(markerText('')).toBe(
      '<omos-interview-command></omos-interview-command>',
    );
  });

  test('does not mangle $-sequences in args (regression)', () => {
    // A string replacer would turn $$ into $, $& into the whole match, and
    // $` into the preceding text. Function replacer keeps them byte-exact.
    expect(markerText('pay $$ now')).toBe(
      '<omos-interview-command>pay $$ now</omos-interview-command>',
    );
    expect(markerText('a $& b')).toBe(
      '<omos-interview-command>a $& b</omos-interview-command>',
    );
    expect(markerText('a $` b')).toBe(
      '<omos-interview-command>a $` b</omos-interview-command>',
    );
  });
});

describe('reviewed interview bridge', () => {
  test('requires a complete owner', () => {
    expect(() =>
      createReviewedSlimInterviewBridge(
        {} as unknown as ReviewedSlimInterviewBridgeOwner,
      ),
    ).toThrow('reviewed_slim_interview_bridge_owner_required');
  });

  test('registers only /interview and submits through the owner', async () => {
    const owner = createOwner();
    const bridge = createReviewedSlimInterviewBridge(owner);
    const added: V2CommandDefinition[] = [];
    bridge.registerCommand({ add: (def) => added.push(def) });
    expect(added.map((def) => [def.name, def.description])).toEqual([
      ['interview', reviewedSlimInterviewCommandDeclaration.description],
    ]);
    const invocation = { sessionID: 'ses', prompt: { text: 'x' } };
    await added[0]?.execute(invocation);
    expect(owner.submitCommand).toHaveBeenCalledWith(invocation);
  });

  test('propagates owner submit failures', async () => {
    const owner = createOwner();
    owner.submitCommand.mockImplementation(async () => {
      throw new Error('refused');
    });
    const bridge = createReviewedSlimInterviewBridge(owner);
    const added: V2CommandDefinition[] = [];
    bridge.registerCommand({ add: (def) => added.push(def) });
    await expect(
      added[0]?.execute({ sessionID: 'ses', prompt: { text: '' } }),
    ).rejects.toThrow('refused');
  });

  test('registerCommand is a no-op when the draft has no add', () => {
    const bridge = createReviewedSlimInterviewBridge(createOwner());
    expect(() => bridge.registerCommand({} as never)).not.toThrow();
  });

  test('proves the command was accepted, then rewrites only the tail', async () => {
    const owner = createOwner({ inject: 'injected <interview_state>' });
    const bridge = createReviewedSlimInterviewBridge(owner);
    const earlier = userText('old', 'Earlier context');
    const earlierBefore = structuredClone(earlier);
    const event = contextEvent('ses_v2', [
      earlier,
      userText('tail', markerText('  build a notes app ')),
    ]);
    await bridge.handleContext(event);

    expect(owner.assertAcceptedCommand).toHaveBeenCalledWith({
      sessionID: 'ses_v2',
      messageID: 'tail',
      args: 'build a notes app',
      event,
    });
    expect(owner.service.handleCommandExecuteBefore).toHaveBeenCalledWith(
      { command: 'interview', sessionID: 'ses_v2', arguments: 'build a notes app' },
      expect.anything(),
    );
    expect(earlier).toEqual(earlierBefore);
    expect(event.messages[1]?.content).toEqual([
      { type: 'text', text: 'injected <interview_state>' },
    ]);
  });

  test('refuses a marker the owner did not accept', async () => {
    const owner = createOwner({
      accept: async () => {
        throw new Error('reviewed_interview_command_unaccepted');
      },
    });
    const bridge = createReviewedSlimInterviewBridge(owner);
    await expect(
      bridge.handleContext(contextEvent('ses', [userText('u', markerText('x'))])),
    ).rejects.toThrow('reviewed_interview_command_unaccepted');
    expect(owner.service.handleCommandExecuteBefore).not.toHaveBeenCalled();
  });

  test('refuses a marker message without an id', async () => {
    const owner = createOwner();
    const bridge = createReviewedSlimInterviewBridge(owner);
    await expect(
      bridge.handleContext(contextEvent('ses', [userText(undefined, markerText('x'))])),
    ).rejects.toThrow('reviewed_slim_interview_message_required');
    expect(owner.assertAcceptedCommand).not.toHaveBeenCalled();
  });

  test('does not dispatch embedded or /implement markers', async () => {
    const owner = createOwner();
    const bridge = createReviewedSlimInterviewBridge(owner);
    const embedded = `please ${markerText('x')} now`;
    const implement = '<omos-implement-command>x</omos-implement-command>';
    for (const text of [embedded, implement]) {
      const event = contextEvent('ses', [userText('u', text)]);
      await bridge.handleContext(event);
      expect(event.messages[0]?.content).toEqual([{ type: 'text', text }]);
    }
    expect(owner.assertAcceptedCommand).not.toHaveBeenCalled();
    expect(owner.service.handleCommandExecuteBefore).not.toHaveBeenCalled();
  });

  test('projects text events from data- and properties-keyed payloads', async () => {
    const bridge = createReviewedSlimInterviewBridge(createOwner());
    await bridge.handleContext(contextEvent('ses_text', [userText('u', markerText('hi'))]));
    await bridge.handleEvent({ type: 'session.next.text.started', data: { sessionID: 'ses_text' } });
    await bridge.handleEvent({ type: 'session.next.text.delta', data: { sessionID: 'ses_text', delta: 'one' } });
    await bridge.handleEvent({ type: 'session.next.text.delta', properties: { sessionID: 'ses_text', delta: ' two' } });
    expect(bridge.getTranscript('ses_text').at(-1)?.parts?.[0]?.text).toBe('one two');

    await bridge.handleEvent({ type: 'session.deleted', data: { sessionID: 'ses_text' } });
    expect(bridge.getTranscript('ses_text')).toEqual([]);
  });

  test('maps session.execution lifecycle to busy/idle status for the service', async () => {
    const owner = createOwner({ active: 'interview-1' });
    const bridge = createReviewedSlimInterviewBridge(owner);
    await bridge.handleEvent({ type: 'session.execution.started', data: { sessionID: 'ses' } });
    await bridge.handleEvent({ type: 'session.execution.succeeded', data: { sessionID: 'ses' } });
    expect(owner.service.handleEvent.mock.calls.map(([call]) => call)).toEqual([
      { event: { type: 'session.status', properties: { sessionID: 'ses', status: { type: 'busy' } } } },
      { event: { type: 'session.status', properties: { sessionID: 'ses', status: { type: 'idle' } } } },
    ]);
  });

  test('ignores text streams for sessions that are not interviews', async () => {
    const bridge = createReviewedSlimInterviewBridge(createOwner());
    await bridge.handleContext(contextEvent('ses_plain', [userText('u', 'hello')]));
    await bridge.handleEvent({ type: 'session.next.text.started', properties: { sessionID: 'ses_plain' } });
    await bridge.handleEvent({ type: 'session.next.text.delta', properties: { sessionID: 'ses_plain', delta: 'ignored' } });
    expect(bridge.getTranscript('ses_plain')).toEqual([]);
  });

  test('dispose releases the owner and clears transcripts', async () => {
    const owner = createOwner();
    const bridge = createReviewedSlimInterviewBridge(owner);
    await bridge.handleContext(contextEvent('ses', [userText('u', markerText('x'))]));
    expect(bridge.getTranscript('ses')).not.toEqual([]);
    await bridge.dispose();
    expect(owner.dispose).toHaveBeenCalledTimes(1);
    expect(bridge.getTranscript('ses')).toEqual([]);
  });

  test('applyInterviewCommandParts: empty parts strip the marker, keep args', () => {
    const trailing = {
      role: 'user',
      content: [{ type: 'text', text: markerText('standup notes') }],
    };
    applyInterviewCommandParts(
      trailing,
      trailing.content[0].text as string,
      [],
    );
    expect(trailing.content).toEqual([{ type: 'text', text: 'standup notes' }]);
  });

  test('applyInterviewCommandParts: non-empty parts replace the content', () => {
    const trailing = {
      role: 'user',
      content: [{ type: 'text', text: markerText('idea') }],
    };
    applyInterviewCommandParts(trailing, trailing.content[0].text as string, [
      { type: 'text', text: 'EXPANDED', synthetic: true },
    ]);
    expect(trailing.content).toEqual([
      { type: 'text', text: 'EXPANDED', synthetic: true },
    ]);
  });

});
