import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import path from 'node:path';

const DEFAULT_MAX_FILES = 500;
const DEFAULT_MAX_FILE_BYTES = 5 * 1024 * 1024;
const DEFAULT_MAX_TOTAL_BYTES = 25 * 1024 * 1024;
const DEFAULT_MAX_TEXT_BYTES = 2 * 1024 * 1024;
const MAX_EXCLUSIONS = 100;
const SAFE_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._ -]{0,254}$/;
const TEXT_TYPES = new Map([
  ['.c', 'text/plain'],
  ['.cc', 'text/plain'],
  ['.conf', 'text/plain'],
  ['.cpp', 'text/plain'],
  ['.css', 'text/plain'],
  ['.csv', 'text/csv'],
  ['.go', 'text/plain'],
  ['.h', 'text/plain'],
  ['.hpp', 'text/plain'],
  ['.htm', 'text/plain'],
  ['.html', 'text/plain'],
  ['.ini', 'text/plain'],
  ['.java', 'text/plain'],
  ['.js', 'text/plain'],
  ['.json', 'application/json'],
  ['.jsx', 'text/plain'],
  ['.kt', 'text/plain'],
  ['.log', 'text/plain'],
  ['.md', 'text/markdown'],
  ['.markdown', 'text/markdown'],
  ['.mjs', 'text/plain'],
  ['.py', 'text/plain'],
  ['.rb', 'text/plain'],
  ['.rs', 'text/plain'],
  ['.scss', 'text/plain'],
  ['.sh', 'text/plain'],
  ['.sql', 'text/plain'],
  ['.toml', 'text/plain'],
  ['.ts', 'text/plain'],
  ['.tsv', 'text/csv'],
  ['.tsx', 'text/plain'],
  ['.txt', 'text/plain'],
  ['.xml', 'application/xml'],
  ['.yaml', 'text/yaml'],
  ['.yml', 'text/yaml'],
]);
const SECRET_FILE_PATTERNS = Object.freeze([
  /^\.env(?:\.|$)/i,
  /^(?:id_rsa|id_dsa|id_ecdsa|id_ed25519)(?:\.|$)/i,
  /(?:^|[._-])credentials?(?:[._-]|$)/i,
  /\.(?:key|pem|p12|pfx)$/i,
]);
const SECRET_CONTENT_PATTERNS = Object.freeze([
  /-----BEGIN (?:RSA |EC |DSA |OPENSSH )?PRIVATE KEY-----/i,
  /\bAKIA[0-9A-Z]{16}\b/,
  /\b(?:sk|rk|pk)_(?:live|test)_[a-z0-9]{16,}\b/i,
  /\bsk-[a-z0-9_-]{20,}\b/i,
  /\b(?:password|passwd|secret|api[_ -]?key|access[_ -]?token|refresh[_ -]?token)\s*[:=]\s*[^\s'\"]{8,}/i,
  /\b(?:authorization|bearer)\s*[:=]?\s+[a-z0-9._~+/=-]{16,}\b/i,
]);

export class BotSourceScannerError extends Error {
  constructor(message, code = 'bot_library_source_invalid', statusCode = 400, details = null) {
    super(message);
    this.name = 'BotSourceScannerError';
    this.code = code;
    this.statusCode = statusCode;
    this.details = details;
  }
}

const fail = (message, code, statusCode, details = null) => {
  throw new BotSourceScannerError(message, code, statusCode, details);
};

const isWithin = (root, candidate) => candidate === root || candidate.startsWith(`${root}${path.sep}`);

const validateSelectedPath = (value) => {
  if (typeof value !== 'string' || value.length < 1 || value.length > 4_096
    || value.includes('\0') || !path.isAbsolute(value)
    || value.split(/[\\/]+/u).includes('..')) {
    fail('Library source path is invalid', 'bot_library_path_invalid', 400);
  }
  const normalized = path.normalize(value);
  if (normalized.split(path.sep).some((segment) => segment.toLowerCase() === '.git')) {
    fail('Git metadata cannot be imported', 'bot_library_git_forbidden', 400);
  }
  return normalized;
};

const normalizeStringArray = (value, field, normalize) => {
  if (value === undefined) return Object.freeze([]);
  if (!Array.isArray(value) || value.length > MAX_EXCLUSIONS) {
    fail(`Library ${field} exclusions are invalid`);
  }
  const items = value.map((entry) => normalize(entry));
  if (new Set(items).size !== items.length) fail(`Library ${field} exclusions contain duplicates`);
  return Object.freeze(items);
};

export const normalizeBotSourceExclusions = (value = {}) => {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).some((key) => !['extensions', 'names', 'paths'].includes(key))) {
    fail('Library source exclusions are invalid');
  }
  const names = normalizeStringArray(value.names, 'name', (entry) => {
    const name = typeof entry === 'string' ? entry.trim() : '';
    if (!SAFE_NAME_PATTERN.test(name) || name === '.' || name === '..'
      || name.toLowerCase() === '.git') {
      fail('Library name exclusion is invalid');
    }
    return name;
  });
  const extensions = normalizeStringArray(value.extensions, 'extension', (entry) => {
    const extension = typeof entry === 'string' ? entry.trim().toLowerCase() : '';
    if (!/^\.[a-z0-9][a-z0-9.+-]{0,15}$/.test(extension)) {
      fail('Library extension exclusion is invalid');
    }
    return extension;
  });
  const paths = normalizeStringArray(value.paths, 'path', (entry) => {
    const candidate = typeof entry === 'string' ? entry.trim().replaceAll('\\', '/') : '';
    const normalized = path.posix.normalize(candidate);
    if (!candidate || candidate.startsWith('/') || normalized === '.' || normalized === '..'
      || normalized.startsWith('../')
      || normalized.split('/').some((segment) => segment.toLowerCase() === '.git')) {
      fail('Library path exclusion is invalid');
    }
    return normalized;
  });
  return Object.freeze({ names, extensions, paths });
};

