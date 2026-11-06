/* Compatibility adapter for runtimes that cannot fall back from posix_spawn.
 * The kernel still denies posix_spawn/setpgid/setsid. This library provides no
 * extra authority: it implements the supported file actions using fork and
 * execve, which inherit the supervisor's immutable Seatbelt policy and process
 * group.
 * Omitting/removing the adapter therefore fails closed. Detached spawn requests
 * run in the existing supervised group; creating a new group remains denied.
 *
 * An in-place spawn (POSIX_SPAWN_SETEXEC: execve with spawn attributes, which
 * Xcode's python3 stub uses) applies the same attributes and file actions to
 * the calling process and calls execve without forking. The kernel leaves a
 * caller unchanged when that exec fails, and posix_spawnp then tries the next
 * PATH entry, so everything changed is recorded and undone on failure.
 *
 * Architecture preferences (posix_spawnattr_setbinpref_np): execve runs the
 * caller's own slice of a universal binary, and only native processes can load
 * this library (dyld stops a Rosetta process that names it). A preference for
 * the native type or CPU_TYPE_ANY is therefore exactly what execve does; any
 * other preference cannot be honoured and is refused, not ignored.
 *
 * Virtual groups (session-group-darwin.h): a child that requested its own
 * group is named after its pid in DEVRYAN_SPAWN_GROUP, and kill/killpg deliver
 * a signal for that group to the supervised processes that carry the name.
 */
#define _DARWIN_C_SOURCE
#include <spawn.h>
#include <pthread.h>
#include <signal.h>
#include <unistd.h>
#include <fcntl.h>
#include <errno.h>
#include <stdlib.h>
#include <string.h>
#include <limits.h>
#include <sys/wait.h>
#include <sys/stat.h>
#include <libproc.h>
#include <mach/machine.h>
#include "session-group-darwin.h"

#pragma clang diagnostic ignored "-Wdeprecated-declarations"
#define INTERPOSE(replacement, original) \
  __attribute__((used)) static const struct { const void *newfn; const void *oldfn; } \
  entry_##original __attribute__((section("__DATA,__interpose"))) = { (const void *)&replacement, (const void *)&original }

enum kind { CLOSE, DUP, OPEN, CHDIR, FCHDIR, INHERIT };
struct action { enum kind kind; int fd, target, flags; mode_t mode; char *path; struct action *next; };
struct actions { posix_spawn_file_actions_t id; struct action *first, *last; struct actions *next; };
static pthread_mutex_t lock = PTHREAD_MUTEX_INITIALIZER;
static struct actions *all;
static struct actions *find(posix_spawn_file_actions_t id) {
  for (struct actions *item = all; item; item = item->next) if (item->id == id) return item;
  return NULL;
}
static int initialize(posix_spawn_file_actions_t *value) {
  int error = posix_spawn_file_actions_init(value); if (error) return error;
  struct actions *item = calloc(1, sizeof(*item));
  if (!item) { posix_spawn_file_actions_destroy(value); return ENOMEM; }
  item->id = *value;
  pthread_mutex_lock(&lock); item->next = all; all = item; pthread_mutex_unlock(&lock); return 0;
}
static int destroy(posix_spawn_file_actions_t *value) {
  pthread_mutex_lock(&lock);
  for (struct actions **entry = &all; *entry; entry = &(*entry)->next) {
    if ((*entry)->id != *value) continue;
    struct actions *item = *entry; *entry = item->next;
    for (struct action *action = item->first; action;) {
      struct action *next = action->next; free(action->path); free(action); action = next;
    }
    free(item); break;
  }
  pthread_mutex_unlock(&lock); return posix_spawn_file_actions_destroy(value);
}
static int add(posix_spawn_file_actions_t *value, enum kind kind, int fd, int target, const char *path, int flags, mode_t mode) {
  if (fd < 0 || target < 0) return EBADF;
  struct action *action = calloc(1, sizeof(*action)); if (!action) return ENOMEM;
  *action = (struct action){ .kind = kind, .fd = fd, .target = target, .flags = flags, .mode = mode };
  if (path && !(action->path = strdup(path))) { free(action); return ENOMEM; }
  pthread_mutex_lock(&lock);
  struct actions *item = find(*value);
  if (!item) { pthread_mutex_unlock(&lock); free(action->path); free(action); return EINVAL; }
  if (item->last) item->last->next = action; else item->first = action;
  item->last = action; pthread_mutex_unlock(&lock); return 0;
}
static int close_action(posix_spawn_file_actions_t *v, int fd) { return add(v, CLOSE, fd, 0, NULL, 0, 0); }
static int dup_action(posix_spawn_file_actions_t *v, int fd, int to) { return add(v, DUP, fd, to, NULL, 0, 0); }
static int open_action(posix_spawn_file_actions_t *v, int fd, const char *p, int flags, mode_t mode) { return add(v, OPEN, fd, 0, p, flags, mode); }
static int chdir_action(posix_spawn_file_actions_t *v, const char *p) { return add(v, CHDIR, 0, 0, p, 0, 0); }
static int fchdir_action(posix_spawn_file_actions_t *v, int fd) { return add(v, FCHDIR, fd, 0, NULL, 0, 0); }
static int inherit_action(posix_spawn_file_actions_t *v, int fd) { return add(v, INHERIT, fd, 0, NULL, 0, 0); }

