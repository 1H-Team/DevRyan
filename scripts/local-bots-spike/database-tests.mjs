import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { localDatabase, parityDatabase, repository, sql, workspace } from './fixtures.mjs';

const targets = process.argv.slice(2);
if (!targets.length || targets.some((target) => !['local', 'supabase'].includes(target))) {
  throw new Error('Specify local and/or supabase; no arbitrary database targets are accepted');
}
let failed = false;
for (const target of targets) {
  let assertions = 0;
  const database = target === 'local' ? localDatabase : parityDatabase;
  const names = readdirSync(path.join(repository, 'supabase/tests')).filter((name) => name.includes('bot') && name.endsWith('.sql')).sort();
  for (const filename of names) {
    let result;
    try { result = sql(database, readFileSync(path.join(repository, 'supabase/tests', filename), 'utf8')); }
    catch (error) {
      result = String(error.stdout || '') + String(error.stderr || '');
      failed = true;
    }
    writeFileSync(path.join(workspace, `${target}-${filename}.log`), result, { mode: 0o600 });
    const lines = result.split('\n');
    const count = lines.filter((line) => /^ok \d+\b/.test(line)).length;
    const failures = lines.filter((line) => /^not ok \d+\b|ERROR:|^# Failed/.test(line));
    const plan = lines.find((line) => /^1\.\.\d+$/.test(line));
    const passed = failures.length === 0 && plan && Number(plan.slice(3)) === count;
    failed ||= !passed;
    assertions += count;
    console.log(`${target}: ${filename}: ${passed ? 'PASS' : 'FAIL'} (${count} assertions)`);
    for (const line of failures) console.log(line);
  }
  console.log(`${target}: ${names.length} SQL files, ${assertions} passing assertions`);
}
if (failed) process.exitCode = 1;
