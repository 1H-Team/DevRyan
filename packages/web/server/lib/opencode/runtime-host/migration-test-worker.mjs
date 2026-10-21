// Test-only: one warm Bun process per test file that runs migration requests.
// A cold `bun` process spends ~1 s importing the migration graph for every
// request. The request carries every path it touches, so the warm process only
// needs the fixture's launch environment, which is constant within one file.
import fs from 'node:fs/promises';
import readline from 'node:readline';

const { runMigrationRequest } = await import(process.argv[2]);
const lines = readline.createInterface({ input: process.stdin });
process.stdout.write('ready\n');
lines.on('line', async line => {
  const { id, requestFile } = JSON.parse(line);
  try {
    await runMigrationRequest(JSON.parse(await fs.readFile(requestFile, 'utf8')));
    process.stdout.write(JSON.stringify({ id, ok: true }) + '\n');
  } catch (error) {
    process.stdout.write(JSON.stringify({ id, ok: false, error: error instanceof Error ? `${error.name}: ${error.message}\n${error.stack}` : String(error) }) + '\n');
  }
});