#define GROUP_DIGITS 20
/* Children this process started detached: it may name them as group leaders. */
static pid_t detached[64]; static unsigned int detachedCount;
static void write_group(char *marker, pid_t group) {
  char digits[GROUP_DIGITS]; int count = 0;
  for (unsigned long rest = (unsigned long)group; rest && count < GROUP_DIGITS; rest /= 10) digits[count++] = (char)('0' + rest % 10);
  char *out = marker + sizeof(GROUP_VARIABLE) - 1;
  while (count) *out++ = digits[--count];
  *out = 0;
}
/* The child's environment with its requested group. Allocated before fork:
 * the child only writes its own pid into the reserved digits. */
static char **group_environment(char *const envp[], char **marker) {
  size_t count = 0, name = sizeof(GROUP_VARIABLE) - 1;
  while (envp && envp[count]) count++;
  char **copy = calloc(count + 2, sizeof(*copy));
  *marker = calloc(1, name + GROUP_DIGITS + 1);
  if (!copy || !*marker) { free(copy); free(*marker); *marker = NULL; return NULL; }
  memcpy(*marker, GROUP_VARIABLE, name);
  size_t kept = 0;
  for (size_t i = 0; i < count; i++) if (strncmp(envp[i], GROUP_VARIABLE, name)) copy[kept++] = envp[i];
  copy[kept] = *marker;
  return copy;
}

/* The library's own slice is the calling process's architecture. */
#if defined(__arm64__)
#define NATIVE_CPU CPU_TYPE_ARM64
#elif defined(__x86_64__)
#define NATIVE_CPU CPU_TYPE_X86_64
#else
#error Unsupported spawn adapter architecture
#endif
static int preference(const posix_spawnattr_t *attributes) {
  cpu_type_t first = 0; size_t count = 0;
  int error = posix_spawnattr_getbinpref_np(attributes, 1, &first, &count); if (error) return error;
  return (!count || first == 0 || first == CPU_TYPE_ANY || first == NATIVE_CPU) ? 0 : ENOTSUP;
}

/* Applies the file actions in order. An in-place spawn passes `undo`, which
 * first records each descriptor an action replaces (a copy above every
 * descriptor the actions name, or -1 when it was closed). */
