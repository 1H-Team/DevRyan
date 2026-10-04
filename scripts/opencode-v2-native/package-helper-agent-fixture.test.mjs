import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { assertCompiledHelperAgents, compiledHelperAgentIDs, createCompiledHelperAgentFixture } from './package-helper-agent-fixture.mjs';

test('helper fixture retains original owner definitions without provider or model selection', async () => {
  const root = await fs.realpath(await fs.mkdtemp(path.resolve('.cache/v2-validation/helper-agent-fixture-')));
  try {
    const result = await createCompiledHelperAgentFixture({ root });
    const bytes = await fs.readFile(result.evidence.configurationPath);
    const original = JSON.parse(bytes.toString('utf8'));
    assert.deepEqual(result.agents, original.agent);
    assert.equal(result.evidence.configurationSha256, createHash('sha256').update(bytes).digest('hex'));
    assert.deepEqual(result.evidence.helperAgentIDs, compiledHelperAgentIDs);
    assert.ok(result.evidence.configurationPath.startsWith(root + path.sep));
    assert.equal(Object.hasOwn(result.agents, 'orchestrator'), false);
    assert.equal(Object.hasOwn(result.agents, 'fixer'), false);
    for (const name of compiledHelperAgentIDs) {
      assert.deepEqual(result.agents[name].permission, { '*': 'deny' });
      assert.equal(Object.hasOwn(result.agents[name], 'model'), false);
      assert.equal(Object.hasOwn(result.agents[name], 'variant'), false);
    }
    result.agents['devryan-commit'].prompt = 'Changed returned fixture data';
    assert.deepEqual(await fs.readFile(result.evidence.configurationPath), bytes);
    await assert.rejects(createCompiledHelperAgentFixture({ root }), { code: 'EEXIST' });
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('missing production helper or changed tool/model permissions refuses fixture admission', async () => {
  const root = await fs.realpath(await fs.mkdtemp(path.resolve('.cache/v2-validation/helper-agent-refusal-')));
  try {
    const { agents } = await createCompiledHelperAgentFixture({ root });
    for (const mutate of [
      value => { delete value['devryan-commit']; },
      value => { value['devryan-commit'].permission['*'] = 'allow'; },
      value => { value['devryan-title'].model = 'unreviewed/model'; },
      value => { value['devryan-pr'].variant = 'high'; },
    ]) {
      const invalid = structuredClone(agents); mutate(invalid);
      assert.throws(() => assertCompiledHelperAgents(invalid));
    }
    assertCompiledHelperAgents(agents);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});