const finding = (code, relativePath, message, severity = 'error') => Object.freeze({
  code,
  relativePath,
  message,
  severity,
});

const excluded = (relativePath, exclusions) => {
  const segments = relativePath.split('/');
  const extension = path.posix.extname(relativePath).toLowerCase();
  return segments.some((segment) => exclusions.names.includes(segment))
    || exclusions.extensions.includes(extension)
    || exclusions.paths.some((candidate) => (
      relativePath === candidate || relativePath.startsWith(`${candidate}/`)
    ));
};

const sourceContentType = (relativePath) => TEXT_TYPES.get(
  path.posix.extname(relativePath).toLowerCase(),
) || null;

const decodeText = (bytes) => {
  if (bytes.includes(0)) return null;
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
};

const hasSecret = (relativePath, text) => (
  SECRET_FILE_PATTERNS.some((pattern) => pattern.test(path.posix.basename(relativePath)))
  || SECRET_CONTENT_PATTERNS.some((pattern) => pattern.test(text))
);

export const publicBotSourceScan = (scan) => Object.freeze({
  rootKind: scan.rootKind,
  fileCount: scan.files.length,
  totalBytes: scan.totalBytes,
  files: Object.freeze(scan.files.map((file) => Object.freeze({
    relativePath: file.relativePath,
    contentType: file.contentType,
    size: file.size,
    sha256: file.sha256,
    textBytes: file.textBytes,
  }))),
  findings: Object.freeze(scan.findings.map((entry) => Object.freeze({ ...entry }))),
});

export const wipeBotSourceScan = (scan) => {
  for (const file of scan?.files || []) file.bytes?.fill?.(0);
};

