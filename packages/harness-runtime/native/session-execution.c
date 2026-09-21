/* DevRyan private execution supervisor. No library dependencies.
 * The durable receipt descriptor is never inherited by the command. A receipt
 * is written only after every live member of the confined group is gone.
 */
#define _GNU_SOURCE
#include <errno.h>
#include <fcntl.h>
#include <signal.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>
#include <limits.h>
#include <sys/stat.h>
#include <sys/types.h>
#include <sys/wait.h>
#include <sys/file.h>
#ifdef __APPLE__
#include <libproc.h>
#include <sandbox.h>
#include <sys/proc_info.h>
#include <sys/proc.h>
#include <sys/syscall.h>
#elif defined(__linux__)
#include <dirent.h>
#include <stddef.h>
#include <stdint.h>
#include <linux/audit.h>
#include <linux/filter.h>
#include <linux/landlock.h>
#include <linux/seccomp.h>
#include <sys/prctl.h>
#include <sys/syscall.h>
#include <sys/mount.h>
#include <linux/mount.h>
#include <sched.h>
#include <limits.h>
#else
#error Unsupported execution supervisor platform
#endif

static volatile sig_atomic_t cancelled = 0;
static void cancel(int signal) { (void)signal; cancelled = 1; }
static void fatal(const char *message) { perror(message); _exit(125); }

#ifdef __linux__
static void mapping(const char *file, const char *value) {
  int fd = open(file, O_WRONLY | O_CLOEXEC);
  if (fd < 0 || write(fd, value, strlen(value)) != (ssize_t)strlen(value)) fatal("namespace mapping");
  close(fd);
}

/* Landlock deliberately does not mediate chmod/chown/xattr/utime. A private
 * read-only mount tree supplies that missing boundary without emulating
 * pathname syscalls in userspace (which would introduce symlink races).
 * A private PID/proc and IPC namespace prevent /proc/<host>/root/fd escapes.
 * Unsupported kernels/user-namespace policies fail before command execution.
 */
static void readonly_host(const char *directory, const char *scratch) {
  uid_t uid = getuid(); gid_t gid = getgid(); char value[96];
  if (unshare(CLONE_NEWUSER | CLONE_NEWNS | CLONE_NEWIPC | CLONE_NEWPID)) fatal("private namespaces required");
  mapping("/proc/self/setgroups", "deny");
  snprintf(value, sizeof(value), "%u %u 1", uid, uid); mapping("/proc/self/uid_map", value);
  snprintf(value, sizeof(value), "%u %u 1", gid, gid); mapping("/proc/self/gid_map", value);
  pid_t init = fork();
  if (init < 0) fatal("private pid namespace");
  if (init) {
    int status;
    while (waitpid(init, &status, 0) < 0) if (errno != EINTR) fatal("private init wait");
    _exit(WIFEXITED(status) ? WEXITSTATUS(status) : 128 + WTERMSIG(status));
  }
  if (mount(NULL, "/", NULL, MS_REC | MS_PRIVATE, NULL)) fatal("private mount propagation");
  char root[PATH_MAX], target[PATH_MAX];
  if (snprintf(root, sizeof(root), "%s/rootfs", scratch) >= (int)sizeof(root)) fatal("private root length");
  if (mkdir(root, 0700)) fatal("private root");
  int tree = syscall(SYS_open_tree, AT_FDCWD, "/", OPEN_TREE_CLONE | OPEN_TREE_CLOEXEC | AT_RECURSIVE);
  if (tree < 0) fatal("private mount tree");
  struct mount_attr attributes = { .attr_set = MOUNT_ATTR_RDONLY | MOUNT_ATTR_NOSUID };
  if (syscall(SYS_mount_setattr, tree, "", AT_EMPTY_PATH | AT_RECURSIVE, &attributes, sizeof(attributes))) fatal("read-only host mounts");
  if (syscall(SYS_move_mount, tree, "", AT_FDCWD, root, MOVE_MOUNT_F_EMPTY_PATH)) fatal("private root mount");
  close(tree);
  const char *roots[] = { directory, scratch, getenv("DEVRYAN_EXECUTION_CACHE") };
  for (unsigned int i = 0; i < sizeof(roots) / sizeof(roots[0]); i++) {
    if (!roots[i] || (i == 2 && !strcmp(roots[i], scratch))) continue;
    if (snprintf(target, sizeof(target), "%s%s", root, roots[i]) >= (int)sizeof(target)) fatal("private mount length");
    // Nonrecursive: never carry a nested mount from the host into a writable root.
    if (mount(roots[i], target, NULL, MS_BIND, NULL)) fatal("private writable mount");
    if (mount(NULL, target, NULL, MS_BIND | MS_REMOUNT | MS_NOSUID | MS_NODEV, NULL)) fatal("private mount attributes");
  }
  if (snprintf(target, sizeof(target), "%s/proc", root) >= (int)sizeof(target)) fatal("private proc length");
  if (mount("proc", target, "proc", MS_NOSUID | MS_NODEV | MS_NOEXEC, NULL)) fatal("private proc");
  if (chdir(root) || chroot(".") || chdir(directory)) fatal("private root entry");
}

