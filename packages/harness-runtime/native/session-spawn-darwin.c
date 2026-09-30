/* Compatibility adapter for runtimes that cannot fall back from posix_spawn.
 * The kernel still denies posix_spawn/setpgid/setsid. This library provides no
 * extra authority: it implements the supported file actions using fork/exec,
 * which inherit the supervisor's immutable Seatbelt policy and process group.
 * Omitting/removing the adapter therefore fails closed. Detached spawn requests
 * run in the existing supervised group; creating a new group remains denied.
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
  if (flags & ~(POSIX_SPAWN_CLOEXEC_DEFAULT | POSIX_SPAWN_SETSIGDEF | POSIX_SPAWN_SETSIGMASK | POSIX_SPAWN_RESETIDS)) return ENOTSUP;
  long maximum = sysconf(_SC_OPEN_MAX); if (maximum <= 0 || maximum > INT_MAX) return EINVAL;
  if ((unsigned long)maximum > INT_MAX / sizeof(struct proc_fdinfo)) return EMFILE;
  int descriptorsSize = (int)(maximum * sizeof(struct proc_fdinfo));
  struct proc_fdinfo *descriptors = flags & POSIX_SPAWN_CLOEXEC_DEFAULT ? malloc((size_t)descriptorsSize) : NULL;
  if ((flags & POSIX_SPAWN_CLOEXEC_DEFAULT) && !descriptors) return ENOMEM;
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
    for (struct action *a = actions ? actions->first : NULL; a; a = a->next) {
      switch (a->kind) {
        case CLOSE: close(a->fd); break;
        case DUP: if (dup2(a->fd, a->target) < 0 || fcntl(a->target, F_SETFD, 0)) goto failed; break;
        case OPEN: {
          int fd = open(a->path, a->flags, a->mode); if (fd < 0) goto failed;
          if (fd != a->fd) { if (dup2(fd, a->fd) < 0) goto failed; close(fd); }
          break;
        }
        case CHDIR: if (chdir(a->path)) goto failed; break;
        case FCHDIR: if (fchdir(a->fd)) goto failed; break;
        case INHERIT: if (fcntl(a->fd, F_SETFD, 0)) goto failed; break;
      }
    }
    int count = descriptors ? proc_pidinfo(getpid(), PROC_PIDLISTFDS, 0, descriptors, descriptorsSize) : 0;
    if (descriptors && (count <= 0 || count >= descriptorsSize)) { errno = EMFILE; goto failed; }
    for (int i = 0; i < count / (int)sizeof(struct proc_fdinfo); i++) {
      int fd = descriptors[i].proc_fd;
      if (fd == report) continue;
      int keep = 0;
      for (struct action *a = actions ? actions->first : NULL; a; a = a->next) {
        if ((a->kind == DUP && a->target == fd) || ((a->kind == INHERIT || a->kind == OPEN) && a->fd == fd)) keep = 1;
        if (a->kind == CLOSE && a->fd == fd) keep = 0;
      }
      if (!keep) close(fd);
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
