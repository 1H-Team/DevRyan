// The interim licence gate of the native ledger's workspace, until a shared
// one exists: every package `cargo metadata --locked` resolves must carry a
// licence expression that is, as a whole, one of the expressions below
// (permissive only; nothing of the GPL family), or be the repository's own
// crate (no registry source, inside the workspace or ledger-core).
//
// A new dependency adds its exact expression here in the change that adds
// the dependency, with the crate that needs it.
import path from 'node:path';

/** Whole licence expressions a dependency may carry, and the crates that brought each. */
export const ALLOWED_LICENCE_EXPRESSIONS = Object.freeze({
  'MIT OR Apache-2.0': 'libc; sha1, sha2 and their dependencies (block-buffer, cfg-if, cpufeatures, crypto-common, digest, hybrid-array, typenum) for the object database',
  'MIT OR Zlib OR Apache-2.0': 'miniz_oxide, for the object database',
  '0BSD OR MIT OR Apache-2.0': 'adler2, through miniz_oxide',
});

/** The repository's own crates: no source, a manifest under one of these directories. */
const ownCrate = (entry, roots) => entry.source === null && roots.some((root) => path.resolve(entry.manifest_path).startsWith(`${path.resolve(root)}${path.sep}`));

/**
 * Checks `cargo metadata --format-version 1` output. Returns
 * `{ packages: [{ name, version, licence }], refused: [...] }`.
 */
export function checkLicences(metadata, { ownRoots }) {
  const packages = [], refused = [];
  for (const entry of metadata.packages ?? []) {
    const row = { name: entry.name, version: entry.version, licence: entry.license ?? null };
    packages.push(row);
    if (ownCrate(entry, ownRoots)) continue;
    if (typeof entry.license !== 'string' || !Object.hasOwn(ALLOWED_LICENCE_EXPRESSIONS, entry.license)) refused.push(row);
  }
  packages.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return { packages, refused };
}
