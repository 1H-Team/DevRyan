import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';

// Offline fixture: execute the pinned SDK implementation without loading its
// transport or making a provider request.
const source = await readFile(new URL('../node_modules/@cursor/sdk/dist/esm/index.js', import.meta.url), 'utf8');
const manifest = JSON.parse(await readFile(new URL('../node_modules/@cursor/sdk/package.json', import.meta.url), 'utf8'));
const key = './src/agent/run-interaction-accumulator.ts';
const start = source.indexOf(JSON.stringify(key) + '(e,t,n){');
const end = source.indexOf('},"./src/agent/sdk-config.ts"', start);
if (manifest.version !== '1.0.28' || start < 0 || end < start) throw Error('Pinned SDK result witness changed');
export const pinnedAccumulatorSource = `(() => {
  const module = ({${source.slice(start, end + 1)}})[${JSON.stringify(key)}];
  const exports = {};
  const require = () => ({ w: () => undefined });
  require.d = (target, getters) => { for (const [name, getter] of Object.entries(getters)) Object.defineProperty(target, name, { get: getter }); };
  module({}, exports, require);
  return exports.e4;
})()`;
export const PinnedAccumulator = runInNewContext(pinnedAccumulatorSource);
