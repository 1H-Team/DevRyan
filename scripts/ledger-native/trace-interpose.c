// Test-only system-call tracer for the native ledger's differential tests
// (macOS, DYLD_INSERT_LIBRARIES; never built into the product). It
// interposes the libc entry points libuv and the Rust primitives call and
// appends one line per call to the file named by LEDGER_TRACE_OUT, for paths
// containing LEDGER_TRACE_FILTER and for descriptors opened on them:
//   <call> <path|fd> <arguments> = <result> [<errno>]
// LEDGER_TRACE_FAIL is a comma-separated list for traced descriptors:
// `fullfsync` makes fcntl(F_FULLFSYNC) fail with ENOTSUP, `barrier` makes
// fcntl(F_BARRIERFSYNC) fail with ENOTSUP, `fsync` makes fsync(2) fail with
// EIO, so the fallback chain and a real sync failure can be observed.
// Calls made from this library are not interposed (dyld's rule), so its own
// write(2) of the trace is not traced.
#include <errno.h>
#include <fcntl.h>
#include <stdarg.h>
#include <stdatomic.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <sys/types.h>
#include <unistd.h>

#define MAX_FDS 65536
#define F_BARRIERFSYNC_CMD 85

extern int close$NOCANCEL(int);

static int trace_fd = -1;
static const char *filter = NULL;
static int fail_full = 0;
static int fail_barrier = 0;
static int fail_fsync = 0;
static _Atomic unsigned char traced[MAX_FDS];

__attribute__((constructor)) static void trace_init(void) {
  const char *out = getenv("LEDGER_TRACE_OUT");
  filter = getenv("LEDGER_TRACE_FILTER");
  const char *fail = getenv("LEDGER_TRACE_FAIL");
  if (fail) {
    char tokens[256];
    snprintf(tokens, sizeof tokens, "%s", fail);
    for (char *rest = tokens, *token; (token = strsep(&rest, ",")) != NULL;) {
      if (strcmp(token, "fullfsync") == 0) fail_full = 1;
      else if (strcmp(token, "barrier") == 0) fail_barrier = 1;
      else if (strcmp(token, "fsync") == 0) fail_fsync = 1;
    }
  }
  if (out && filter && *filter) trace_fd = open(out, O_WRONLY | O_CREAT | O_APPEND | O_CLOEXEC, 0600);
}

static int wanted(const char *path) { return trace_fd >= 0 && path && strstr(path, filter) != NULL; }
static int wanted_fd(int fd) { return trace_fd >= 0 && fd >= 0 && fd < MAX_FDS && atomic_load(&traced[fd]); }

static void emit(const char *format, ...) {
  char line[4096];
  va_list ap;
  va_start(ap, format);
  int n = vsnprintf(line, sizeof line - 1, format, ap);
  va_end(ap);
  if (n < 0) return;
  if (n > (int)sizeof line - 2) n = (int)sizeof line - 2;
  line[n] = '\n';
  write(trace_fd, line, (size_t)n + 1);
}

static void result(int value, int saved) {
  (void)value;
  errno = saved;
}

static int t_open(const char *path, int flags, ...) {
  mode_t mode = 0;
  if (flags & O_CREAT) {
    va_list ap;
    va_start(ap, flags);
    mode = (mode_t)va_arg(ap, int);
    va_end(ap);
  }
  int fd = open(path, flags, mode);
  int saved = errno;
  if (wanted(path)) {
    if (fd >= 0 && fd < MAX_FDS) atomic_store(&traced[fd], 1);
    emit("open %s flags=0x%x mode=0%o = %d %d", path, flags, (unsigned)mode, fd >= 0 ? 0 : -1, fd >= 0 ? 0 : saved);
    if (fd >= 0) emit("fd %d %s", fd, path);
  }
  result(fd, saved);
  return fd;
}

static int t_fcntl(int fd, int cmd, ...) {
  va_list ap;
  va_start(ap, cmd);
  long arg = va_arg(ap, long);
  va_end(ap);
  if (wanted_fd(fd) && ((cmd == F_FULLFSYNC && fail_full) || (cmd == F_BARRIERFSYNC_CMD && fail_barrier))) {
    emit("fcntl #%d cmd=%d = -1 %d", fd, cmd, ENOTSUP);
    errno = ENOTSUP;
    return -1;
  }
  int r = fcntl(fd, cmd, arg);
  int saved = errno;
  if (wanted_fd(fd) && (cmd == F_FULLFSYNC || cmd == F_BARRIERFSYNC_CMD)) emit("fcntl #%d cmd=%d = %d %d", fd, cmd, r, r == -1 ? saved : 0);
  result(r, saved);
  return r;
}

