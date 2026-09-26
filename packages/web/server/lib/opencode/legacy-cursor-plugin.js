import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { applyEdits, modify, parse } from 'jsonc-parser';

// Audited standalone open-cursor bundle observed on 2026-09-25. Never retire
// an arbitrary plugin by filename: modified copies remain user-owned.
export const LEGACY_CURSOR_PLUGIN_HASH = '954ceb8ef4de6ac2cb3e95d81d56a11bda58d396d2dd7756915724e193d8f622';
// open-cursor's installer symlinks the auto-discovered plugin to its package
// entrypoint by default (--copy is opt-in). Such a link holds no user code, so
// it is retired whatever package version it points at.
const OPEN_CURSOR_ENTRYPOINT = path.join('@rama_nigg', 'open-cursor', 'dist', 'plugin-entry.js');
const digest = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');
const names = ['plugin/cursor-acp.js', 'plugins/cursor-acp.js'];
const retiredName = (name) => `.openchamber/retired-plugins/${name.replaceAll('/', '-')}`;
const byteBackupName = (name, hash) => `${retiredName(name)}.${hash}.disabled`;
const linkBackupName = (name) => `${retiredName(name)}.link.json`;
const localRegistration = (entry, directory) => {
  const spec = Array.isArray(entry) ? entry[0] : entry;
  if (typeof spec !== 'string') return null;
  try {
    if (spec.startsWith('file:')) return fileURLToPath(spec);
    if (path.isAbsolute(spec) || spec.startsWith('./') || spec.startsWith('../')) return path.resolve(directory, spec);
  } catch { /* Not a local file registration. */ }
  return null;
};

