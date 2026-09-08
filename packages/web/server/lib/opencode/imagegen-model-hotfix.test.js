import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { applyImagegenModelHotfix } from './imagegen-model-hotfix.js';

const source = 'var SUBSCRIPTION_MODEL = "gpt-5.5";\nconst body = {\n    model: SUBSCRIPTION_MODEL,\n    stream: true\n};\n';
const roots = [];
function fixture(version = '0.1.12') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'devryan-imagegen-'));
  roots.push(root);
  const packageRoot = path.join(root, 'node_modules/opencode-gpt-imagegen');
  fs.mkdirSync(path.join(packageRoot, 'dist'), { recursive: true });
  fs.writeFileSync(path.join(packageRoot, 'package.json'), JSON.stringify({ version }));
  const entry = path.join(packageRoot, 'dist/index.js');
  fs.writeFileSync(entry, source);
  return { entry, options: { configDirectory: root, expectedOriginalSha256: crypto.createHash('sha256').update(source).digest('hex') } };
}
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });

describe('image generation model patch', () => {
  it.each(['0.1.10', '0.1.12'])('atomically patches reviewed %s and remains idempotent', version => {
    const { entry, options } = fixture(version);
    const linked = `${entry}.cache-link`;
    fs.linkSync(entry, linked);
    expect(applyImagegenModelHotfix(options)).toMatchObject({ ok: true, changed: true, model: 'gpt-6-astra', reasoningEffort: 'medium' });
    expect(fs.readFileSync(entry, 'utf8')).toContain('reasoning: { effort: "medium" }');
    expect(fs.readFileSync(linked, 'utf8')).toBe(source);
    expect(applyImagegenModelHotfix(options)).toMatchObject({ ok: true, changed: false });
  });
  it('refuses unknown versions and source modifications without writing', () => {
    const { entry, options } = fixture('0.1.99');
    expect(applyImagegenModelHotfix(options).ok).toBe(false);
    expect(fs.readFileSync(entry, 'utf8')).toBe(source);
    const known = fixture();
    fs.appendFileSync(known.entry, '// personal edit');
    expect(applyImagegenModelHotfix(known.options).ok).toBe(false);
    expect(fs.readFileSync(known.entry, 'utf8')).toBe(`${source}// personal edit`);
  });
  it('refuses a partial patch and unreviewed source even when anchors match', () => {
    const { entry, options } = fixture();
    fs.writeFileSync(entry, source.replace('gpt-5.5', 'gpt-6-astra'));
    expect(applyImagegenModelHotfix(options)).toMatchObject({ ok: false, error: expect.stringContaining('incomplete') });
    fs.writeFileSync(entry, source);
    expect(applyImagegenModelHotfix({ configDirectory: options.configDirectory }).ok).toBe(false);
  });
  it('preserves the original on failed atomic replacement and removes the temporary file', () => {
    const { entry, options } = fixture();
    expect(applyImagegenModelHotfix({ ...options, fs: { ...fs, renameSync: () => { throw new Error('fixture'); } } }).ok).toBe(false);
    expect(fs.readFileSync(entry, 'utf8')).toBe(source);
    expect(fs.readdirSync(path.dirname(entry))).toEqual(['index.js']);
  });
});
