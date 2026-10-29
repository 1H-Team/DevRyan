import fs from 'node:fs/promises';
import path from 'node:path';

// The core sources the native build rewrites, found by content instead of their
// hashed chunk filenames, which change with every OpenCode release. Discovery only
// locates a file: each rewrite still requires its exact reviewed SHA-256.
export const NATIVE_CORE_SOURCE_SIGNATURES = Object.freeze({
  pty: 'import { binaryPath } from "@opencode/pty";',
  compaction: 'Effect.fn("SessionCompaction.compact")',
  finalization: 'if (llmFailure && llmError && retry?.retry && record.outputStarted',
});
// Loaded through a literal dynamic import, so it keeps its own module path.
export const NATIVE_PHOTON_WORKER_SOURCE = 'dist/image/photon.js';
export const isNativePhotonWorkerSource = file => /@opencode[\\/]core[\\/]dist[\\/]image[\\/]photon\.js$/.test(file);

/** Absolute paths of the pinned chunks in one core installation; exactly one match each. */
export async function findNativeCoreSources(coreRoot) {
  const directory = path.join(coreRoot, 'dist/chunks');
  const matches = Object.fromEntries(Object.keys(NATIVE_CORE_SOURCE_SIGNATURES).map(kind => [kind, []]));
  for (const name of (await fs.readdir(directory)).filter(name => name.endsWith('.js')).sort()) {
    const text = await fs.readFile(path.join(directory, name), 'utf8');
    for (const [kind, signature] of Object.entries(NATIVE_CORE_SOURCE_SIGNATURES)) if (text.includes(signature)) matches[kind].push(path.join(directory, name));
  }
  for (const [kind, files] of Object.entries(matches)) {
    if (files.length !== 1) throw new Error(`native_core_source_${kind}_${files.length ? 'ambiguous' : 'missing'}`);
  }
  return Object.freeze({ pty: matches.pty[0], compaction: matches.compaction[0], finalization: matches.finalization[0] });
}

const escape = value => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/** A Bun onLoad filter matching exactly these chunk basenames. */
export const nativeCoreSourceFilter = (...files) => new RegExp(`(?:^|[\\\\/])(?:${files.map(file => escape(path.basename(file))).join('|')})$`);
