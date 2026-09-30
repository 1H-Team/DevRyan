/* Virtual process groups for confined macOS executions.
 *
 * The kernel keeps every confined process in the supervisor's group (setpgid,
 * setsid and posix_spawn attributes are denied), so a caller that asked for
 * its own group (a detached spawn) and later signals that group would reach
 * nothing, then wait forever for a child it cannot stop (Playwright's
 * webServer, bounded test wrappers).
 *
 * A child that requested a group carries its name in DEVRYAN_SPAWN_GROUP,
 * which its descendants inherit. A group signal is delivered to the members of
 * the supervised group that carry one of the requested names. The spawn
 * adapter names a group after the child's pid; the Node preload, for Node
 * processes started without the adapter, uses its own names. macOS does not
 * reveal the environment of system binaries (/bin/sh, sleep), so the process
 * that started a group also names its leader: the leader and every descendant
 * without a readable name of its own belong to the group.
 *
 * No authority is added: the profile already lets a confined process signal
 * every process of its own sandbox, and nothing leaves the supervised group.
 * DEVRYAN_WORKER_GROUP_SIGNALS=0 restores plain kernel behaviour.
 */
#ifndef DEVRYAN_SESSION_GROUP_DARWIN_H
#define DEVRYAN_SESSION_GROUP_DARWIN_H
#include <errno.h>
#include <signal.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>
#include <sys/mman.h>
#include <sys/proc.h>
#include <sys/sysctl.h>

#define GROUP_VARIABLE "DEVRYAN_SPAWN_GROUP="
#define GROUP_NAME 40

