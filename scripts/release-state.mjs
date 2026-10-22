// Same-version release state, the published-bytes ledger and the shipped
// updater discovery contract, as pure functions over GitHub release JSON.
// scripts/release.mjs applies them in preflight, stage, publish and
// verify-published; docs/RELEASE_PIPELINE.md describes the states.
import fs from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { RELEASE_REPOSITORY, RELEASE_VERSION_PATTERN, releaseAssetName } from '../packages/electron/release-assets.mjs';
import { discoverDesktopUpdate } from '../packages/electron/desktop-updater.mjs';

export const LEDGER_TAG_PREFIX = 'devryan-release/';
const MARKER = /devryan-release: version=(\d+\.\d+\.\d+) sha256=([a-f0-9]{64}) size=(\d+) source=([a-f0-9]{40}) run=(\d+)\/(\d+)/;

/** One line recording the bytes a version was (or is about to be) published with. */
export function formatReleaseMarker({ version, sha256, size, source, runId, runAttempt }) {
  const marker = `devryan-release: version=${version} sha256=${sha256} size=${size} source=${source} run=${runId}/${runAttempt}`;
  const parsed = parseReleaseMarker(marker);
  if (!parsed || parsed.version !== version || parsed.sha256 !== sha256) throw new Error('Invalid release marker fields');
  return marker;
}

export function parseReleaseMarker(text) {
  const match = MARKER.exec(String(text ?? ''));
  if (!match || !RELEASE_VERSION_PATTERN.test(match[1])) return null;
  return { version: match[1], sha256: match[2], size: Number(match[3]), source: match[4], runId: match[5], runAttempt: match[6] };
}

export const ledgerTagName = version => `${LEDGER_TAG_PREFIX}v${version}`;

/** The release notes plus the marker comment that names the staged bytes. */
export const releaseBody = (notes, marker) => `${notes}\n\n<!-- ${marker} -->\n`;

const refuse = (reason, message) => ({ action: 'refuse', reason, message });

/**
 * What a run may do with version `version` (docs/RELEASE_PIPELINE.md,
 * "Same-version retries").
 *
 * releases: every GitHub release whose tag is v<version>, with its assets.
 * ledger:   the parsed devryan-release ledger tag, or null when none exists.
 * source:   this run's source commit; targetCommitish is what a release made
 *           by this run records (the source SHA, or the staging branch).
 * sha256:   the candidate DMG digest; omitted at preflight, before the build.
 */
export function releaseState({ version, releases, ledger, source, targetCommitish = source, sha256 }) {
  const name = releaseAssetName('macos-arm64', version);
  const digestOf = release => release.assets?.find(asset => asset.name === name)?.digest ?? null;
  const sameSource = release => release.target_commitish === targetCommitish
    && (parseReleaseMarker(release.body)?.source ?? source) === source;
  const published = releases.filter(release => release.draft === false);
  if (published.length > 1) return refuse('duplicate-published', `v${version} has ${published.length} published releases; a published version is final, so bump the patch version.`);
  if (published.length === 1) {
    const [release] = published;
    const digest = digestOf(release);
    if (!sameSource(release) || release.prerelease === true) return refuse('published-different-source', `v${version} is already published from another source; bump the patch version.`);
    if (ledger && digest !== `sha256:${ledger.sha256}`) return refuse('published-bytes-replaced', `v${version} was published as sha256:${ledger.sha256} (run ${ledger.runId}) but now serves ${digest ?? 'no installer'}. Published bytes were replaced outside the pipeline; bump the patch version.`);
    if (sha256 && digest !== `sha256:${sha256}`) return refuse('published-different-bytes', `v${version} is published as ${digest ?? 'no installer'}, not this candidate's sha256:${sha256}; bump the patch version.`);
    return { action: 'verify-published', release };
  }
  if (ledger) return refuse('ledger-without-release', `v${version} was published as sha256:${ledger.sha256} by run ${ledger.runId}, and that release no longer exists. Deleted releases are never re-created; bump the patch version.`);
  const drafts = releases.filter(release => release.draft === true).sort((left, right) => right.id - left.id);
  if (!drafts.length) return { action: 'create' };
  const [draft] = drafts;
  const asset = draft.assets?.find(row => row.name === name);
  if (sha256 && sameSource(draft) && asset?.state === 'uploaded' && asset.digest === `sha256:${sha256}`) return { action: 'reuse-draft', release: draft, stale: drafts.slice(1) };
  return { action: 'replace-draft', release: draft, stale: drafts.slice(1) };
}

/**
 * The release as installed updaters would see it from the canonical
 * repository. A staging repository's own URLs are mapped onto the canonical
 * ones, and with `asPublished` a draft (whose URLs use an untagged-* name) is
 * shown as published. Any other URL is left alone, so a wrong html_url or
 * download URL still fails discovery.
 */
