// Resolves the UI's `@/` tsconfig alias to packages/ui/src for recording, and swaps listed
// TypeScript files for prebuilt JavaScript (`RA_TS_OVERRIDES`, `<file.ts>=<file.mjs>` pairs
// separated by `;`): files Node's type stripping refuses (namespaces, parameter properties).
import { existsSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
const SRC = process.env.RA_UI_SRC
const OVERRIDES = new Map((process.env.RA_TS_OVERRIDES ?? '').split(';').filter(Boolean)
  .map((pair) => pair.split('=').map((file) => pathToFileURL(file).href)))
const swap = (result) => (OVERRIDES.has(result.url) ? { ...result, url: OVERRIDES.get(result.url), format: 'module' } : result)
export async function resolve(specifier, context, next) {
  if (specifier.startsWith('@/')) {
    const base = `${SRC}/${specifier.slice(2)}`
    for (const candidate of [base, `${base}.ts`, `${base}.tsx`, `${base}/index.ts`]) {
      if (existsSync(candidate) && !candidate.endsWith('/')) {
        try { return swap(await next(pathToFileURL(candidate).href, context)) } catch {}
      }
    }
  }
  return swap(await next(specifier, context))
}
