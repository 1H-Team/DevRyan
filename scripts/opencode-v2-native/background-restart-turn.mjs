import assert from 'node:assert/strict';
import { backgroundShellTurn } from './assertions.mjs';

const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const text = message => typeof message.content === 'string' ? message.content : Array.isArray(message.content)
  ? message.content.filter(part => record(part) && part.type === 'text').map(part => part.text).join('\n') : '';

/** Hold only simulated model output; the real native job and notification run normally. */
export function backgroundRestartTurn(caseID, input, options = {}) {
  const marker = `[devryan-native-case:${caseID}]`, callID = `native_${caseID}`;
  const original = options.resumeShellID ? undefined : backgroundShellTurn(caseID, input);
  let held = false, completed = false, shellID = options.resumeShellID;
  return { marker,
    responder: async request => {
      if (original) {
        const reply = original.responder(request);
        if (reply.items.some(item => record(item) && item.type === 'textDelta' && item.text === `completed ${caseID}`)) {
          shellID = original.complete().shellID;
          held = true;
          // No chunk/Step.Started is sent. The owned controller is killed at
          // this boundary; a fresh responder finishes its existing notice.
          return new Promise(() => {});
        }
        return reply;
      }
      assert.ok(record(request.body) && Array.isArray(request.body.messages), 'Restart model messages missing');
      const messages = request.body.messages;
      assert.ok(messages.some(message => record(message) && message.role === 'user' && text(message).includes(marker)), 'Restart lost original objective');
      const tool = messages.find(message => record(message) && message.role === 'tool' && message.tool_call_id === callID);
      assert.ok(tool && String(tool.content).includes(`shell ID: ${shellID}`), 'Restart lost the exact original shell result');
      assert.ok(messages.some(message => record(message) && message.role === 'user'
        && text(message).includes(`<shell id="${shellID}" state="completed"`)), 'Restart model lacks its canonical completed shell notice');
      assert.equal(completed, false, 'Restart completion inference replayed');
      completed = true;
      return { items: [{ type: 'textDelta', text: `completed ${caseID}` }], reason: 'stop' };
    },
    holding: () => ({ held, ...(shellID ? { shellID } : {}) }),
    complete: () => { assert.ok(!original && completed, 'Restart turn has not completed its existing notice'); return { shellID }; },
  };
}
