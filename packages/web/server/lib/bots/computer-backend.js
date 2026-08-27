export const BOT_COMPUTER_BACKEND_VERSION = 1;

export function createBotComputerBackend({ kind, ensure, inspect, stop } = {}) {
  if (!['docker', 'apple_virtualization'].includes(kind)
    || typeof ensure !== 'function'
    || typeof inspect !== 'function'
    || typeof stop !== 'function') {
    throw new TypeError('Bot computer backend is misconfigured');
  }
  return Object.freeze({
    version: BOT_COMPUTER_BACKEND_VERSION,
    kind,
    ensure,
    inspect,
    stop,
  });
}

export function createDockerBotComputerBackend({ dockerProvider } = {}) {
  if (!dockerProvider) throw new TypeError('Bot Docker computer backend is misconfigured');
  return createBotComputerBackend({
    kind: 'docker',
    ensure: (input) => dockerProvider.ensureComputer(input),
    inspect: (input) => dockerProvider.inspectComputer(input),
    stop: (input) => dockerProvider.stopComputer(input),
  });
}