static int t_fsync(int fd) {
  if (wanted_fd(fd) && fail_fsync) {
    emit("fsync #%d = -1 %d", fd, EIO);
    errno = EIO;
    return -1;
  }
  int r = fsync(fd);
  int saved = errno;
  if (wanted_fd(fd)) emit("fsync #%d = %d %d", fd, r, r == -1 ? saved : 0);
  result(r, saved);
  return r;
}

static void untrack(int fd, const char *how, int r, int saved) {
  if (wanted_fd(fd)) {
    emit("%s #%d = %d %d", how, fd, r, r == -1 ? saved : 0);
    atomic_store(&traced[fd], 0);
  }
}

static int t_close(int fd) {
  int was = wanted_fd(fd);
  int r = close(fd);
  int saved = errno;
  if (was) untrack(fd, "close", r, saved);
  result(r, saved);
  return r;
}

static int t_close_nocancel(int fd) {
  int was = wanted_fd(fd);
  int r = close$NOCANCEL(fd);
  int saved = errno;
  if (was) untrack(fd, "close", r, saved);
  result(r, saved);
  return r;
}

static ssize_t t_write(int fd, const void *buffer, size_t length) {
  ssize_t r = write(fd, buffer, length);
  int saved = errno;
  if (wanted_fd(fd)) emit("write #%d len=%zu = %zd %d", fd, length, r, r == -1 ? saved : 0);
  result((int)r, saved);
  return r;
}

#define PATH_CALL(name, call, ...)                                       \
  int r = call;                                                          \
  int saved = errno;                                                     \
  if (wanted(path)) emit(name " %s" __VA_ARGS__);                        \
  result(r, saved);                                                      \
  return r;

static int t_link(const char *from, const char *to) {
  int r = link(from, to);
  int saved = errno;
  if (wanted(from) || wanted(to)) emit("link %s %s = %d %d", from, to, r, r == -1 ? saved : 0);
  result(r, saved);
  return r;
}

static int t_rename(const char *from, const char *to) {
  int r = rename(from, to);
  int saved = errno;
  if (wanted(from) || wanted(to)) emit("rename %s %s = %d %d", from, to, r, r == -1 ? saved : 0);
  result(r, saved);
  return r;
}

static int t_unlink(const char *path) { PATH_CALL("unlink", unlink(path), " = %d %d", path, r, r == -1 ? saved : 0) }
static int t_rmdir(const char *path) { PATH_CALL("rmdir", rmdir(path), " = %d %d", path, r, r == -1 ? saved : 0) }
static int t_chmod(const char *path, mode_t mode) { PATH_CALL("chmod", chmod(path, mode), " mode=0%o = %d %d", path, (unsigned)mode, r, r == -1 ? saved : 0) }
static int t_mkdir(const char *path, mode_t mode) { PATH_CALL("mkdir", mkdir(path, mode), " mode=0%o = %d %d", path, (unsigned)mode, r, r == -1 ? saved : 0) }
static int t_stat(const char *path, struct stat *buffer) { PATH_CALL("stat", stat(path, buffer), " = %d %d", path, r, r == -1 ? saved : 0) }
static int t_lstat(const char *path, struct stat *buffer) { PATH_CALL("lstat", lstat(path, buffer), " = %d %d", path, r, r == -1 ? saved : 0) }

#define INTERPOSE(replacement, original)                                                         \
  __attribute__((used)) static struct { const void *r; const void *o; } interpose_##replacement \
      __attribute__((section("__DATA,__interpose"))) = {(const void *)(replacement), (const void *)(original)}

INTERPOSE(t_open, open);
INTERPOSE(t_fcntl, fcntl);
INTERPOSE(t_fsync, fsync);
INTERPOSE(t_close, close);
INTERPOSE(t_close_nocancel, close$NOCANCEL);
INTERPOSE(t_write, write);
INTERPOSE(t_link, link);
INTERPOSE(t_rename, rename);
INTERPOSE(t_unlink, unlink);
INTERPOSE(t_rmdir, rmdir);
INTERPOSE(t_chmod, chmod);
INTERPOSE(t_mkdir, mkdir);
INTERPOSE(t_stat, stat);
INTERPOSE(t_lstat, lstat);