export function createBotSourceScanner({
  maximumFiles = DEFAULT_MAX_FILES,
  maximumFileBytes = DEFAULT_MAX_FILE_BYTES,
  maximumTotalBytes = DEFAULT_MAX_TOTAL_BYTES,
  maximumTextBytes = DEFAULT_MAX_TEXT_BYTES,
} = {}) {
  if (![maximumFiles, maximumFileBytes, maximumTotalBytes, maximumTextBytes]
    .every((value) => Number.isInteger(value) && value > 0)
    || maximumFileBytes > maximumTotalBytes || maximumTextBytes > maximumFileBytes) {
    fail('Library source scanner is misconfigured', 'bot_library_scanner_unavailable', 500);
  }

  const scan = async ({ selectedPath, exclusions: rawExclusions = {} } = {}) => {
    const rootPath = validateSelectedPath(selectedPath);
    const exclusions = normalizeBotSourceExclusions(rawExclusions);
    let rootStat;
    try {
      rootStat = await fs.lstat(rootPath);
    } catch (error) {
      fail(
        'Library source is unavailable',
        error?.code === 'ENOENT' ? 'bot_library_source_not_found' : 'bot_library_source_unavailable',
        error?.code === 'ENOENT' ? 404 : 409,
      );
    }
    if (rootStat.isSymbolicLink()) {
      fail('Library source symlinks are forbidden', 'bot_library_symlink_forbidden', 409);
    }
    if (!rootStat.isFile() && !rootStat.isDirectory()) {
      fail('Library source must be a regular file or directory', 'bot_library_special_file_forbidden', 409);
    }
    const rootRealPath = await fs.realpath(rootPath);
    const rootKind = rootStat.isDirectory() ? 'directory' : 'file';
    const findings = [];
    const files = [];
    let totalBytes = 0;

    const acceptFile = async (absolutePath, relativePath, initialStat) => {
      if (excluded(relativePath, exclusions)) return;
      if (SECRET_FILE_PATTERNS.some((pattern) => pattern.test(path.posix.basename(relativePath)))) {
        findings.push(finding(
          'secret_file_rejected',
          relativePath,
          'A credential-like filename was excluded from the Library candidate.',
          'critical',
        ));
        return;
      }
      const contentType = sourceContentType(relativePath);
      if (!contentType) {
        findings.push(finding(
          'unsupported_binary_rejected',
          relativePath,
          'This file type is not supported for curated text extraction.',
        ));
        return;
      }
      if (initialStat.size < 1 || initialStat.size > maximumFileBytes) {
        findings.push(finding(
          'file_size_rejected',
          relativePath,
          'The file is empty or exceeds the per-file Library limit.',
        ));
        return;
      }
      if (files.length >= maximumFiles || totalBytes + initialStat.size > maximumTotalBytes) {
        fail('Library source exceeds scan limits', 'bot_library_scan_too_large', 413, {
          maximumFiles,
          maximumTotalBytes,
        });
      }
      let handle;
      let bytes;
      try {
        handle = await fs.open(absolutePath, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW || 0));
        const stat = await handle.stat();
        if (!stat.isFile() || stat.size !== initialStat.size || stat.size > maximumFileBytes
          || stat.dev !== initialStat.dev || stat.ino !== initialStat.ino) {
          fail('Library source changed during scan', 'bot_library_source_changed', 409);
        }
        const realPath = await fs.realpath(absolutePath);
        if (!isWithin(rootKind === 'file' ? path.dirname(rootRealPath) : rootRealPath, realPath)) {
          fail('Library source escaped the selected root', 'bot_library_path_escape', 409);
        }
        bytes = await handle.readFile();
      } finally {
        await handle?.close().catch(() => undefined);
      }
      const text = decodeText(bytes);
      if (text === null || Buffer.byteLength(text, 'utf8') > maximumTextBytes) {
        bytes.fill(0);
        findings.push(finding(
          'unsupported_binary_rejected',
          relativePath,
          'The file is not bounded UTF-8 text.',
        ));
        return;
      }
      if (hasSecret(relativePath, text)) {
        bytes.fill(0);
        findings.push(finding(
          'secret_content_rejected',
          relativePath,
          'Credential-like content was excluded from the Library candidate.',
          'critical',
        ));
        return;
      }
      const sha256 = crypto.createHash('sha256').update(bytes).digest('hex');
      totalBytes += bytes.byteLength;
      files.push(Object.freeze({
        relativePath,
        absolutePath,
        contentType,
        size: bytes.byteLength,
        textBytes: Buffer.byteLength(text, 'utf8'),
        sha256,
        text,
        bytes,
      }));
    };

    const walk = async (directory, prefix = '') => {
      const entries = [];
      for await (const entry of await fs.opendir(directory)) entries.push(entry);
      entries.sort((left, right) => left.name.localeCompare(right.name));
      for (const entry of entries) {
        const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;
        if (entry.name.toLowerCase() === '.git') {
          findings.push(finding(
            'git_metadata_rejected',
            relativePath,
            'Git metadata is never imported into a Bot Library.',
            'critical',
          ));
          continue;
        }
        if (excluded(relativePath, exclusions)) continue;
        const absolutePath = path.join(directory, entry.name);
        const stat = await fs.lstat(absolutePath);
        if (stat.isSymbolicLink()) {
          findings.push(finding(
            'symlink_rejected',
            relativePath,
            'Symbolic links are not followed during Library scans.',
            'critical',
          ));
        } else if (stat.isDirectory()) {
          const realPath = await fs.realpath(absolutePath);
          if (!isWithin(rootRealPath, realPath)) {
            findings.push(finding(
              'path_escape_rejected',
              relativePath,
              'The directory escaped the selected Library root.',
              'critical',
            ));
          } else {
            await walk(absolutePath, relativePath);
          }
        } else if (stat.isFile()) {
          await acceptFile(absolutePath, relativePath, stat);
        } else {
          findings.push(finding(
            'special_file_rejected',
            relativePath,
            'Device, socket, and FIFO files are forbidden.',
            'critical',
          ));
        }
      }
    };

    try {
      if (rootKind === 'file') {
        await acceptFile(rootPath, path.basename(rootPath), rootStat);
      } else {
        await walk(rootPath);
      }
      return Object.freeze({
        rootPath,
        rootRealPath,
        rootKind,
        exclusions,
        files: Object.freeze(files),
        findings: Object.freeze(findings),
        totalBytes,
      });
    } catch (error) {
      for (const file of files) file.bytes.fill(0);
      throw error;
    }
  };

  return Object.freeze({ scan });
}
