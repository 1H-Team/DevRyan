#!/usr/bin/env node
// Error texts of the rust-anything ports. `rust-anything diff` and `fuzz` compare only whether a
// call threw. This replays every recorded case of every crate under packages/native/ported (both
// maps, wrapper crates included), in order, through the original TypeScript and through the
// crate's built module (`index.cjs`), and judges each case the recording expects to throw:
//
// - product: the error was constructed by the unit's code (`new Error(...)`, `new TypeError(...)`,
//   a factory doing so; the stack's first frame sits on a `new <Name>(` in a repository source
//   file). Its class and message must match exactly; a mismatch is a failure.
// - engine: V8 threw it (`Cannot read properties of ...`, `... is not iterable`, JSON.parse).
//   Judged by its throw and class only; a different text is reported as information.
//
// Each crate keeps the reviewed classification in `error-sources.json` (throw sites, file:line).
// A product site that file does not list is a failure until the file is reviewed and rewritten
// with `--write`. Usage, from the repository root:
//
//   node scripts/rust-anything/error-texts.mjs [--write] [--verbose] [crate-dir ...]
//
// Crates that are not built (`rust-anything build <crate>`) or have no recording are listed and
// skipped. Exit status 1 on any failure.
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { createRequire, register } from 'node:module'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
process.env.RA_UI_SRC ??= path.join(repo, 'packages/ui/src')
register(new URL('./alias-hooks.mjs', import.meta.url))
// Extensionless relative imports (`./guards`), as the bundler and rust-anything's recorder allow.
register(`data:text/javascript,${encodeURIComponent(`
export async function resolve(specifier, context, next) {
  try { return await next(specifier, context) } catch (error) {
    if (error?.code !== 'ERR_MODULE_NOT_FOUND' || !/^\\.{1,2}\\//.test(specifier)) throw error
    for (const suffix of ['.ts', '.tsx', '.js', '/index.ts', '/index.js']) {
      try { return await next(specifier + suffix, context) } catch {}
    }
    throw error
  }
}`)}`)

const args = process.argv.slice(2)
const write = args.includes('--write')
const verbose = args.includes('--verbose')
const named = args.filter(a => !a.startsWith("--")).map(a => path.resolve(a)).filter(d => existsSync(path.join(d, "rust-anything.json")))

const findCrates = (dir) => {
  const out = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory() || ['target', '.rust-anything', 'node_modules', 'src'].includes(entry.name)) continue
    const sub = path.join(dir, entry.name)
    if (existsSync(path.join(sub, 'rust-anything.json'))) out.push(sub)
    out.push(...findCrates(sub))
  }
  return out
}
const crates = named.length ? named : findCrates(path.join(repo, 'packages/native/ported')).sort()

// The recording's value markers (as rust-anything's record.mjs decodes them).
const MARKERS = ['$undefined', '$num', '$bigint', '$utf16', '$map', '$set', '$date', '$bytes', '$buffer', '$typed', '$object']
const isMarker = (v) => { const k = Object.keys(v); return k.length === 1 && MARKERS.includes(k[0]) }
const dec = (v) => {
  if (Array.isArray(v)) return v.map(dec)
  if (v === null || typeof v !== 'object') return v
  if (!isMarker(v)) return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, dec(x)]))
  if ('$object' in v) return Object.fromEntries(Object.entries(v.$object).map(([k, x]) => [k, dec(x)]))
  if ('$undefined' in v) return undefined
  if ('$num' in v) return Number(v.$num)
  if ('$bigint' in v) return BigInt(v.$bigint)
  if ('$utf16' in v) return v.$utf16.reduce((s, u) => s + String.fromCharCode(u), '')
  if ('$map' in v) return new Map(v.$map.map(([k, x]) => [dec(k), dec(x)]))
  if ('$set' in v) return new Set(v.$set.map(dec))
  if ('$date' in v) return new Date(v.$date)
  if ('$bytes' in v) return Uint8Array.from(v.$bytes)
  if ('$typed' in v) return globalThis[v.$typed.kind].from(v.$typed.values.map(dec))
  return Buffer.from(v.$buffer)
}

