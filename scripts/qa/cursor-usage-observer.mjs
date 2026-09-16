// Study-only SDK decorator. It observes the pinned native runtime without
// changing prompts, settings, models, tools, cancellation, or stream results.
import { createHash } from 'node:crypto';
import { normalizeCursorUsage, cursorRunUsageObservation } from '../../packages/cursor-sdk-runtime/cursor-usage.js';

const hash = value => createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value ?? null)).digest('hex');

export function observeCursorSdk(sdk, write) {
  const wrapped = new WeakMap();
  const wrap = agent => {
    if (wrapped.has(agent)) return wrapped.get(agent);
    const proxy = new Proxy(agent, {
      get(target, property) {
        if (property !== 'send') {
          const value = Reflect.get(target, property, target);
          return typeof value === 'function' ? value.bind(target) : value;
        }
        return async (message, options = {}) => {
          const text = typeof message === 'string' ? message : message.text;
          write({ kind: 'send', agentID: target.agentId, promptBytes: Buffer.byteLength(text || ''),
            promptSha256: hash(text || ''), model: options.model || target.model,
            instructionBlocks: (text?.match(/<agent_instructions /g) || []).length });
          const seenTools = new Set();
          const run = await target.send(message, { ...options, onDelta(event) {
            const update = event.update || event;
            if (update.type === 'tool-call-started' && !seenTools.has(update.callId)) {
              seenTools.add(update.callId);
              write({ kind: 'tool-started', agentID: target.agentId, callID: update.callId,
                tool: update.toolCall?.name || update.toolCall?.type, inputSha256: hash(update.toolCall?.args) });
            }
            if (update.type === 'tool-call-completed') write({ kind: 'tool-completed', agentID: target.agentId,
              callID: update.callId, resultSha256: hash(update.toolCall?.result) });
            if (update.type === 'turn-ended') write({ kind: 'turn-usage', agentID: target.agentId,
              usage: normalizeCursorUsage(update.usage) });
            if (update.type === 'summary-started' || update.type === 'summary-completed') write({ kind: update.type, agentID: target.agentId });
            options.onDelta?.(event);
          } });
          write({ kind: 'run-started', ...cursorRunUsageObservation(run) });
          void run.wait().then(result => {
            write({ kind: 'run-ended', ...cursorRunUsageObservation(run, result), usage: normalizeCursorUsage(result.usage) || normalizeCursorUsage(run.usage), at: Date.now() });
            const timer = setTimeout(async () => {
              try {
                const billed = await target.getUsage();
                write({ kind: 'billing', agentID: target.agentId, usage: normalizeCursorUsage(billed.usage),
                  cost: billed.cost ? { rawCostCents: billed.cost.rawCostCents, chargedCents: billed.cost.chargedCents } : null,
                  entries: billed.runs.map(row => ({ runId: row.runId, usage: normalizeCursorUsage(row.usage),
                    cost: row.cost ? { rawCostCents: row.cost.rawCostCents, chargedCents: row.cost.chargedCents } : null })) });
              } catch (error) { write({ kind: 'billing-unavailable', agentID: target.agentId, code: error.code || error.name }); }
            }, 5000);
            timer.unref?.();
          }, error => write({ kind: 'run-ended', ...cursorRunUsageObservation(run), usage: normalizeCursorUsage(run.usage),
            status: 'error', errorCode: error.code || error.name }));
          return run;
        };
      },
    });
    wrapped.set(agent, proxy);
    return proxy;
  };
  return { ...sdk, Agent: new Proxy(sdk.Agent, {
    get(target, property) {
      if (property === 'prompt') return async (message, options) => {
        const text = typeof message === 'string' ? message : message?.text;
        write({ kind: 'one-shot-started', model: options?.model, promptBytes: Buffer.byteLength(text || ''), promptSha256: hash(text || ''),
          host: { node: process.versions.node, electron: process.versions.electron ?? null } });
        try {
          const result = await target.prompt(message, options);
          write({ kind: 'one-shot-ended', ...cursorRunUsageObservation(null, result), usage: normalizeCursorUsage(result.usage) });
          return result;
        } catch (error) {
          write({ kind: 'one-shot-ended', status: 'error', usage: null, errorCode: error.code || error.name });
          throw error;
        }
      };
      if (property === 'create' || property === 'resume') return async (...args) => {
        const options = args[property === 'create' ? 0 : 1] || {};
        const agent = await target[property](...args);
        write({ kind: `agent-${property}`, agentID: agent.agentId, model: options.model,
          host: { node: process.versions.node, electron: process.versions.electron ?? null },
          definitionsSha256: hash(options.agents), definitionCount: Object.keys(options.agents || {}).length,
          mcpServerNames: Object.keys(options.mcpServers || {}), settingSources: options.local?.settingSources ?? null });
        return wrap(agent);
      };
      const value = Reflect.get(target, property, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  }) };
}