// Config is changed before removing auto-discovered copies. An interrupted
// attempt is safe to retry; verified backups also prove ownership of stale
// registrations whose source was already moved. No runtime is restarted here.
// Symlinks are removed as links: nothing is ever written through them.
// `userConfirmed` records the user's explicit choice to retire an unrecognized
// copy; it is still moved to a verified backup, never deleted.
export function retireLegacyCursorPlugin({ configDirectory, fs: io = fs, hashContent = digest, userConfirmed = false }) {
  const result = { ok: true, changed: false, conflicts: [], updated: [], removed: [], backups: [] };
  const conflict = (file) => { result.ok = false; result.conflicts.push(file); };
  const inspect = (file) => {
    let stat;
    try { stat = io.lstatSync(file); } catch (error) { if (error.code === 'ENOENT') return { kind: 'missing' }; throw error; }
    if (stat.isFile()) return { kind: 'file', bytes: io.readFileSync(file) };
    if (stat.isSymbolicLink()) return { kind: 'link', link: io.readlinkSync(file) };
    return { kind: 'other' };
  };
  const readRegular = (file) => {
    const entry = inspect(file);
    if (entry.kind === 'missing') return null;
    if (entry.kind !== 'file') { conflict(file); return null; }
    return entry.bytes;
  };
  const readLinkRecord = (file) => {
    const bytes = readRegular(file);
    if (!bytes) return null;
    try {
      const record = JSON.parse(bytes.toString('utf8'));
      if (typeof record?.link === 'string') return record;
    } catch { /* A damaged record is a conflict below. */ }
    conflict(file);
    return null;
  };
  const isLegacyLink = (source, link) => {
    const target = path.resolve(path.dirname(source), link);
    if (target.endsWith(`${path.sep}${OPEN_CURSOR_ENTRYPOINT}`)) return true;
    try {
      return io.statSync(target).isFile() && hashContent(io.readFileSync(target)) === LEGACY_CURSOR_PLUGIN_HASH;
    } catch (error) {
      if (['ENOENT', 'ENOTDIR', 'ELOOP'].includes(error.code)) return false;
      throw error;
    }
  };
  // Exclusive create and byte checks protect an existing backup; .disabled and
  // .link.json files are never discovered as plugins.
  const writeBackup = (file, bytes) => {
    io.mkdirSync(path.dirname(file), { recursive: true });
    const temporary = `${file}.${crypto.randomUUID()}.tmp`;
    try {
      io.writeFileSync(temporary, bytes, { flag: 'wx', mode: 0o600 });
      io.linkSync(temporary, file);
    } finally { try { io.unlinkSync(temporary); } catch (error) { if (error.code !== 'ENOENT') throw error; } }
    result.changed = true;
  };
  try {
    const candidates = names.map((name) => {
      const source = path.join(configDirectory, name);
      const entry = inspect(source);
      const item = { source, bytes: null, link: null, saved: null, savedLink: null };
      let backupHash = LEGACY_CURSOR_PLUGIN_HASH;
      if (entry.kind === 'file') {
        item.bytes = entry.bytes;
        const hash = hashContent(entry.bytes);
        if (hash !== LEGACY_CURSOR_PLUGIN_HASH) {
          if (userConfirmed) backupHash = hash;
          else conflict(source);
        }
      } else if (entry.kind === 'link') {
        item.link = entry.link;
        if (!userConfirmed && !isLegacyLink(source, entry.link)) conflict(source);
      } else if (entry.kind === 'other') {
        conflict(source);
      }
      item.backup = path.join(configDirectory, byteBackupName(name, backupHash));
      item.linkBackup = path.join(configDirectory, linkBackupName(name));
      item.saved = readRegular(item.backup);
      if (item.saved && hashContent(item.saved) !== backupHash) conflict(item.backup);
      item.savedLink = readLinkRecord(item.linkBackup);
      if (item.savedLink && item.link !== null && item.savedLink.link !== item.link) conflict(item.linkBackup);
      return item;
    });
    const owned = new Set(candidates
      .filter((item) => item.bytes || item.saved || item.link !== null || item.savedLink)
      .map((item) => item.source));
    if (owned.size === 0 && result.ok) return result;
    const edits = [];
    for (const name of ['opencode.json', 'opencode.jsonc', 'config.json']) {
      const file = path.join(configDirectory, name);
      const bytes = readRegular(file);
      if (!bytes) continue;
      const errors = [];
      const source = bytes.toString('utf8');
      const config = parse(source, errors, { allowTrailingComma: true });
      if (errors.length || !config || typeof config !== 'object' || Array.isArray(config)) { conflict(file); continue; }
      if (!Array.isArray(config.plugin)) continue;
      const retained = config.plugin.filter((entry) => !owned.has(localRegistration(entry, configDirectory)));
      if (retained.length === config.plugin.length) continue;
      const next = applyEdits(source, modify(source, ['plugin'], retained, {
        formattingOptions: { insertSpaces: true, tabSize: 2, eol: source.includes('\r\n') ? '\r\n' : '\n' },
      }));
      edits.push({ file, bytes, next });
    }
    if (!result.ok) {
      result.error = 'DEVRYAN_CURSOR_PLUGIN_CONFLICT: preserve and reconcile the unrecognized plugin or configuration';
      return result;
    }
    // Back up the exact code, or the exact link, before any configuration change.
    for (const item of candidates) {
      if (item.bytes && !item.saved) writeBackup(item.backup, item.bytes);
      if (item.bytes || item.saved) result.backups.push(item.backup);
      if (item.link !== null && !item.savedLink) {
        writeBackup(item.linkBackup, `${JSON.stringify({
          link: item.link,
          target: path.resolve(path.dirname(item.source), item.link),
        }, null, 2)}\n`);
      }
      if (item.link !== null || item.savedLink) result.backups.push(item.linkBackup);
    }
    for (const edit of edits) {
      if (!io.readFileSync(edit.file).equals(edit.bytes)) throw new Error('configuration_changed');
      const temporary = `${edit.file}.${crypto.randomUUID()}.tmp`;
      try {
        io.writeFileSync(temporary, edit.next, { flag: 'wx', mode: io.statSync(edit.file).mode & 0o777 });
        io.renameSync(temporary, edit.file);
      } finally { try { io.unlinkSync(temporary); } catch (error) { if (error.code !== 'ENOENT') throw error; } }
      result.changed = true;
      result.updated.push(edit.file);
    }
    for (const item of candidates) {
      if (item.bytes) {
        const current = readRegular(item.source);
        if (!result.ok || !current?.equals(item.bytes) || !io.readFileSync(item.backup).equals(item.bytes)) throw new Error('plugin_changed');
      } else if (item.link !== null) {
        const current = inspect(item.source);
        const record = readLinkRecord(item.linkBackup);
        if (!result.ok || current.kind !== 'link' || current.link !== item.link || record?.link !== item.link) throw new Error('plugin_changed');
      } else {
        continue;
      }
      // unlink removes a symlink itself, never its target.
      io.unlinkSync(item.source);
      result.changed = true;
      result.removed.push(item.source);
    }
    return result;
  } catch {
    return { ...result, ok: false, error: 'DEVRYAN_CURSOR_PLUGIN_MIGRATION_FAILED: retry provisioning; verified plugin backups are retained' };
  }
}
