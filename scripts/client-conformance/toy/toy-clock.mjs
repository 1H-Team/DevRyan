// Harness-owned toy clock module (self-test corpus of the client
// conformance harness): it reads every clock and random source, sets a
// timer, fetches and reads navigator, so the tests can install each kind of
// stub a product test uses. Product code never imports it.
export function readClock() {
  return [Date.now(), new Date().getTime(), performance.now()];
}

export function roll() {
  return [Math.random(), crypto.randomUUID(), crypto.getRandomValues(new Uint8Array(2))];
}

export function later(ms) {
  return new Promise((resolve) => { setTimeout(() => resolve(Date.now()), ms); });
}

export async function ping(url) {
  const response = await fetch(url);
  return response.status;
}

export function online() {
  return navigator.onLine;
}