export function projectForDiscovery(payload, { repository, version, asPublished = false }) {
  const tag = `v${version}`;
  const own = `https://github.com/${repository}/releases`;
  const canonical = `https://github.com/${RELEASE_REPOSITORY}/releases`;
  const names = [tag, ...(asPublished && payload.draft === true ? [/^untagged-[A-Za-z0-9-]+$/] : [])];
  const ownTag = value => names.some(name => typeof name === 'string' ? value === name : name.test(value));
  const page = String(payload.html_url ?? '');
  const html = page.startsWith(`${own}/tag/`) && ownTag(page.slice(`${own}/tag/`.length)) ? `${canonical}/tag/${tag}` : payload.html_url;
  const assets = Array.isArray(payload.assets) ? payload.assets.map(asset => {
    const url = String(asset?.browser_download_url ?? '');
    const [segment, file, ...rest] = url.startsWith(`${own}/download/`) ? url.slice(`${own}/download/`.length).split('/') : [];
    return segment && !rest.length && ownTag(segment) && file === asset.name ? { ...asset, browser_download_url: `${canonical}/download/${tag}/${file}` } : asset;
  }) : payload.assets;
  return { ...payload, ...(asPublished ? { draft: false } : {}), html_url: html, assets };
}

/**
 * Every discovery implementation an installed, supported app runs: this
 * checkout's and each shipped release's (verbatim copies under
 * scripts/fixtures/shipped-updater, verified against their tags by preflight).
 */
export const SHIPPED_DISCOVERY_TAGS = Object.freeze(['v2.1.9']);
const SHIPPED_ROOT = new URL('./fixtures/shipped-updater/', import.meta.url);

/** Git's object id for a file's bytes, so a vendored copy can be compared with `git rev-parse <tag>:<path>`. */
export const gitBlobId = bytes => createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');

/**
 * Problems with the vendored shipped discovery copies: a file that differs
 * from the blob recorded in shipped.json, or (with `tagBlob`, which reads the
 * repository's git objects) a recorded blob that is not what the tag shipped.
 */
export async function shippedDiscoveryFixtureProblems({ tagBlob } = {}) {
  const recorded = JSON.parse(await fs.readFile(new URL('shipped.json', SHIPPED_ROOT), 'utf8'));
  const problems = [];
  if (Object.keys(recorded).sort().join() !== [...SHIPPED_DISCOVERY_TAGS].sort().join()) problems.push(`shipped.json lists ${Object.keys(recorded).join(', ')}, not ${SHIPPED_DISCOVERY_TAGS.join(', ')}`);
  for (const [tag, files] of Object.entries(recorded)) {
    for (const [file, blob] of Object.entries(files)) {
      const local = gitBlobId(await fs.readFile(fileURLToPath(new URL(`${tag}/${file}`, SHIPPED_ROOT))).catch(() => Buffer.alloc(0)));
      if (local !== blob) problems.push(`${tag}/${file} is not the recorded blob ${blob}`);
      if (tagBlob) {
        const shipped = await tagBlob(tag, file);
        if (shipped !== blob) problems.push(`${tag}:${file} is ${shipped ?? 'missing'}, not the recorded ${blob}`);
      }
    }
  }
  return problems;
}

/** The CFBundleIdentifier values the shipped installer of `tag` accepts for a downloaded candidate app. */
export async function shippedAcceptedBundleIds(tag) {
  const source = await fs.readFile(new URL(`${tag}/packages/electron/desktop-update-install.mjs`, SHIPPED_ROOT), 'utf8');
  const match = /\[([^\]]+)\]\.includes\(info\.CFBundleIdentifier\)/.exec(source);
  if (!match) throw new Error(`Cannot read the bundle identifiers the ${tag} installer accepts`);
  return [...match[1].matchAll(/'([^']+)'/g)].map(literal => literal[1]);
}

export async function shippedDiscoveries() {
  const shipped = await Promise.all(SHIPPED_DISCOVERY_TAGS.map(async tag => ({ label: tag,
    discoverDesktopUpdate: (await import(new URL(`${tag}/packages/electron/desktop-updater.mjs`, SHIPPED_ROOT).href)).discoverDesktopUpdate })));
  return [{ label: 'current', discoverDesktopUpdate }, ...shipped];
}

/**
 * Run every shipped discovery against a projected release and require each to
 * offer exactly the expected installer to an app that predates it.
 */
export async function assertShippedDiscovery(payload, expected, { discoveries } = {}) {
  const found = [];
  for (const { label, discoverDesktopUpdate: discover } of discoveries ?? await shippedDiscoveries()) {
    let update;
    try { update = discover(payload, { currentVersion: '0.0.0', platform: 'darwin', arch: 'arm64' }); }
    catch (error) { throw new Error(`Shipped discovery ${label} rejected the release: ${error.code ?? error.name}: ${error.message}`, { cause: error }); }
    const offered = { version: update?.version, name: update?.name, sha256: update?.sha256, size: update?.size };
    if (JSON.stringify(offered) !== JSON.stringify(expected)) throw new Error(`Shipped discovery ${label} found ${JSON.stringify(offered)}, expected ${JSON.stringify(expected)}`);
    found.push({ label, update });
  }
  return found;
}