#define DENY_CALL(number) BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, number, 0, 1), BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_ERRNO | EPERM)
static void confine(const char *directory, const char *scratch) {
  int abi = syscall(SYS_landlock_create_ruleset, NULL, 0, LANDLOCK_CREATE_RULESET_VERSION);
  /* ABI 9 additionally confines pathname sockets; ABI 6 scopes signals and
   * abstract sockets. Never silently remove required confinement rights. */
  if (abi < 9) { errno = ENOTSUP; fatal("Landlock ABI 9 required"); }
  readonly_host(directory, scratch);
  uint64_t writes = LANDLOCK_ACCESS_FS_WRITE_FILE | LANDLOCK_ACCESS_FS_REMOVE_DIR |
    LANDLOCK_ACCESS_FS_REMOVE_FILE | LANDLOCK_ACCESS_FS_MAKE_CHAR |
    LANDLOCK_ACCESS_FS_MAKE_DIR | LANDLOCK_ACCESS_FS_MAKE_REG |
    LANDLOCK_ACCESS_FS_MAKE_SOCK | LANDLOCK_ACCESS_FS_MAKE_FIFO |
    LANDLOCK_ACCESS_FS_MAKE_BLOCK | LANDLOCK_ACCESS_FS_MAKE_SYM |
    LANDLOCK_ACCESS_FS_REFER | LANDLOCK_ACCESS_FS_TRUNCATE;
  struct { uint64_t handled_access_fs, handled_access_net, scoped; } rules = {
    .handled_access_fs = writes | (1ULL << 15) | (1ULL << 16), .scoped = 3,
  };
  int rule = syscall(SYS_landlock_create_ruleset, &rules, sizeof(rules), 0);
  if (rule < 0) fatal("Landlock ruleset");
  const char *roots[] = { directory, scratch, getenv("DEVRYAN_EXECUTION_CACHE") };
  for (unsigned int i = 0; i < sizeof(roots) / sizeof(roots[0]); i++) {
    if (!roots[i]) continue;
    int fd = open(roots[i], O_PATH | O_CLOEXEC | O_DIRECTORY);
    if (fd < 0) fatal("private execution root");
    struct landlock_path_beneath_attr grant = { .allowed_access = writes, .parent_fd = fd };
    if (syscall(SYS_landlock_add_rule, rule, LANDLOCK_RULE_PATH_BENEATH, &grant, 0)) fatal("Landlock grant");
    close(fd);
  }
  int nullfd = open("/dev/null", O_PATH | O_CLOEXEC);
  if (nullfd < 0) fatal("null device");
  struct landlock_path_beneath_attr nullgrant = { .allowed_access = LANDLOCK_ACCESS_FS_WRITE_FILE, .parent_fd = nullfd };
  if (syscall(SYS_landlock_add_rule, rule, LANDLOCK_RULE_PATH_BENEATH, &nullgrant, 0)) fatal("Landlock null grant");
  close(nullfd);
  if (prctl(PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0)) fatal("no_new_privs");
  if (syscall(SYS_landlock_restrict_self, rule, 0)) fatal("Landlock restrict");
  close(rule);
  /* A process group is an ownership boundary only if commands cannot leave it.
   * seccomp is inherited across fork/exec and cannot be relaxed by descendants.
   */
  struct sock_filter filters[] = {
    BPF_STMT(BPF_LD | BPF_W | BPF_ABS, offsetof(struct seccomp_data, arch)),
#if defined(__aarch64__)
    BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, AUDIT_ARCH_AARCH64, 1, 0),
#elif defined(__x86_64__)
    BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, AUDIT_ARCH_X86_64, 1, 0),
#else
#error Unsupported Landlock architecture
#endif
    BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_KILL_PROCESS),
    BPF_STMT(BPF_LD | BPF_W | BPF_ABS, offsetof(struct seccomp_data, nr)),
