// Resolves the UI's `@/` tsconfig alias to packages/ui/src for recording.
import { existsSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
const SRC = process.env.RA_UI_SRC
export async function resolve(specifier, context, next) {
  if (specifier.startsWith('@/')) {
    const base = `${SRC}/${specifier.slice(2)}`
    for (const candidate of [base, `${base}.ts`, `${base}.tsx`, `${base}/index.ts`]) {
      if (existsSync(candidate) && !candidate.endsWith('/')) {
        try { return await next(pathToFileURL(candidate).href, context) } catch {}
      }
    }
  }
  return next(specifier, context)
}
