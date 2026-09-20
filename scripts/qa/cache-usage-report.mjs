// Read-only report over retained journals and optional wire evidence. It never
// initializes a runtime, prunes a journal, or reads installed account state.
import fs from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { createGunzip } from 'node:zlib';
import { createInterface } from 'node:readline';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createUsageCollector } from '../../packages/harness-runtime/lib/usage.js';

export async function readCacheUsageReport(inputs) {
  const collector = createUsageCollector();
  const visit = async input => {
    const stat = await fs.lstat(input);
    if (stat.isSymbolicLink()) throw new Error('Usage report does not follow symlinks');
    if (stat.isDirectory()) {
      for (const name of (await fs.readdir(input)).sort()) if (!name.endsWith('.blobs') && name !== 'blobs') await visit(path.join(input, name));
      return;
    }
    if (!/\.ndjson(?:\.gz)?$/.test(input)) return;
    if (stat.size > 128 * 1024 * 1024) { collector.add({ type: 'gap' }); return; }
    const stream = createReadStream(input), decoded = input.endsWith('.gz') ? stream.pipe(createGunzip()) : stream;
    const lines = createInterface({ input: decoded, crlfDelay: Infinity });
    let bytes = 0;
    try {
      for await (const line of lines) {
        bytes += Buffer.byteLength(line);
        if (bytes > 128 * 1024 * 1024) { collector.add({ type: 'gap' }); break; }
        if (!line.trim()) continue;
        try { const row = JSON.parse(line); collector.add(row); }
        catch { collector.add({ type: 'gap' }); }
      }
    } finally { lines.close(); decoded.destroy(); stream.destroy(); }
  };
  for (const input of inputs) await visit(path.resolve(input));
  return collector.finish();
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const inputs = process.argv.slice(2);
  if (!inputs.length) throw new Error('Usage: node scripts/qa/cache-usage-report.mjs JOURNAL_OR_NDJSON [WIRE_NDJSON]');
  console.log(JSON.stringify(await readCacheUsageReport(inputs), null, 2));
}
