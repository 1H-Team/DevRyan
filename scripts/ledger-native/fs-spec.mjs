// The outcome cases of the `node` module's differential test
// (fs-differential.mjs): every `fs.promises` call, `FileHandle` method and
// `zlib.deflate` the facade builds, with the options the ledger's sites
// pass, on real files, and their failures (a missing path, a file in the
// middle of a path, permission, a directory where a file is expected, a
// dangling symbolic link, `EEXIST`, a cross-device rename, a NUL byte).
// Each case builds `tree` in a fresh directory per arm, runs `steps` there
// one at a time, and compares each outcome (result, or the error's name,
// message, code, errno, syscall, path and dest) and the tree afterwards.
//
// Tree entries: ['dir', p, mode?], ['file', p, text, mode?], ['bytes', p, size],
// ['link', p, target], ['rawlink', p, targetHex] (a target of raw bytes),
// ['rawfile', nameHex] (a file whose name is raw bytes: Linux only),
// ['mode', p, mode] (applied last, deepest first). A case with `linuxOnly`
// runs only on Linux. Every case must leave as many descriptors open on each
// arm as it found.
// Step paths (`path`, `src`, `dest`) are relative to the case's directory
// unless they start with `/`; `timed` lists the paths whose modification
// time is compared too.
const big = (size) => ['bytes', 'big', size];

