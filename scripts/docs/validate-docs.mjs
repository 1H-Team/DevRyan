import { readdir, readFile } from "node:fs/promises"
import path from "node:path"
import { execFileSync } from "node:child_process"
import { existsSync } from "node:fs"
import { isHistoricalDocument, validateRepositoryLinks } from "./repository-links.mjs"
import { docRetentionErrorMessages } from "./doc-retention.mjs"
import { validateHeadingAnchors } from "./heading-anchors.mjs"
import { validateBunRunScripts } from "./bun-run-scripts.mjs"
import { validateExportSections } from "./export-sections.mjs"
import { validateEnvTokens } from "./env-tokens.mjs"
import { DRIFT_CHECKS, compareWithBaseline, describeEntry, pruneBaseline, readBaseline } from "./known-drift.mjs"

const repoRoot = path.resolve(import.meta.dirname, "..", "..")
const docsRoot = path.join(repoRoot, "packages", "docs")
const contentRoot = path.join(docsRoot, "content", "docs")
const sidebarPath = path.join(docsRoot, "sidebar.config.json")
const baselinePath = path.join(import.meta.dirname, "known-drift.json")

// Read-only, except `--prune`, which deletes baseline entries that no longer occur.
const args = process.argv.slice(2)
const prune = args.includes("--prune")
const unknownArgs = args.filter((arg) => arg !== "--prune")
if (unknownArgs.length > 0) {
  console.error(`Usage: node scripts/docs/validate-docs.mjs [--prune]  (unknown: ${unknownArgs.join(" ")})`)
  process.exit(2)
}

async function walk(dir) {
  const entries = await readdir(dir, { withFileTypes: true })
  const files = await Promise.all(
    entries.map(async (entry) => {
      const target = path.join(dir, entry.name)
      if (entry.isDirectory()) return walk(target)
      return [target]
    }),
  )
  return files.flat()
}

function toPosix(value) {
  return value.split(path.sep).join("/")
}

function routeFromFile(filePath) {
  const relative = toPosix(path.relative(contentRoot, filePath))
  const withoutExt = relative.replace(/\.mdx$/, "")

  if (withoutExt === "index") return "/"
  if (withoutExt.endsWith("/index")) {
    return `/${withoutExt.slice(0, -"/index".length)}/`
  }

  return `/${withoutExt}/`
}

function hasFrontmatterKey(content, key) {
  const hit = /^---\n([\s\S]*?)\n---\n/m.exec(content)
  if (!hit) return false
  return new RegExp(`^${key}:\\s*.+$`, "m").test(hit[1])
}

// Drift checks against the shrink-only baseline (known-drift.mjs). The changelog
// records past checkouts, so it is not held to current scripts, exports or variables.
function checkDrift(repositoryFiles) {
  const files = repositoryFiles.filter((file) => !isHistoricalDocument(file))
  const violations = [
    ...validateHeadingAnchors(repoRoot, files),
    ...validateBunRunScripts(repoRoot, files),
    ...validateExportSections(repoRoot, files),
    ...validateEnvTokens(repoRoot, files),
  ]
  const errors = []
  const { entries: baseline, canonical } = readBaseline(baselinePath)
  const { added, stale, counts } = compareWithBaseline(violations, baseline)
  const relativeBaseline = toPosix(path.relative(repoRoot, baselinePath))
  let staleLeft = stale
  if (prune && (stale.length > 0 || !canonical)) {
    const removed = pruneBaseline(baselinePath, baseline, stale)
    for (const entry of removed) console.log(`Pruned from ${relativeBaseline}: ${describeEntry(entry)}`)
    staleLeft = []
  } else if (!canonical) {
    errors.push(`${relativeBaseline}: entries must be unique and sorted by check, doc and token, one per line; run \`bun run docs:validate --prune\` to rewrite it`)
  }
  for (const check of DRIFT_CHECKS) {
    const remaining = baseline.filter((entry) => entry.check === check).length - (prune ? stale.filter((entry) => entry.check === check).length : 0)
    console.log(`Docs drift ${check}: ${counts[check].added} new, ${counts[check].known} known (${remaining} in baseline)`)
  }
  for (const entry of added) {
    errors.push(`${describeEntry(entry)} (new drift: fix the document; ${relativeBaseline} only shrinks)`)
  }
  for (const entry of staleLeft) {
    errors.push(`${relativeBaseline}: entry no longer occurs, delete it: ${describeEntry(entry)} (or run \`bun run docs:validate --prune\`)`)
  }
  return errors
}

async function run() {
  const filePaths = (await walk(contentRoot)).filter((p) => p.endsWith(".mdx"))
  const routeSet = new Set()
  const errors = []

  for (const filePath of filePaths) {
    const body = await readFile(filePath, "utf8")
    const relative = toPosix(path.relative(repoRoot, filePath))
    const route = routeFromFile(filePath)
    routeSet.add(route)

    if (!hasFrontmatterKey(body, "title")) {
      errors.push(`${relative}: missing frontmatter key 'title'`)
    }
    if (!hasFrontmatterKey(body, "description")) {
      errors.push(`${relative}: missing frontmatter key 'description'`)
    }
  }

  const sidebarRaw = await readFile(sidebarPath, "utf8")
  const sidebar = JSON.parse(sidebarRaw)
  const links = (sidebar.sections ?? [])
    .flatMap((section) => section.items ?? [])
    .map((item) => item.link)

  for (const link of links) {
    if (!routeSet.has(link)) {
      errors.push(`sidebar link has no page: ${link}`)
    }
  }

  const repositoryFiles = [...new Set(execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], { cwd: repoRoot, encoding: 'utf8' }).split('\0'))]
    .filter((file) => /\.mdx?$/.test(file) && !/(?:^|\/)(?:node_modules|dist|dist-bundle|target|\.cache|\.tmp)\//.test(file) && existsSync(path.join(repoRoot, file)))
  const repository = validateRepositoryLinks(repoRoot, repositoryFiles, { siteRoutes: routeSet })
  errors.push(...repository.errors)
  for (const warning of repository.warnings) console.warn(`Docs warning: ${warning}`)
  errors.push(...docRetentionErrorMessages(repoRoot))
  errors.push(...checkDrift(repositoryFiles))

  if (errors.length > 0) {
    console.error("Docs validation failed:")
    for (const error of errors) {
      console.error(`- ${error}`)
    }
    process.exit(1)
  }

  console.log(`Docs validation passed: ${filePaths.length} pages, ${links.length} sidebar links; ${repositoryFiles.length} repository documents, ${repository.checked} local references.`)
}

run().catch((error) => {
  console.error(error)
  process.exit(1)
})