#if defined(__x86_64__)
    BPF_JUMP(BPF_JMP | BPF_JSET | BPF_K, 0x40000000, 0, 1),
    BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_KILL_PROCESS),
#endif
    DENY_CALL(SYS_setpgid), DENY_CALL(SYS_setsid), DENY_CALL(SYS_unshare), DENY_CALL(SYS_setns),
    DENY_CALL(SYS_mount), DENY_CALL(SYS_umount2), DENY_CALL(SYS_pivot_root), DENY_CALL(SYS_chroot),
    DENY_CALL(SYS_open_tree), DENY_CALL(SYS_move_mount), DENY_CALL(SYS_mount_setattr),
    DENY_CALL(SYS_fsopen), DENY_CALL(SYS_fsconfig), DENY_CALL(SYS_fsmount), DENY_CALL(SYS_fspick),
    DENY_CALL(SYS_ptrace), DENY_CALL(SYS_process_vm_writev), DENY_CALL(SYS_pidfd_getfd),
    DENY_CALL(SYS_open_by_handle_at), DENY_CALL(SYS_io_uring_setup),
    BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_ALLOW),
  };
  struct sock_fprog program = { .len = sizeof(filters) / sizeof(filters[0]), .filter = filters };
  if (prctl(PR_SET_SECCOMP, SECCOMP_MODE_FILTER, &program)) fatal("process ownership filter");
}
#endif

static int group_live(pid_t group) {
#ifdef __APPLE__
  int bytes = proc_listpids(PROC_PGRP_ONLY, (unsigned int)group, NULL, 0);
  if (bytes < 0) return -1;
  bytes += 128 * sizeof(pid_t);
  pid_t *pids = calloc(1, (size_t)bytes);
  if (!pids) return -1;
  int count = proc_listpids(PROC_PGRP_ONLY, (unsigned int)group, pids, bytes);
  if (count < 0 || count >= bytes) { free(pids); return -1; }
  int live = 0;
  for (int i = 0; i < count / (int)sizeof(pid_t); i++) {
    if (pids[i] <= 0) continue;
    struct proc_bsdinfo info;
    int size = proc_pidinfo(pids[i], PROC_PIDTBSDINFO, 0, &info, sizeof(info));
    if (size != sizeof(info)) { if (errno != ESRCH) live = -1; continue; }
    if (info.pbi_pgid == (unsigned int)group && info.pbi_status != SZOMB) live = 1;
  }
  free(pids);
  return live;
#else
  DIR *proc = opendir("/proc");
  if (!proc) return -1;
  int live = 0;
  struct dirent *entry;
  while ((entry = readdir(proc))) {
    if (entry->d_name[0] < '0' || entry->d_name[0] > '9') continue;
    char filename[512], line[4096];
    snprintf(filename, sizeof(filename), "/proc/%s/stat", entry->d_name);
    FILE *file = fopen(filename, "r");
    if (!file) { if (errno != ENOENT && errno != ESRCH) live = -1; continue; }
    char *read = fgets(line, sizeof(line), file); fclose(file);
    char *end = read ? strrchr(line, ')') : NULL;
    char state; int parent, pgid;
    if (!end || sscanf(end + 1, " %c %d %d", &state, &parent, &pgid) != 3) { live = -1; continue; }
    if (pgid == group && state != 'Z' && state != 'X') live = 1;
  }
  closedir(proc);
  return live;
#endif
}

