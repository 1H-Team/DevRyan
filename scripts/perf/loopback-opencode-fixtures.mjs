// Only the verified OpenCode 2 wire contract is runnable in QA and performance fixtures.
import { createLoopbackOpenCodeV2Fixture } from './loopback-opencode-v2-fixture.mjs';

export const LOOPBACK_OPENCODE_FIXTURE_GENERATIONS = Object.freeze([2]);

/** @param {unknown} generation @returns {2} */
export const resolveLoopbackOpenCodeFixtureGeneration = (generation) => {
  if (generation === 2 || generation === '2') return 2;
  throw new Error(`Unsupported loopback OpenCode fixture generation: ${String(generation)}`);
};

/**
 * @param {2 | '2'} generation
 * @param {Parameters<typeof createLoopbackOpenCodeV2Fixture>[0]} options
 */
export const createLoopbackOpenCodeFixtureForGeneration = async (generation, options) => {
  resolveLoopbackOpenCodeFixtureGeneration(generation);
  const fixture = await createLoopbackOpenCodeV2Fixture(options);
  return { ...fixture, runtimeEnv: Object.freeze({ DEVRYAN_OPENCODE_GENERATION: '2', OPENCODE_SERVER_PASSWORD: fixture.password }) };
};