struct saved { int fd, copy, flags; };
struct undo { struct saved *saved; int count, above; };
static int apply_actions(struct actions *actions, struct undo *undo) {
  for (struct action *a = actions ? actions->first : NULL; a; a = a->next) {
    if (undo && a->kind != CHDIR && a->kind != FCHDIR) {
      int fd = a->kind == DUP ? a->target : a->fd, known = 0;
      for (int i = 0; i < undo->count; i++) if (undo->saved[i].fd == fd) known = 1;
      if (!known) {
        int flags = fcntl(fd, F_GETFD), copy = flags < 0 ? -1 : fcntl(fd, F_DUPFD_CLOEXEC, undo->above);
        if (flags >= 0 && copy < 0) return errno;
        undo->saved[undo->count++] = (struct saved){ .fd = fd, .copy = copy, .flags = flags };
      }
    }
    switch (a->kind) {
      case CLOSE: close(a->fd); break;
      case DUP: if (dup2(a->fd, a->target) < 0 || fcntl(a->target, F_SETFD, 0)) return errno; break;
      case OPEN: {
        int fd = open(a->path, a->flags, a->mode); if (fd < 0) return errno;
        if (fd != a->fd) { int error = dup2(fd, a->fd) < 0 ? errno : 0; close(fd); if (error) return error; }
        break;
      }
      case CHDIR: if (chdir(a->path)) return errno; break;
      case FCHDIR: if (fchdir(a->fd)) return errno; break;
      case INHERIT: if (fcntl(a->fd, F_SETFD, 0)) return errno; break;
    }
  }
  return 0;
}
/* Whether a descriptor survives POSIX_SPAWN_CLOEXEC_DEFAULT. */
static int kept(struct actions *actions, int fd) {
  int keep = 0;
  for (struct action *a = actions ? actions->first : NULL; a; a = a->next) {
    if ((a->kind == DUP && a->target == fd) || ((a->kind == INHERIT || a->kind == OPEN) && a->fd == fd)) keep = 1;
    if (a->kind == CLOSE && a->fd == fd) keep = 0;
  }
  return keep;
}

/* POSIX_SPAWN_SETEXEC. Signals stay blocked while the caller is changed, so no
 * handler runs against half-applied state. CLOEXEC_DEFAULT marks descriptors
 * close-on-exec instead of closing them, so a failed execve can unmark them. */