int main(int argc, char **argv) {
  if (argc == 3 && (!strcmp(argv[1], "--owner-lock") || !strcmp(argv[1], "--owner-probe"))) {
    int fd = open(argv[2], O_RDWR | O_CREAT | O_CLOEXEC | O_NOFOLLOW, 0600);
    if (fd < 0) fatal("owner lock");
    if (flock(fd, LOCK_EX | LOCK_NB)) {
      if (errno == EWOULDBLOCK || errno == EAGAIN) { close(fd); return 73; }
      fatal("owner lock acquisition");
    }
    if (!strcmp(argv[1], "--owner-probe")) { close(fd); return 0; }
    if (write(STDOUT_FILENO, "owned\n", 6) != 6) fatal("owner lock acknowledgement");
    char byte;
    while (read(STDIN_FILENO, &byte, 1) > 0) {}
    close(fd); return 0;
  }
  if (argc < 7 || strcmp(argv[5], "--")) { fprintf(stderr, "usage: DevRyan-execution cwd scratch profile receipt -- command [args]\n"); return 125; }
  int receipt = open(argv[4], O_WRONLY | O_CREAT | O_EXCL | O_CLOEXEC, 0600);
  if (receipt < 0) fatal("exclusive termination receipt");
  int ready[2]; if (pipe(ready)) fatal("confinement receipt pipe");
  if (fcntl(ready[0], F_SETFD, FD_CLOEXEC) || fcntl(ready[1], F_SETFD, FD_CLOEXEC)) fatal("confinement pipe handles");
  pid_t owner = getppid();
  signal(SIGTERM, cancel); signal(SIGINT, cancel); signal(SIGHUP, cancel); signal(SIGPIPE, SIG_IGN);
  pid_t child = fork();
  if (child < 0) fatal("fork");
  if (!child) {
    signal(SIGTERM, SIG_DFL); signal(SIGINT, SIG_DFL); signal(SIGHUP, SIG_DFL); signal(SIGPIPE, SIG_DFL);
    if (setpgid(0, 0) || chdir(argv[1])) fatal("private execution directory");
    /* No inherited writable descriptors, including the host receipt pipe. */
    long maximum = sysconf(_SC_OPEN_MAX);
    if (maximum < 0) fatal("descriptor limit");
#ifdef __APPLE__
    if ((unsigned long)maximum > INT_MAX / sizeof(struct proc_fdinfo)) fatal("descriptor capacity");
    int capacity = (int)(maximum * sizeof(struct proc_fdinfo));
    struct proc_fdinfo *descriptors = malloc((size_t)capacity);
    if (!descriptors) fatal("descriptor allocation");
    int count = proc_pidinfo(getpid(), PROC_PIDLISTFDS, 0, descriptors, capacity);
    if (count <= 0 || count >= capacity) fatal("descriptor enumeration");
    for (int i = 0; i < count / (int)sizeof(struct proc_fdinfo); i++) {
      int fd = descriptors[i].proc_fd;
      if (fd > 2 && fd != ready[1]) close(fd);
    }
    free(descriptors);
#else
    for (int fd = 3; fd < maximum; fd++) if (fd != ready[1]) close(fd);
#endif
#ifdef __APPLE__
    FILE *file = fopen(argv[3], "r");
    if (!file) fatal("sandbox profile");
    if (fseek(file, 0, SEEK_END)) fatal("sandbox profile length");
    long length = ftell(file);
    if (length <= 0 || length > 65536) { errno = EINVAL; fatal("sandbox profile length"); }
    rewind(file);
    char *profile = calloc(1, (size_t)length + 1), *error = NULL;
    if (!profile || fread(profile, 1, (size_t)length, file) != (size_t)length) fatal("sandbox profile read");
    fclose(file);
#pragma clang diagnostic push
#pragma clang diagnostic ignored "-Wdeprecated-declarations"
    if (sandbox_init(profile, 0, &error)) { fprintf(stderr, "Seatbelt: %s\n", error ? error : "unavailable"); _exit(125); }
#pragma clang diagnostic pop
    free(profile);
#else
    confine(argv[1], argv[2]);
#endif
    const char *working = getenv("DEVRYAN_EXECUTION_CWD");
    if (working && chdir(working)) fatal("scoped working directory");
    if (write(ready[1], "1", 1) != 1) fatal("confinement acknowledgement");
    close(ready[1]);
    execvp(argv[6], argv + 6); fatal("execution command");
  }
  close(ready[1]);
  /* Keep the leader unreaped until its group is empty, preventing PID reuse. */
  int status = 0, exited = 0;
  while (1) {
    siginfo_t info; memset(&info, 0, sizeof(info));
    if (waitid(P_PID, (id_t)child, &info, WEXITED | WNOHANG | WNOWAIT) < 0 && errno != EINTR) fatal("waitid");
    if (info.si_pid == child) exited = 1;
    if (getppid() != owner) cancelled = 1;
    if (cancelled || exited) {
      kill(-child, SIGKILL);
      if (exited && group_live(child) == 0) break;
    }
    usleep(10000);
  }
  if (waitpid(child, &status, 0) != child) fatal("waitpid");
  int code = WIFEXITED(status) ? WEXITSTATUS(status) : 128 + WTERMSIG(status);
  char attested = 0; int confined = read(ready[0], &attested, 1) == 1 && attested == '1'; close(ready[0]);
  if (dprintf(receipt, "{\"terminated\":true,\"confined\":%s,\"cancelled\":%s,\"exitCode\":%d}\n", confined ? "true" : "false", cancelled ? "true" : "false", code) < 0 || fsync(receipt)) fatal("termination receipt");
  close(receipt);
  return code;
}