static int group_signals_enabled(void) {
  const char *value = getenv("DEVRYAN_WORKER_GROUP_SIGNALS");
  return !(value && value[0] == '0' && !value[1]);
}
static int group_name_valid(const char *name) {
  size_t size = 0;
  for (; name[size]; size++) {
    char c = name[size];
    if (size >= GROUP_NAME - 1) return 0;
    if (!((c >= '0' && c <= '9') || (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || c == '.' || c == '_' || c == '-')) return 0;
  }
  return size > 0;
}
/* Group a process was started with, read from its initial environment. An
 * unreadable process or a malformed name belongs to no group. */
static void group_started_with(pid_t pid, char *buffer, size_t capacity, char *group) {
  group[0] = 0;
  int name[3] = { CTL_KERN, KERN_PROCARGS2, pid }; size_t length = capacity;
  if (sysctl(name, 3, buffer, &length, NULL, 0) || length <= sizeof(int)) return;
  int count; memcpy(&count, buffer, sizeof(count));
  char *at = buffer + sizeof(int), *end = buffer + length;
  while (at < end && *at) at++;
  while (at < end && !*at) at++;
  for (int i = 0; i < count && at < end; i++) at += strnlen(at, (size_t)(end - at)) + 1;
  size_t prefix = sizeof(GROUP_VARIABLE) - 1;
  while (at < end && *at) {
    size_t size = strnlen(at, (size_t)(end - at));
    if (at + size >= end) return;
    if (size > prefix && size < prefix + GROUP_NAME && !strncmp(at, GROUP_VARIABLE, prefix)) {
      if (group_name_valid(at + prefix)) memcpy(group, at + prefix, size - prefix + 1);
      return;
    }
    at += size + 1;
  }
}
static int group_name_is(const char *name, pid_t pid) {
  char *end = NULL; long value = strtol(name, &end, 10);
  return name[0] >= '1' && name[0] <= '9' && !*end && value == (long)pid;
}
/* Delivers a signal to the virtual groups named. Returns 1 when a group has
 * live members (the result is then in *outcome), 0 when it has none and the
 * kernel must decide. Without names the group is the caller's own. `leader` is
 * the group's first process when the caller started it, else 0. The caller is
 * signalled last, so a fatal signal cannot stop the delivery to the others;
 * `excluded` (a helper acting for the caller) is never signalled. kill may run
 * in a signal handler, so memory comes from mmap instead of the allocator. */
static int group_signal(const char *const *names, int nameCount, pid_t leader, int signal, pid_t caller, pid_t excluded, int *outcome) {
  if (!group_signals_enabled()) return 0;
  int argumentsName[2] = { CTL_KERN, KERN_ARGMAX }, maximum = 0; size_t size = sizeof(maximum);
  if (sysctl(argumentsName, 2, &maximum, &size, NULL, 0) || maximum <= 0) return 0;
  int membersName[4] = { CTL_KERN, KERN_PROC, KERN_PROC_PGRP, getpgrp() }; size_t listed = 0;
  if (sysctl(membersName, 4, NULL, &listed, NULL, 0) || !listed) return 0;
  listed += 64 * sizeof(struct kinfo_proc);
  size_t capacity = listed / sizeof(struct kinfo_proc);
  size_t mapped = (size_t)maximum + listed + capacity * (GROUP_NAME + 1);
  char *memory = mmap(NULL, mapped, PROT_READ | PROT_WRITE, MAP_PRIVATE | MAP_ANON, -1, 0);
  if (memory == MAP_FAILED) return 0;
  struct kinfo_proc *members = (struct kinfo_proc *)(void *)(memory + maximum);
  char *groups = memory + maximum + listed, *belongs = groups + capacity * GROUP_NAME;
  int found = 0, delivered = 0, failure = ESRCH, self = 0;
  if (sysctl(membersName, 4, members, &listed, NULL, 0)) goto done;
  size_t count = listed / sizeof(struct kinfo_proc);
  if (count > capacity) count = capacity;
  for (size_t i = 0; i < count; i++) group_started_with(members[i].kp_proc.p_pid, memory, (size_t)maximum, groups + i * GROUP_NAME);
  const char *own = NULL;
  if (!names) {
    for (size_t i = 0; i < count; i++) if (members[i].kp_proc.p_pid == caller) own = groups + i * GROUP_NAME;
    if (!own || !own[0]) goto done;
    names = &own; nameCount = 1;
  }
  /* A group named after a pid was started by the adapter for that process. */
  for (size_t i = 0; !leader && i < count; i++) for (int at = 0; !leader && at < nameCount; at++) {
    if (!strcmp(groups + i * GROUP_NAME, names[at]) && group_name_is(names[at], (pid_t)strtol(names[at], NULL, 10))) leader = (pid_t)strtol(names[at], NULL, 10);
  }
  /* 1 member, 0 not a member, 2 decided by the parent: a process without a
   * readable name (a system binary, a replaced environment). */
  for (size_t i = 0; i < count; i++) {
    const char *group = groups + i * GROUP_NAME; belongs[i] = 2;
    if (group[0]) { belongs[i] = 0; for (int at = 0; at < nameCount; at++) if (!strcmp(group, names[at])) belongs[i] = 1; }
    else if (leader > 1 && members[i].kp_proc.p_pid == leader) belongs[i] = 1;
  }
  for (int pass = 0, changed = 1; changed && pass < 64; pass++) {
    changed = 0;
    for (size_t i = 0; i < count; i++) {
      if (belongs[i] != 2) continue;
      size_t at = 0; while (at < count && members[at].kp_proc.p_pid != members[i].kp_eproc.e_ppid) at++;
      if (at == count) belongs[i] = 0; else if (belongs[at] != 2) belongs[i] = belongs[at]; else continue;
      changed = 1;
    }
  }
  for (size_t i = 0; i < count; i++) {
    pid_t pid = members[i].kp_proc.p_pid;
    if (belongs[i] != 1 || pid == excluded || members[i].kp_proc.p_stat == SZOMB) continue;
    found = 1;
    if (pid == caller) { self = 1; continue; }
    if (!kill(pid, signal)) delivered = 1; else if (errno != ESRCH) failure = errno;
  }
  if (self) { if (!kill(caller, signal)) delivered = 1; else failure = errno; }
done:
  munmap(memory, mapped);
  if (!found) return 0;
  if (delivered) *outcome = 0; else { errno = failure; *outcome = -1; }
  return 1;
}
#endif