// The pinned clock and random numbers of `record --pin-clock` (same algorithm as record.mjs).
const RealDate = Date
const realRandom = Math.random
const pin = (pinned) => {
  if (!pinned) {
    globalThis.Date = RealDate
    Math.random = realRandom
    return () => {}
  }
  const nowMs = Number(pinned.now_ms)
  const seed = Number(pinned.seed ?? 0) >>> 0
  let state = seed
  class PinnedDate extends RealDate {
    constructor(...a) { super(...(a.length === 0 ? [nowMs] : a)) }
    static now() { return nowMs }
    static [Symbol.hasInstance](v) { return v instanceof RealDate }
  }
  globalThis.Date = new Proxy(PinnedDate, { apply: () => new RealDate(nowMs).toString() })
  Math.random = () => {
    state = (state + 0x6D2B79F5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
  return () => { state = seed }
}

const sourceLines = new Map()
const lineOf = (file, line) => {
  if (!sourceLines.has(file)) sourceLines.set(file, existsSync(file) ? readFileSync(file, 'utf8').split('\n') : [])
  return sourceLines.get(file)[line - 1] ?? ''
}
// Where the original threw, and whether that frame constructs the error.
const siteOf = (error) => {
  if (!(error instanceof Error) && !(error && typeof error === 'object' && 'stack' in error)) {
    return { site: '(a thrown non-Error value)', product: true }
  }
  for (const frame of String(error.stack ?? '').split('\n').slice(1)) {
    const m = /\(?((?:file:\/\/)?\/[^():]+):(\d+):(\d+)\)?\s*$/.exec(frame)
    if (!m) {
      if (/^\s*at /.test(frame)) return { site: frame.trim().replace(/^at /, ''), product: false }
      continue
    }
    const file = m[1].startsWith('file://') ? fileURLToPath(m[1]) : m[1]
    const line = Number(m[2])
    const text = lineOf(file, line).slice(Number(m[3]) - 1)
    return { site: `${path.relative(repo, file)}:${line}`, product: /^new\s+[A-Za-z_$][\w$.]*\s*\(/.test(text) }
  }
  return { site: '(no stack frame)', product: false }
}

const run = async (fn, a) => {
  try { return { ok: await fn(...a) } } catch (error) { return { error } }
}
const nameOf = (e) => (e && typeof e === 'object' && typeof e.name === 'string' ? e.name : typeof e)
const messageOf = (e) => String(e?.message ?? e)
const short = (s, n = 140) => (s.length > n ? `${s.slice(0, n)}…` : s)

let failed = false
const report = []
for (const dir of crates) {
  const label = path.relative(path.join(repo, 'packages/native/ported'), dir) || dir
  const spec = JSON.parse(readFileSync(path.join(dir, 'rust-anything.json'), 'utf8'))
  const casesFile = path.join(dir, 'cases.jsonl')
  if (!existsSync(casesFile)) { report.push(`${label}: no recording (cases.jsonl), skipped`); continue }
  const cases = readFileSync(casesFile, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l))
  if (!cases.some(c => 'error' in c || c.results?.some(r => 'error' in r))) { report.push(`${label}: no recorded throws`); continue }
  if (!readdirSync(dir).some(f => f.endsWith('.node'))) { report.push(`${label}: NOT BUILT (rust-anything build), skipped`); continue }
  const rust = createRequire(path.join(dir, 'index.cjs'))('./index.cjs')
  const at = spec.root.indexOf('/packages/')
  const root = at >= 0 ? path.join(repo, spec.root.slice(at + 1)) : spec.root
  const files = new Map(spec.exports.map(e => [e.name, path.join(root, e.file)]))
  const pinnedFile = path.join(dir, 'pinned.json')
  const resetPin = pin(existsSync(pinnedFile) ? JSON.parse(readFileSync(pinnedFile, 'utf8')) : null)
  const modules = new Map()
  let loadError = null
  const sources = existsSync(path.join(dir, 'error-sources.json'))
    ? JSON.parse(readFileSync(path.join(dir, 'error-sources.json'), 'utf8')) : null
  const listed = new Map([...(sources?.product ?? []).map(s => [s.site, 'product']), ...(sources?.engine ?? []).map(s => [s.site, 'engine'])])
  const seen = new Map()
  const counts = { throws: 0, product: 0, productBad: 0, engine: 0, engineText: 0, engineClass: 0, unlisted: 0, classCases: 0, noThrow: 0 }
  const problems = []
  for (const c of cases) {
    if (c.class) { counts.classCases += 1; continue }
    const file = files.get(c.fn)
    let original = null
    if (file && !loadError) {
      try {
        if (!modules.has(file)) modules.set(file, await import(pathToFileURL(file).href))
        original = modules.get(file)[c.fn]
      } catch (error) { loadError = error }
    }
    resetPin()
    const theirs = original ? await run(original, c.args.map(dec)) : null
    const ours = typeof rust[c.fn] === 'function' ? await run(rust[c.fn], c.args.map(dec)) : { error: new Error(`not exported: ${c.fn}`) }
    if (!('error' in c)) continue
    counts.throws += 1
    const expected = theirs && 'error' in theirs ? theirs.error : null
    const where = expected ? siteOf(expected) : { site: '(original not replayed)', product: false }
    const kind = listed.get(where.site) ?? (where.product ? 'product' : 'engine')
    if (!listed.has(where.site) && expected) {
      if (kind === 'product') counts.unlisted += 1
      seen.set(where.site, { site: where.site, class: nameOf(expected), kind, sample: short(messageOf(expected)) })
    } else if (expected) {
      seen.set(where.site, { site: where.site, class: nameOf(expected), kind, sample: short(messageOf(expected)) })
    }
    const wantMessage = expected ? messageOf(expected) : c.error
    const wantClass = expected ? nameOf(expected) : null
    const gotThrow = 'error' in ours
    const gotMessage = gotThrow ? messageOf(ours.error) : null
    const gotClass = gotThrow ? nameOf(ours.error) : null
    if (kind === 'product') {
      counts.product += 1
      const bad = !gotThrow || gotMessage !== wantMessage || (wantClass !== null && gotClass !== wantClass)
      if (bad) {
        counts.productBad += 1
        problems.push(`  FAIL ${c.fn} at ${where.site}: expected ${wantClass} ${JSON.stringify(short(wantMessage))}, got ${gotThrow ? `${gotClass} ${JSON.stringify(short(gotMessage))}` : 'a return'}`)
      }
    } else {
      counts.engine += 1
      if (!gotThrow) problems.push(`  FAIL ${c.fn}: expected a throw (${wantClass} at ${where.site}), got a return`)
      else {
        if (gotMessage !== wantMessage) counts.engineText += 1
        if (wantClass !== null && gotClass !== wantClass) counts.engineClass += 1
        if (verbose && gotMessage !== wantMessage) problems.push(`  info ${c.fn}: engine text ${JSON.stringify(short(wantMessage, 80))} vs ${JSON.stringify(short(gotMessage, 80))}`)
      }
      if (!gotThrow) counts.noThrow += 1
    }
  }
  if (write && !loadError) {
    const all = [...seen.values()].sort((a, b) => a.site.localeCompare(b.site))
    const doc = {
      note: 'Throw sites of the original reached by this crate\'s recorded throws. product: the code constructs the error (class and message must match); engine: V8 throws it (judged by throw and class). Reviewed against the source; regenerate with scripts/rust-anything/error-texts.mjs --write.',
      unitThrowStatements: [...new Set(files.values())].flatMap((file) => (existsSync(file) ? readFileSync(file, 'utf8').split('\n') : [])
        .map((text, i) => ({ site: `${path.relative(repo, file)}:${i + 1}`, text: text.trim() }))
        .filter(({ text }) => /\bthrow\b/.test(text) && !/^(\/\/|\*)/.test(text))),
      product: all.filter(s => s.kind === 'product').map(({ kind: _kind, ...s }) => s),
      engine: all.filter(s => s.kind === 'engine').map(({ kind: _kind, ...s }) => s),
    }
    writeFileSync(path.join(dir, 'error-sources.json'), `${JSON.stringify(doc, null, 2)}\n`)
  }
  const unlistedFail = !write && counts.unlisted > 0
  const crateFailed = counts.productBad > 0 || counts.noThrow > 0 || unlistedFail || loadError
  if (crateFailed) failed = true
  const parts = [`${counts.throws} throws`, `product ${counts.product} (${counts.productBad} wrong)`,
    `engine ${counts.engine} (text differs ${counts.engineText}, class differs ${counts.engineClass})`]
  if (counts.noThrow) parts.push(`${counts.noThrow} engine throws the port returns from`)
  if (counts.unlisted) parts.push(`${counts.unlisted} at product sites not in error-sources.json`)
  if (counts.classCases) parts.push(`${counts.classCases} class scenarios not replayed`)
  if (loadError) parts.push(`ORIGINAL NOT LOADABLE: ${short(messageOf(loadError), 120)}`)
  report.push(`${crateFailed ? 'FAIL ' : ''}${label}: ${parts.join(', ')}`)
  if (problems.length) report.push(...problems.slice(0, verbose ? problems.length : 8), ...(problems.length > 8 && !verbose ? [`  … ${problems.length - 8} more (--verbose)`] : []))
}
pin(null)
console.log(report.join('\n'))
process.exit(failed ? 1 : 0)