static int launch_in_place(const char *file, const posix_spawn_file_actions_t *value, short flags,
  const sigset_t *mask, const sigset_t *defaults, int grouped, pid_t joined,
  struct proc_fdinfo *descriptors, int descriptorsSize, char *const argv[], char *const envp[]) {
  sigset_t all, caller, reset; struct sigaction handlers[NSIG];
  uid_t euid = geteuid(); gid_t egid = getegid();
  sigfillset(&all); sigemptyset(&reset);
  int error = pthread_sigmask(SIG_SETMASK, &all, &caller); if (error) return error;
  pthread_mutex_lock(&lock);
  struct actions *actions = value ? find(*value) : NULL;
  int size = 0, top = 2, directory = 0, count = 0, marked = 0, cwd = -1;
  for (struct action *a = actions ? actions->first : NULL; a; a = a->next) {
    size++; if (a->fd > top) top = a->fd; if (a->target > top) top = a->target;
    if (a->kind == CHDIR || a->kind == FCHDIR) directory = 1;
  }
  struct undo undo = { .saved = size ? calloc((size_t)size, sizeof(struct saved)) : NULL, .above = top + 1 };
  char *marker = NULL, **environment = grouped ? group_environment(envp, &marker) : NULL;
  if (value && !actions) { error = EINVAL; goto done; }
  if (size && !undo.saved) { error = ENOMEM; goto done; }
  /* Kept above every descriptor the actions name, like the copies, so an action
   * on a descriptor the caller never opened still fails. */
  if (directory) {
    int opened = open(".", O_SEARCH | O_CLOEXEC);
    cwd = opened < 0 ? -1 : fcntl(opened, F_DUPFD_CLOEXEC, undo.above);
    error = cwd < 0 ? errno : 0;
    if (opened >= 0) close(opened);
    if (error) goto done;
  }
  /* Without memory the image starts ungrouped, exactly as a forked child. */
  if (environment) write_group(marker, joined > 1 ? joined : getpid());
  if ((error = apply_actions(actions, &undo))) goto restore;
  if (descriptors) count = proc_pidinfo(getpid(), PROC_PIDLISTFDS, 0, descriptors, descriptorsSize);
  if (descriptors && (count <= 0 || count >= descriptorsSize)) { error = EMFILE; goto restore; }
  for (int i = 0; i < count / (int)sizeof(struct proc_fdinfo); i++) {
    int fd = descriptors[i].proc_fd, fdFlags = fcntl(fd, F_GETFD);
    if (fdFlags < 0 || (fdFlags & FD_CLOEXEC) || kept(actions, fd)) continue;
    if (fcntl(fd, F_SETFD, fdFlags | FD_CLOEXEC)) { error = errno; goto restore; }
    descriptors[marked++].proc_fd = fd; /* Compacted in place: marked <= i. */
  }
  if (flags & POSIX_SPAWN_RESETIDS) if (setegid(getgid()) || seteuid(getuid())) { error = errno; goto restore; }
  if (flags & POSIX_SPAWN_SETSIGDEF) for (int signal = 1; signal < NSIG; signal++) {
    if (signal == SIGKILL || signal == SIGSTOP || sigismember(defaults, signal) != 1) continue;
    struct sigaction action = { .sa_handler = SIG_DFL }; sigemptyset(&action.sa_mask);
    if (sigaction(signal, &action, &handlers[signal])) { error = errno; goto restore; }
    sigaddset(&reset, signal);
  }
  if ((error = pthread_sigmask(SIG_SETMASK, (flags & POSIX_SPAWN_SETSIGMASK) ? mask : &caller, NULL))) goto restore;
  execve(file, argv, environment ? environment : envp);
  error = errno;
  pthread_sigmask(SIG_SETMASK, &all, NULL);
restore:
  for (int signal = 1; signal < NSIG; signal++) if (sigismember(&reset, signal) == 1) sigaction(signal, &handlers[signal], NULL);
  if (geteuid() != euid) (void)seteuid(euid);
  if (getegid() != egid) (void)setegid(egid);
  for (int i = 0; i < marked; i++) {
    int fd = descriptors[i].proc_fd, fdFlags = fcntl(fd, F_GETFD);
    if (fdFlags >= 0) fcntl(fd, F_SETFD, fdFlags & ~FD_CLOEXEC);
  }
  for (int i = undo.count - 1; i >= 0; i--) {
    struct saved *saved = &undo.saved[i];
    if (saved->copy < 0) { close(saved->fd); continue; }
    dup2(saved->copy, saved->fd); fcntl(saved->fd, F_SETFD, saved->flags); close(saved->copy);
  }
  if (cwd >= 0) (void)fchdir(cwd);
done:
  if (cwd >= 0) close(cwd);
  pthread_mutex_unlock(&lock); free(undo.saved); free(environment); free(marker);
  pthread_sigmask(SIG_SETMASK, &caller, NULL);
  return error;
}

