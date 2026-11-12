// Harness-owned toy gate module (self-test corpus of the client conformance
// harness): calls that wait on gates other inputs open. What a waiter does
// once released belongs to the input that released it: a later call, a
// timer an earlier call set, or a port's answer settling. `eager` is the
// negative control: it does not wait, so what it does is its own call's.
// Product code never imports it.
import { log } from './toy-log.mjs';

const gates = new Map();
function gateFor(key) {
  let gate = gates.get(key);
  if (!gate) {
    let open = null;
    const promise = new Promise((resolve) => { open = resolve; });
    gate = { promise, open };
    gates.set(key, gate);
  }
  return gate;
}
function release(key, value) {
  const gate = gateFor(key);
  gates.delete(key);
  gate.open(value);
}
// Each async layer puts promise generations between the gate and the waiter.
async function through(promise, depth) {
  return depth === 0 ? promise : through(promise, depth - 1);
}

export function gateState() {
  return { waiting: [...gates.keys()] };
}

export async function wait(key) {
  const value = await gateFor(key).promise;
  log('woke', `${key}:${value}`);
  return value;
}

export async function eager(key) {
  log('woke', `${key}:eager`);
  return 'eager';
}

export async function waitDeep(key, depth) {
  const value = await through(gateFor(key).promise, depth);
  log('woke-deep', `${key}:${value}`);
  return value;
}

export async function waitOn(promise) {
  const value = await promise;
  log('woke', String(value));
  return value;
}

export function signal(key, value) {
  log('signal', key);
  release(key, value);
  return true;
}

export function arm(key, ms, value) {
  setTimeout(() => { log('fire', key); release(key, value); }, ms);
  return ms;
}

export async function ask(sdk, key) {
  const answer = await sdk.request(key);
  log('answered', `${key}:${answer}`);
  return answer;
}

export function poke(sdk) {
  return sdk.flush();
}

// A negative control that yields twice before acting: still its own call's.
export async function eagerLater(key) {
  await null;
  await null;
  log('woke', `${key}:later`);
  return 'later';
}

// Gates made by Promise.withResolvers.
const resolverGates = new Map();
function resolverGate(key) {
  if (!resolverGates.has(key)) resolverGates.set(key, Promise.withResolvers());
  return resolverGates.get(key);
}
export async function waitResolvers(key) {
  const value = await resolverGate(key).promise;
  log('woke-resolvers', `${key}:${value}`);
  return value;
}
export function signalResolvers(key, value) {
  log('signal', key);
  const gate = resolverGate(key);
  resolverGates.delete(key);
  gate.resolve(value);
  return true;
}

// A waiter that, once released, takes `turns` silent promise generations before it acts.
export async function waitLong(key, turns) {
  const value = await gateFor(key).promise;
  for (let turn = 0; turn < turns; turn += 1) await null;
  log('woke-long', `${key}:${value}`);
  return value;
}

// Engine code handed to the test: a closure, an async iterator, a getter, a thenable.
export function subscribe(key) {
  log('subscribe', key);
  return () => log('unsubscribe', key);
}
export async function* items(list) {
  for (const item of list) {
    await null;
    log('item', item);
    yield item;
  }
}
class Meter {
  #reads = 0;
  get reading() { this.#reads += 1; log('read', String(this.#reads)); return this.#reads; }
}
export function meter() {
  return new Meter();
}
export function promiseLike(key) {
  return { then(resolve) { log('then', key); resolve(key); } };
}
// Engine code the recorder does not wrap: a function deep inside plain data, and a member of a frozen object.
export function nested(key) {
  return { inner: { deep: { run: () => log('deep', key) } } };
}
export function frozenControls(key) {
  return Object.freeze({ stop: () => log('stop', key) });
}

// A port's answer the engine awaits but that port code itself resolves.
export async function start(sdk) {
  const { done } = sdk.start();
  const value = await done;
  log('done', String(value));
  return value;
}
// A stream a port answers: each item is an input when the port's answers are wrapped.
export async function drainOpen(stream) {
  const { items: source } = await stream.open();
  const seen = [];
  for await (const item of source) {
    log('item', String(item));
    seen.push(item);
  }
  return seen;
}