/** A step per call; `{ h }` names a handle, `{ s }` a stream. */
export const CASES = Object.freeze([
  { name: 'access: a file, a missing path, a file in the middle, modes', tree: [['file', 'f', 'x'], ['file', 'ro', 'x', 0o400]], steps: [
    { op: 'access', path: 'f' }, { op: 'access', path: 'nope' }, { op: 'access', path: 'f/x' },
    { op: 'access', path: 'ro', mode: 2 }, { op: 'access', path: 'ro', mode: 4 }, { op: 'access', path: 'f', mode: 1 }] },
  { name: 'appendFile: new, existing, into a missing directory, onto a directory', tree: [['file', 'f', 'one\n'], ['dir', 'd']], steps: [
    { op: 'appendFile', path: 'f', text: 'two\n' }, { op: 'appendFile', path: 'n', text: 'new', mode: 0o600 },
    { op: 'appendFile', path: 'nope/x', text: 'x' }, { op: 'appendFile', path: 'd', text: 'x' }] },
  { name: 'chmod: a file, a directory, a missing path', tree: [['file', 'f', 'x'], ['dir', 'd']], steps: [
    { op: 'chmod', path: 'f', mode: 0o640 }, { op: 'chmod', path: 'd', mode: 0o711 }, { op: 'chmod', path: 'nope', mode: 0o600 }] },
  { name: 'copyFile: plain, EXCL onto an existing file, FICLONE, missing source, onto a directory', tree: [['file', 'f', 'hello', 0o640], ['file', 'g', 'old'], ['dir', 'd'], big(70000)], steps: [
    { op: 'copyFile', src: 'f', dest: 'c', mode: 0 }, { op: 'copyFile', src: 'f', dest: 'g', mode: 1 }, { op: 'copyFile', src: 'big', dest: 'c2', mode: 3 },
    { op: 'copyFile', src: 'f', dest: 'g', mode: 2 }, { op: 'copyFile', src: 'nope', dest: 'c3', mode: 0 }, { op: 'copyFile', src: 'f', dest: 'd', mode: 0 },
    { op: 'copyFile', src: 'f', dest: 'nope/c', mode: 0 }, { op: 'copyFile', src: 'f', dest: 'c4', mode: 4 }] },
  { name: 'link: plain, onto an existing name, a missing source, a directory, across devices', tree: [['file', 'f', 'x'], ['file', 'g', 'y'], ['dir', 'd']], steps: [
    { op: 'link', src: 'f', dest: 'l' }, { op: 'link', src: 'f', dest: 'g' }, { op: 'link', src: 'nope', dest: 'l2' },
    { op: 'link', src: 'd', dest: 'l3' }, { op: 'link', src: 'f', dest: '/dev/devryan-o2fd-cross-device' }] },
  { name: 'lstat and stat: a file, a directory, a link, a dangling link, a file in the middle, bigint', tree: [['file', 'f', 'hello'], ['dir', 'd'], ['link', 'l', 'f'], ['link', 'dangling', 'nope']], steps: [
    { op: 'lstat', path: 'f' }, { op: 'stat', path: 'f', bigint: true }, { op: 'lstat', path: 'd' }, { op: 'lstat', path: 'l' }, { op: 'stat', path: 'l' },
    { op: 'lstat', path: 'dangling', bigint: true }, { op: 'stat', path: 'dangling' }, { op: 'lstat', path: 'f/x' }, { op: 'stat', path: 'nope', bigint: true }] },
  { name: 'lstat: permission (a directory without search)', tree: [['dir', 'locked'], ['file', 'locked/f', 'x'], ['mode', 'locked', 0o000]], steps: [
    { op: 'lstat', path: 'locked/f' }, { op: 'readdir', path: 'locked' }, { op: 'chmod', path: 'locked', mode: 0o700 }, { op: 'lstat', path: 'locked/f' }] },
  { name: 'mkdir: plain, existing, recursive (first made, nothing made), a file in the middle, a missing parent, modes', tree: [['file', 'f', 'x'], ['dir', 'e']], steps: [
    { op: 'mkdir', path: 'a' }, { op: 'mkdir', path: 'a' }, { op: 'mkdir', path: 'a/b/c', recursive: true }, { op: 'mkdir', path: 'a/b/c', recursive: true },
    { op: 'mkdir', path: 'f/x', recursive: true }, { op: 'mkdir', path: 'f', recursive: true }, { op: 'mkdir', path: 'nope/x' }, { op: 'mkdir', path: 'm', mode: 0o700 },
    { op: 'mkdir', path: 'e/r/s', recursive: true, mode: 0o750 }] },
  { name: 'mkdir recursive under a directory without write', tree: [['dir', 'ro'], ['mode', 'ro', 0o500]], steps: [
    { op: 'mkdir', path: 'ro/x/y', recursive: true }, { op: 'chmod', path: 'ro', mode: 0o700 }] },
  { name: 'readdir: names in libuv\'s order, with file types, a file, a missing path', tree: [['file', 'B', '1'], ['file', 'a', '1'], ['file', '10', '1'], ['file', '9', '1'], ['file', 'é', '1'], ['dir', 'sub'], ['link', 'ln', 'a'], ['link', 'dangling', 'nope']], steps: [
    { op: 'readdir', path: '.' }, { op: 'readdir', path: '.', types: true }, { op: 'readdir', path: 'a' }, { op: 'readdir', path: 'nope', types: true }] },
  { name: 'readFile: empty, small, 600 KiB (512 KiB reads), utf8 with ill-formed bytes, a directory, a missing path, a dangling link', tree: [['file', 'empty', ''], ['file', 'f', 'hello'], big(600_000), ['bytes', 'bin', 300], ['dir', 'd'], ['link', 'dangling', 'nope']], steps: [
    { op: 'readFile', path: 'empty' }, { op: 'readFile', path: 'f', utf8: true }, { op: 'readFile', path: 'big' }, { op: 'readFile', path: 'big', utf8: true },
    { op: 'readFile', path: 'bin', utf8: true }, { op: 'readFile', path: 'd' }, { op: 'readFile', path: 'nope', utf8: true }, { op: 'readFile', path: 'dangling' }] },
  { name: 'readFile: permission', tree: [['file', 'secret', 'x', 0o000]], steps: [{ op: 'readFile', path: 'secret' }, { op: 'chmod', path: 'secret', mode: 0o600 }] },
  { name: 'readlink as bytes and symlink of bytes: targets that are not UTF-8 round-trip, a NUL refused, EEXIST shows the target decoded', tree: [['file', 'f', 'x'], ['link', 'l', 'f'], ['rawlink', 'r', '74fffe']], steps: [
    { op: 'readlink', path: 'r', buffer: true }, { op: 'readlink', path: 'r' }, { op: 'readlink', path: 'l', buffer: true },
    { op: 'symlink', targetHex: '61ff', path: 'w' }, { op: 'readlink', path: 'w', buffer: true }, { op: 'symlink', targetHex: '74fffe', path: 'w2', type: 'file' },
    { op: 'readlink', path: 'w2', buffer: true }, { op: 'symlink', targetHex: '61ff', path: 'f' }, { op: 'symlink', targetHex: '610062', path: 'z' },
    { op: 'readlink', path: 'f', buffer: true }, { op: 'readlink', path: 'nope', buffer: true }, { op: 'readlink', path: 'f/x', buffer: true }] },
  { name: 'readdir of a name that is not UTF-8 (Linux only: APFS refuses such names)', linuxOnly: true, tree: [['file', 'a', '1'], ['rawfile', '62ff'], ['rawfile', '63c328']], steps: [
    { op: 'readdir', path: '.' }, { op: 'readdir', path: '.', types: true }, { op: 'readdirSync', path: '.' }] },
  { name: 'lstatSync and readdirSync(withFileTypes): a file, a link, a dangling link, a directory, missing, a file in the middle', tree: [['file', 'f', 'hello'], ['link', 'l', 'f'], ['link', 'dangling', 'nope'], ['dir', 'd'], ['file', 'd/x', '1'], ['link', 'd/y', '../f'], ['dir', 'd/z']], steps: [
    { op: 'lstatSync', path: 'l' }, { op: 'lstatSync', path: 'dangling', bigint: true }, { op: 'lstatSync', path: 'f' }, { op: 'lstatSync', path: 'nope' }, { op: 'lstatSync', path: 'f/x' },
    { op: 'readdirSync', path: 'd' }, { op: 'readdirSync', path: '.' }, { op: 'readdirSync', path: 'f' }, { op: 'readdirSync', path: 'nope' }] },
  { name: 'default modes under umask 0: open, writeFile, appendFile, mkdir (plain and recursive), copyFile', tree: [['file', 'src', 'x', 0o751]], steps: [
    { op: 'umask', mask: 0 }, { op: 'open', path: 'o', flags: 'wx', as: 'o' }, { op: 'h.close', h: 'o' }, { op: 'writeFile', path: 'w', text: 'w' },
    { op: 'appendFile', path: 'a', text: 'a' }, { op: 'mkdir', path: 'm' }, { op: 'mkdir', path: 'r/s/t', recursive: true }, { op: 'copyFile', src: 'src', dest: 'c', mode: 0 },
    { op: 'umask', mask: 0o002 }, { op: 'mkdir', path: 'm2' }, { op: 'writeFile', path: 'w2', text: 'w' }, { op: 'umask' }] },
  { name: 'readlink and realpath: a link chain, not a link, dangling, missing, a file in the middle', tree: [['file', 'f', 'x'], ['dir', 'd'], ['link', 'l1', 'f'], ['link', 'l2', 'l1'], ['link', 'dl', 'd'], ['link', 'dangling', 'nope']], steps: [
    { op: 'readlink', path: 'l2' }, { op: 'readlink', path: 'f' }, { op: 'readlink', path: 'nope' }, { op: 'realpath', path: 'l2' }, { op: 'realpath', path: 'dl' },
    { op: 'realpath', path: 'dangling' }, { op: 'realpath', path: 'f/x' }, { op: 'realpath', path: '.' }] },
  { name: 'rename: a file, onto a file, a directory onto a non-empty one, a file onto a directory, a directory onto a file, missing, across devices', tree: [['file', 'f', 'x'], ['file', 'g', 'y'], ['dir', 'd'], ['dir', 'e'], ['file', 'e/k', 'k'], ['file', 'h', 'z']], steps: [
    { op: 'rename', src: 'f', dest: 'f2' }, { op: 'rename', src: 'f2', dest: 'g' }, { op: 'rename', src: 'd', dest: 'e' }, { op: 'rename', src: 'g', dest: 'e' },
    { op: 'rename', src: 'd', dest: 'h' }, { op: 'rename', src: 'nope', dest: 'x' }, { op: 'rename', src: 'h', dest: '/dev/devryan-o2fd-cross-device' }] },
  { name: 'rm: a file, missing, missing with force, a directory without recursive, a tree, a dangling link, a file in the middle', tree: [['file', 'f', 'x'], ['file', 'g', 'g'], ['dir', 't'], ['dir', 't/a'], ['file', 't/a/b', 'b'], ['link', 't/l', '../f'], ['dir', 'keep'], ['link', 'dangling', 'nope']], steps: [
    { op: 'rm', path: 'f' }, { op: 'rm', path: 'f' }, { op: 'rm', path: 'f', force: true }, { op: 'rm', path: 'keep' }, { op: 'rm', path: 't', recursive: true, force: true },
    { op: 'rm', path: 'dangling' }, { op: 'rm', path: 'keep/x/y', force: true }, { op: 'rm', path: 'keep', recursive: true }, { op: 'rm', path: 'g/x', force: true },
    { op: 'rm', path: 'g/x', recursive: true, force: true }] },
  { name: 'rm recursive with a child it may not remove (EACCES), then made removable', tree: [['dir', 't'], ['dir', 't/ro'], ['file', 't/ro/x', 'x'], ['mode', 't/ro', 0o500]], steps: [
    { op: 'rm', path: 't', recursive: true, force: true }, { op: 'chmod', path: 't/ro', mode: 0o700 }, { op: 'rm', path: 't', recursive: true, force: true }] },
  { name: 'rmdir: empty, not empty, a file, missing', tree: [['dir', 'e'], ['dir', 'n'], ['file', 'n/x', 'x'], ['file', 'f', 'x']], steps: [
    { op: 'rmdir', path: 'e' }, { op: 'rmdir', path: 'n' }, { op: 'rmdir', path: 'f' }, { op: 'rmdir', path: 'nope' }] },
  { name: 'symlink: plain, onto an existing name, with type dir, dangling', tree: [['file', 'f', 'x'], ['dir', 'd']], steps: [
    { op: 'symlink', target: 'f', path: 'l' }, { op: 'symlink', target: 'f', path: 'l' }, { op: 'symlink', target: 'd', path: 'ld', type: 'dir' },
    { op: 'symlink', target: 'nope/x', path: 'dangling' }, { op: 'symlink', target: 'f', path: 'nope/l' }] },
  { name: 'unlink: a file, a link, a directory, missing', tree: [['file', 'f', 'x'], ['link', 'l', 'f'], ['dir', 'd']], steps: [
    { op: 'unlink', path: 'l' }, { op: 'unlink', path: 'f' }, { op: 'unlink', path: 'd' }, { op: 'unlink', path: 'nope' }] },
  { name: 'utimes: a Date, seconds, a fraction, missing', tree: [['file', 'f', 'x'], ['file', 'g', 'y'], ['dir', 'd']], timed: ['f', 'g', 'd'], steps: [
    { op: 'utimes', path: 'f', atime: { date: 1_700_000_000_123 }, mtime: { date: 1_700_000_000_456 } },
    { op: 'utimes', path: 'g', atime: { seconds: 1_600_000_000 }, mtime: { seconds: 1_600_000_000.25 } },
    { op: 'utimes', path: 'd', atime: { seconds: 1_500_000_000 }, mtime: { seconds: 1_500_000_000 } },
    { op: 'utimes', path: 'nope', atime: { seconds: 1 }, mtime: { seconds: 1 } }, { op: 'utimes', path: 'f', atime: { seconds: 'NaN' }, mtime: { seconds: 1 } },
    { op: 'utimes', path: 'f', atime: { seconds: 1 }, mtime: { seconds: 'Infinity' } }, { op: 'utimes', path: 'nope', atime: { seconds: '-Infinity' }, mtime: { seconds: 1 } }] },
  { name: 'writeFile: new, overwrite, wx onto an existing file, modes, 1.2 MiB, a lone surrogate, a directory, a missing directory', tree: [['file', 'f', 'old contents'], ['dir', 'd']], steps: [
    { op: 'writeFile', path: 'n', text: 'new' }, { op: 'writeFile', path: 'f', text: 'x' }, { op: 'writeFile', path: 'f', text: 'y', flag: 'wx' },
    { op: 'writeFile', path: 'p', text: 'p', mode: 0o600, flag: 'wx' }, { op: 'writeFile', path: 'o', text: 'o', mode: 0o444, flag: 'wx' },
    { op: 'writeFile', path: 'big', b64: Buffer.alloc(1_200_000, 7).toString('base64') }, { op: 'writeFile', path: 's', text: 'a\ud800b' },
    { op: 'writeFile', path: 'd', text: 'x' }, { op: 'writeFile', path: 'nope/x', text: 'x' }, { op: 'writeFile', path: 'empty', text: '' },
    { op: 'writeFile', path: 'f', text: 'z', flag: 'r' }, { op: 'appendFile', path: 'f', text: 'z', flag: 'r' }] },
  { name: 'statfs: number and bigint', tree: [['file', 'f', 'x']], steps: [{ op: 'statfs', path: 'f' }, { op: 'statfs', path: '.', bigint: true }, { op: 'statfs', path: 'nope' }] },
  { name: 'open and a FileHandle: read at a position and at the offset, a read of nothing, stat, chmod, sync, close twice, after close', tree: [['file', 'f', 'abcdefghij'], ['dir', 'd']], steps: [
    { op: 'open', path: 'f', flags: 'r', as: 'h' }, { op: 'h.read', h: 'h', length: 4, position: 2 }, { op: 'h.read', h: 'h', length: 3 }, { op: 'h.read', h: 'h', length: 3 },
    { op: 'h.read', h: 'h', length: 0 }, { op: 'h.read', h: 'h', length: 8 }, { op: 'h.read', h: 'h', length: 8 }, { op: 'h.stat', h: 'h' }, { op: 'h.stat', h: 'h', bigint: true },
    { op: 'h.chmod', h: 'h', mode: 0o604 }, { op: 'h.sync', h: 'h' }, { op: 'h.close', h: 'h' }, { op: 'h.close', h: 'h' }, { op: 'h.read', h: 'h', length: 1 },
    { op: 'h.stat', h: 'h' }, { op: 'h.sync', h: 'h' }, { op: 'h.write', h: 'h', text: 'x' }, { op: 'h.writeFile', h: 'h', text: 'x' }, { op: 'h.chmod', h: 'h', mode: 0o600 },
    { op: 'open', path: 'd', flags: 'r', as: 'dh' }, { op: 'h.read', h: 'dh', length: 4 }, { op: 'h.sync', h: 'dh' }, { op: 'h.close', h: 'dh' }] },
  { name: 'open and a FileHandle: wx, writes at a position and at the offset, writeFile, a write of nothing, EEXIST', tree: [['file', 'old', 'x']], steps: [
    { op: 'open', path: 'n', flags: 'wx', mode: 0o600, as: 'w' }, { op: 'h.write', h: 'w', text: 'hello' }, { op: 'h.write', h: 'w', text: 'XY', position: 1 },
    { op: 'h.write', h: 'w', text: 'tail', offset: 1, length: 2 }, { op: 'h.writeFile', h: 'w', text: ' more' }, { op: 'h.writeFile', h: 'w', text: '' },
    { op: 'h.write', h: 'w', text: '' }, { op: 'h.sync', h: 'w' }, { op: 'h.close', h: 'w' },
    { op: 'open', path: 'old', flags: 'wx', as: 'x' }, { op: 'open', path: 'nope/n', flags: 'wx', as: 'y' }, { op: 'open', path: 'a', flags: 'a', as: 'a' },
    { op: 'h.write', h: 'a', text: '1' }, { op: 'h.write', h: 'a', text: '2', position: 0 }, { op: 'h.close', h: 'a' }] },
  { name: 'open with fs.constants bits: O_NOFOLLOW on a link, O_DIRECTORY on a file, O_NONBLOCK, a missing file', tree: [['file', 'f', 'x'], ['link', 'l', 'f'], ['dir', 'd']], constantsFlags: true, steps: [
    { op: 'open', path: 'l', flags: ['O_RDONLY', 'O_NOFOLLOW'], as: 'a' }, { op: 'open', path: 'f', flags: ['O_RDONLY', 'O_DIRECTORY', 'O_NOFOLLOW'], as: 'b' },
    { op: 'open', path: 'd', flags: ['O_RDONLY', 'O_DIRECTORY', 'O_NOFOLLOW'], as: 'c' }, { op: 'h.stat', h: 'c' }, { op: 'h.chmod', h: 'c', mode: 0o755 }, { op: 'h.close', h: 'c' },
    { op: 'open', path: 'f', flags: ['O_RDONLY', 'O_NOFOLLOW', 'O_NONBLOCK'], as: 'e' }, { op: 'h.stat', h: 'e' }, { op: 'h.read', h: 'e', length: 1025, position: 0 }, { op: 'h.close', h: 'e' },
    { op: 'open', path: 'nope', flags: ['O_RDONLY', 'O_NOFOLLOW', 'O_NONBLOCK'], as: 'f' }] },
  { name: 'a NUL byte in a path is refused before any I/O', tree: [['file', 'f', 'x']], steps: [
    { op: 'lstat', path: 'f\u0000x' }, { op: 'readFile', path: 'f\u0000' }, { op: 'rename', src: 'f', dest: 'g\u0000' }, { op: 'lstat', path: 'it\'s\u0000' },
    { op: 'lstat', path: 'a"b\'c\u0000' }, { op: 'lstat', path: 'a"b\'c`\u0000' }, { op: 'lstat', path: `/x\b\t\u007f\u009f\\${'y'.repeat(140)}\n${'z'.repeat(20)}\u0000` },
    { op: 'symlink', targetHex: '6100', path: 'z' }, { op: 'symlink', target: 'f\u0000', path: 'z\u0000' }] },
  { name: 'zlib.deflate inflates to its input', tree: [], steps: [
    { op: 'deflate', text: '' }, { op: 'deflate', text: 'blob 5\u0000hello' }, { op: 'deflate', b64: Buffer.alloc(200_000, 3).toString('base64') }] },
]);

/** The receipt site's read cut (rule 3): sizes around and at multiples of 128 KiB, and the default 64 KiB. */
const K128 = 128 * 1024;
export const CUT_SIZES = Object.freeze([0, 1, K128 - 1, K128, K128 + 1, 2 * K128, 3 * K128 + 5, 8 * K128, 8 * K128 + 7, 24 * K128 - 1]);