static int launch(pid_t *pid, const char *file, const posix_spawn_file_actions_t *value,
  const posix_spawnattr_t *attributes, char *const argv[], char *const envp[]) {
  short flags = 0; sigset_t mask, defaults; pid_t joined = 0;
  if (attributes) {
    int error = posix_spawnattr_getflags(attributes, &flags); if (error) return error;
    posix_spawnattr_getsigmask(attributes, &mask); posix_spawnattr_getsigdefault(attributes, &defaults);
    if ((flags & POSIX_SPAWN_SETPGROUP) && !(flags & POSIX_SPAWN_SETSID)) posix_spawnattr_getpgroup(attributes, &joined);
  }
  /* Detached callers may start, but cannot leave the supervisor's group. */
  int grouped = (flags & (POSIX_SPAWN_SETPGROUP | POSIX_SPAWN_SETSID)) && group_signals_enabled();
  flags &= ~(POSIX_SPAWN_SETPGROUP | POSIX_SPAWN_SETSID);
  if (flags & ~(POSIX_SPAWN_CLOEXEC_DEFAULT | POSIX_SPAWN_SETSIGDEF | POSIX_SPAWN_SETSIGMASK | POSIX_SPAWN_RESETIDS | POSIX_SPAWN_SETEXEC)) return ENOTSUP;
  if (attributes) { int error = preference(attributes); if (error) return error; }
  long maximum = sysconf(_SC_OPEN_MAX); if (maximum <= 0 || maximum > INT_MAX) return EINVAL;
  if ((unsigned long)maximum > INT_MAX / sizeof(struct proc_fdinfo)) return EMFILE;
  int descriptorsSize = (int)(maximum * sizeof(struct proc_fdinfo));
  struct proc_fdinfo *descriptors = flags & POSIX_SPAWN_CLOEXEC_DEFAULT ? malloc((size_t)descriptorsSize) : NULL;
  if ((flags & POSIX_SPAWN_CLOEXEC_DEFAULT) && !descriptors) return ENOMEM;
  if (flags & POSIX_SPAWN_SETEXEC) {
    int error = launch_in_place(file, value, flags, &mask, &defaults, grouped, joined, descriptors, descriptorsSize, argv, envp);
    free(descriptors); return error;
  }
  int errors[2]; if (pipe(errors)) { int error = errno; free(descriptors); return error; }
  fcntl(errors[0], F_SETFD, FD_CLOEXEC); fcntl(errors[1], F_SETFD, FD_CLOEXEC);
  pthread_mutex_lock(&lock);
  struct actions *actions = value ? find(*value) : NULL;
  if (value && !actions) { pthread_mutex_unlock(&lock); close(errors[0]); close(errors[1]); free(descriptors); return EINVAL; }
  /* Reserve the error pipe above every descriptor mentioned by an action. */
  int top = 2;
  for (struct action *a = actions ? actions->first : NULL; a; a = a->next) {
    if (a->fd > top) top = a->fd; if (a->target > top) top = a->target;
  }
  int report = fcntl(errors[1], F_DUPFD_CLOEXEC, top + 1); close(errors[1]);
  if (report < 0) { int error = errno; pthread_mutex_unlock(&lock); close(errors[0]); free(descriptors); return error; }
  /* Without memory the child starts ungrouped, exactly as before. */
  char *marker = NULL, **environment = grouped ? group_environment(envp, &marker) : NULL;
  if (environment && joined > 1) write_group(marker, joined);
  pid_t child = fork();
  if (child == 0) {
    close(errors[0]);
    if (environment && joined <= 1) write_group(marker, getpid());
    if (flags & POSIX_SPAWN_RESETIDS) if (setegid(getgid()) || seteuid(getuid())) goto failed;
    if (flags & POSIX_SPAWN_SETSIGMASK) if (sigprocmask(SIG_SETMASK, &mask, NULL)) goto failed;
    if (flags & POSIX_SPAWN_SETSIGDEF) for (int signal = 1; signal < NSIG; signal++) {
      if (signal == SIGKILL || signal == SIGSTOP || sigismember(&defaults, signal) != 1) continue;
      struct sigaction action = { .sa_handler = SIG_DFL }; sigemptyset(&action.sa_mask);
      if (sigaction(signal, &action, NULL)) goto failed;
    }
    if ((errno = apply_actions(actions, NULL))) goto failed;
    int count = descriptors ? proc_pidinfo(getpid(), PROC_PIDLISTFDS, 0, descriptors, descriptorsSize) : 0;
    if (descriptors && (count <= 0 || count >= descriptorsSize)) { errno = EMFILE; goto failed; }
    for (int i = 0; i < count / (int)sizeof(struct proc_fdinfo); i++) {
      int fd = descriptors[i].proc_fd;
      if (fd != report && !kept(actions, fd)) close(fd);
    }
    execve(file, argv, environment ? environment : envp);
failed: {
      int error = errno; (void)write(report, &error, sizeof(error)); _exit(127);
    }
  }
  int error = errno; pthread_mutex_unlock(&lock); close(report); free(descriptors); free(environment); free(marker);
  if (child < 0) { close(errors[0]); return error; }
  int result = 0; ssize_t readCount;
  do { readCount = read(errors[0], &result, sizeof(result)); } while (readCount < 0 && errno == EINTR);
  close(errors[0]);
  if (readCount != 0) { int status; while (waitpid(child, &status, 0) < 0 && errno == EINTR) {} return result ? result : EIO; }
  if (grouped && joined <= 1) { pthread_mutex_lock(&lock); detached[detachedCount++ % 64] = child; pthread_mutex_unlock(&lock); }
  if (pid) *pid = child; return 0;
}
static int launch_path(pid_t *pid, const char *file, const posix_spawn_file_actions_t *actions,
  const posix_spawnattr_t *attributes, char *const argv[], char *const envp[]) {
  if (strchr(file, '/')) return launch(pid, file, actions, attributes, argv, envp);
  const char *paths = getenv("PATH"); if (!paths) paths = "/usr/bin:/bin";
  const char *start = paths;
  int denied = 0;
  do {
    const char *end = strchr(start, ':'); size_t size = end ? (size_t)(end - start) : strlen(start);
    char candidate[PATH_MAX]; size_t name = strlen(file);
    if (size + name + 2 < sizeof(candidate)) {
      memcpy(candidate, start, size); candidate[size] = '/'; memcpy(candidate + size + 1, file, name + 1);
      if (!size) memmove(candidate, candidate + 1, name + 1);
      int result = launch(pid, candidate, actions, attributes, argv, envp);
      if (result == 0) return 0;
      if (result == EACCES) denied = 1;
      else if (result != ENOENT && result != ENOTDIR) return result;
    }
    if (!end) break; start = end + 1;
  } while (1);
  return denied ? EACCES : ENOENT;
}

static int signal_process(pid_t pid, int signal) {
  int outcome;
  if (pid < -1) {
    char name[GROUP_DIGITS + sizeof(GROUP_VARIABLE)]; write_group(name, -pid);
    const char *names[1] = { name + sizeof(GROUP_VARIABLE) - 1 };
    /* Read without the lock: kill may interrupt a spawn holding it. */
    pid_t leader = 0; for (int i = 0; i < 64; i++) if (detached[i] == -pid) leader = -pid;
    if (group_signal(names, 1, leader, signal, getpid(), 0, &outcome)) return outcome;
  } else if (pid == 0 && group_signal(NULL, 0, 0, signal, getpid(), 0, &outcome)) return outcome;
  return kill(pid, signal);
}
static int signal_process_group(pid_t group, int signal) {
  if (group > 1) return signal_process(-group, signal);
  if (group == 0) return signal_process(0, signal);
  return killpg(group, signal);
}

INTERPOSE(signal_process, kill);
INTERPOSE(signal_process_group, killpg);
INTERPOSE(initialize, posix_spawn_file_actions_init);
INTERPOSE(destroy, posix_spawn_file_actions_destroy);
INTERPOSE(close_action, posix_spawn_file_actions_addclose);
INTERPOSE(dup_action, posix_spawn_file_actions_adddup2);
INTERPOSE(open_action, posix_spawn_file_actions_addopen);
INTERPOSE(chdir_action, posix_spawn_file_actions_addchdir_np);
INTERPOSE(fchdir_action, posix_spawn_file_actions_addfchdir_np);
/* macOS 26 names (Chromium imports these); an untracked chdir action would
 * silently start the child in the wrong directory. */
#pragma clang diagnostic ignored "-Wunguarded-availability-new"
INTERPOSE(chdir_action, posix_spawn_file_actions_addchdir);
INTERPOSE(fchdir_action, posix_spawn_file_actions_addfchdir);
INTERPOSE(inherit_action, posix_spawn_file_actions_addinherit_np);
INTERPOSE(launch, posix_spawn);
INTERPOSE(launch_path, posix_spawnp);
