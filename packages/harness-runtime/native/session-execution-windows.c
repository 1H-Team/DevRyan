/* DevRyan Windows execution supervisor. Uses only Windows SDK facilities.
 * An LPAC token grants reads and mutations only through scoped ACLs.
 * A private desktop and job contain the entire process tree.
 * The command receives only its three pipe handles, never the job or receipt.
 */
#define UNICODE
#define _UNICODE
#define _WIN32_WINNT 0x0A00
#include <windows.h>
#include <aclapi.h>
#include <sddl.h>
#include <userenv.h>
#include <tlhelp32.h>
#include <stdio.h>
#include <stdlib.h>
#include <wchar.h>
#include <errno.h>
#include <string.h>

static wchar_t active_profile[96];
static HANDLE active_job;

static void fail(const char *operation) {
  DWORD error = GetLastError();
  BOOL settled = TRUE;
  if (active_job) {
    settled = TerminateJobObject(active_job, 125);
    ULONGLONG deadline = GetTickCount64() + 5000;
    while (settled) {
      JOBOBJECT_BASIC_ACCOUNTING_INFORMATION state;
      settled = QueryInformationJobObject(active_job, JobObjectBasicAccountingInformation, &state, sizeof(state), NULL);
      if (!settled || !state.ActiveProcesses) break;
      if (GetTickCount64() >= deadline) { settled = FALSE; break; }
      Sleep(10);
    }
    CloseHandle(active_job); active_job = NULL;
  }
  if (*active_profile && settled) {
    HRESULT cleanup = DeleteAppContainerProfile(active_profile);
    if (FAILED(cleanup)) fprintf(stderr, "LPAC profile cleanup failed (%lu)\n", (DWORD)cleanup);
  }
  fprintf(stderr, "%s failed (%lu)\n", operation, error);
  ExitProcess(125);
}
static void checked(BOOL ok, const char *operation) { if (!ok) fail(operation); }

/* SDK 26100 adds flags which older kernels reject. Require a genuine OS build,
 * apply every supported restriction, and never retry with a reduced mask. */
_Static_assert(JOB_OBJECT_UILIMIT_ALL == 0x3ff, "Reviewed Windows SDK UI flags changed");
static DWORD os_build(void) {
  typedef LONG (WINAPI *version_query)(OSVERSIONINFOW *);
  HMODULE module = GetModuleHandleW(L"ntdll.dll");
  if (!module) fail("OS version module");
  FARPROC symbol = GetProcAddress(module, "RtlGetVersion");
  if (!symbol) fail("OS version operation");
  version_query query;
  _Static_assert(sizeof(query) == sizeof(symbol), "Windows version pointer size changed");
  memcpy(&query, &symbol, sizeof(query));
  OSVERSIONINFOW version = {0}; version.dwOSVersionInfoSize = sizeof(version);
  if (query(&version) != 0 || version.dwMajorVersion != 10 || version.dwBuildNumber < 10240) {
    SetLastError(ERROR_NOT_SUPPORTED); fail("supported Windows version");
  }
  return version.dwBuildNumber;
}
static DWORD maximum_ui_limits(DWORD build) {
  return 0xff | (build >= 22621 ? 0x100 : 0) | (build >= 26100 ? 0x200 : 0);
}

/* Inspect the containing job without changing it. The UI experiment uses a
 * new empty job, never a child or a runtime admission grant. */
static int inspect_job_boundary(void) {
  DWORD build = os_build();
  BOOL inJob;
  checked(IsProcessInJob(GetCurrentProcess(), NULL, &inJob), "containing job");
  JOBOBJECT_EXTENDED_LIMIT_INFORMATION host = {0}, limits = {0};
  if (inJob) checked(QueryInformationJobObject(NULL, JobObjectExtendedLimitInformation,
    &host, sizeof(host), NULL), "containing job limits");
  HANDLE job = CreateJobObjectW(NULL, NULL);
  if (!job) fail("probe job");
  limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE | JOB_OBJECT_LIMIT_DIE_ON_UNHANDLED_EXCEPTION;
  checked(SetInformationJobObject(job, JobObjectExtendedLimitInformation, &limits, sizeof(limits)), "probe job ownership");
  JOBOBJECT_BASIC_UI_RESTRICTIONS ui = { maximum_ui_limits(build) }, observed = {0};
  BOOL set = SetInformationJobObject(job, JobObjectBasicUIRestrictions, &ui, sizeof(ui));
  DWORD error = set ? ERROR_SUCCESS : GetLastError();
  if (set) checked(QueryInformationJobObject(job, JobObjectBasicUIRestrictions, &observed, sizeof(observed), NULL), "probe job UI receipt");
  printf("{\"protocol\":\"devryan.windows-job-probe/2\",\"osBuild\":%lu,\"sdkUIFlags\":%lu,\"inJob\":%s,\"hostLimitFlags\":%lu,\"breakawayAllowed\":%s,\"silentBreakawayAllowed\":%s,\"requestedUIFlags\":%lu,\"uiSet\":%s,\"uiError\":%lu,\"uiReadBack\":%lu}\n",
    build, (DWORD)JOB_OBJECT_UILIMIT_ALL,
    inJob ? "true" : "false", host.BasicLimitInformation.LimitFlags,
    host.BasicLimitInformation.LimitFlags & JOB_OBJECT_LIMIT_BREAKAWAY_OK ? "true" : "false",
    host.BasicLimitInformation.LimitFlags & JOB_OBJECT_LIMIT_SILENT_BREAKAWAY_OK ? "true" : "false",
    ui.UIRestrictionsClass, set ? "true" : "false", error, observed.UIRestrictionsClass);
  CloseHandle(job);
  return 0;
}

static TOKEN_USER *current_user(void) {
  HANDLE token;
  checked(OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &token), "identity token");
  DWORD size = 0;
  GetTokenInformation(token, TokenUser, NULL, 0, &size);
  TOKEN_USER *user = calloc(1, size);
  if (!user) fail("identity allocation");
  checked(GetTokenInformation(token, TokenUser, user, size, &size), "identity owner");
  CloseHandle(token);
  return user;
}

/* File identity and ACL come from one no-follow handle. Mode bits are not an
 * ownership boundary on Windows. Unknown ACL forms never attest privacy. */
static BOOL file_privacy(HANDLE file, BOOL *own) {
  PSID owner; PACL dacl; PSECURITY_DESCRIPTOR security;
  DWORD error = GetSecurityInfo(file, SE_FILE_OBJECT, OWNER_SECURITY_INFORMATION | DACL_SECURITY_INFORMATION,
    &owner, NULL, &dacl, NULL, &security);
  if (error != ERROR_SUCCESS) { SetLastError(error); fail("file ownership"); }
  TOKEN_USER *user = current_user();
  *own = owner && EqualSid(owner, user->User.Sid);
  BOOL private = *own && dacl != NULL;
  SECURITY_DESCRIPTOR_CONTROL control; DWORD revision;
  checked(GetSecurityDescriptorControl(security, &control, &revision), "file security control");
  if (!(control & SE_DACL_PROTECTED)) private = FALSE;
  PSID system; checked(ConvertStringSidToSidW(L"S-1-5-18", &system), "system identity");
  BOOL ownerAccess = FALSE;
  if (dacl) for (DWORD i = 0; i < dacl->AceCount; i++) {
    ACE_HEADER *header; checked(GetAce(dacl, i, (void **)&header), "file security entry");
    if (header->AceType != ACCESS_ALLOWED_ACE_TYPE || (header->AceFlags & INHERITED_ACE)) { private = FALSE; continue; }
    ACCESS_ALLOWED_ACE *ace = (ACCESS_ALLOWED_ACE *)header;
    PSID principal = &ace->SidStart;
    if (EqualSid(principal, user->User.Sid)) {
      if ((ace->Mask & FILE_ALL_ACCESS) == FILE_ALL_ACCESS || (ace->Mask & GENERIC_ALL)) ownerAccess = TRUE;
    } else if (!EqualSid(principal, system)) private = FALSE;
  }
  if (!ownerAccess) private = FALSE;
  LocalFree(system); LocalFree(security); free(user);
  return private;
}

static int inspect_file_handle(HANDLE file) {
  BY_HANDLE_FILE_INFORMATION info; FILE_ID_INFO identity;
  checked(GetFileInformationByHandle(file, &info), "file identity attributes");
  checked(GetFileInformationByHandleEx(file, FileIdInfo, &identity, sizeof(identity)), "file identity");
  BOOL own; BOOL private = file_privacy(file, &own);
  printf("{\"protocol\":\"devryan.windows-file-identity/1\",\"volume\":\"%016llx\",\"fileId\":\"", (unsigned long long)identity.VolumeSerialNumber);
  for (DWORD i = 0; i < sizeof(identity.FileId.Identifier); i++) printf("%02x", (unsigned int)identity.FileId.Identifier[i]);
  printf("\",\"type\":\"%s\",\"reparsePoint\":%s,\"linkCount\":%lu,\"currentOwner\":%s,\"privateAcl\":%s}\n",
    info.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY ? "directory" : "file",
    info.dwFileAttributes & FILE_ATTRIBUTE_REPARSE_POINT ? "true" : "false", info.nNumberOfLinks,
    own ? "true" : "false", private ? "true" : "false");
  return 0;
}

static DWORD anchor_parents(const wchar_t *argument, wchar_t *path, HANDLE *ancestors);

static int inspect_path(const wchar_t *argument) {
  wchar_t path[32768]; HANDLE ancestors[256];
  DWORD count = anchor_parents(argument, path, ancestors);
  /* Attribute/security access bypasses sharing restrictions. A read handle
   * must also prove that an exclusive owner has not locked this identity. */
  HANDLE file = CreateFileW(path, GENERIC_READ,
    FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE, NULL, OPEN_EXISTING,
    FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT, NULL);
  if (file == INVALID_HANDLE_VALUE) fail("file identity handle");
  int result = inspect_file_handle(file); CloseHandle(file);
  for (DWORD i = 0; i < count; i++) CloseHandle(ancestors[i]);
  return result;
}

/* Creation is exclusive. Hold every ancestor without write/delete sharing so
 * neither a rename nor a new reparse target can change the anchored path. No
 * existing file/ACL is repaired, and an interrupted new directory is retained. */
static DWORD anchor_parents(const wchar_t *argument, wchar_t *path, HANDLE *ancestors) {
  DWORD size = GetFullPathNameW(argument, 32768, path, NULL);
  if (!size || size >= 32768 || wcslen(path) < 4 || path[1] != L':' || path[2] != L'\\'
    || CompareStringOrdinal(path, -1, argument, -1, TRUE) != CSTR_EQUAL) { SetLastError(ERROR_INVALID_PARAMETER); fail("canonical private path"); }
  wchar_t *separator = wcsrchr(path, L'\\');
  if (!separator || !separator[1]) { SetLastError(ERROR_INVALID_PARAMETER); fail("private basename"); }
  const wchar_t *name = separator + 1; size_t length = wcslen(name);
  if (name[length - 1] == L'.' || name[length - 1] == L' ' || wcschr(name, L':')) {
    SetLastError(ERROR_INVALID_PARAMETER); fail("private name alias");
  }
  size_t stem = wcscspn(name, L".");
  if ((stem == 3 && (!_wcsnicmp(name, L"CON", 3) || !_wcsnicmp(name, L"PRN", 3) || !_wcsnicmp(name, L"AUX", 3) || !_wcsnicmp(name, L"NUL", 3)))
    || (stem == 4 && (!_wcsnicmp(name, L"COM", 3) || !_wcsnicmp(name, L"LPT", 3))
      && ((name[3] >= L'0' && name[3] <= L'9') || name[3] == L'\u00b9' || name[3] == L'\u00b2' || name[3] == L'\u00b3'))
    || !_wcsicmp(name, L"CONIN$") || !_wcsicmp(name, L"CONOUT$")) {
    SetLastError(ERROR_INVALID_PARAMETER); fail("private device alias");
  }
  size_t parentLength = (size_t)(separator - path);
  if (parentLength < 3) parentLength = 3;
  DWORD count = 0;
  for (size_t end = 3; end <= parentLength; end++) {
    if (end != 3 && end != parentLength && path[end] != L'\\') continue;
    if (count == 256) { SetLastError(ERROR_INVALID_PARAMETER); fail("private path depth"); }
    wchar_t saved = path[end]; path[end] = 0;
    HANDLE parent = CreateFileW(path, FILE_READ_ATTRIBUTES | READ_CONTROL, FILE_SHARE_READ, NULL, OPEN_EXISTING,
      FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT, NULL);
    path[end] = saved;
    if (parent == INVALID_HANDLE_VALUE) fail("anchored directory parent");
    BY_HANDLE_FILE_INFORMATION info; checked(GetFileInformationByHandle(parent, &info), "anchored parent attributes");
    if (!(info.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY) || (info.dwFileAttributes & FILE_ATTRIBUTE_REPARSE_POINT)) {
      SetLastError(ERROR_ACCESS_DENIED); fail("anchored parent reparse boundary");
    }
    ancestors[count++] = parent;
  }
  return count;
}

static PSECURITY_DESCRIPTOR private_security(BOOL directory) {
  TOKEN_USER *user = current_user(); LPWSTR owner;
  checked(ConvertSidToStringSidW(user->User.Sid, &owner), "private owner string");
  wchar_t descriptor[1024];
  swprintf(descriptor, 1024, L"O:%sD:P(A;%s;FA;;;%s)(A;%s;FA;;;SY)", owner, directory ? L"OICI" : L"", owner, directory ? L"OICI" : L"");
  PSECURITY_DESCRIPTOR security;
  checked(ConvertStringSecurityDescriptorToSecurityDescriptorW(descriptor, SDDL_REVISION_1, &security, NULL), "private directory security");
  LocalFree(owner); free(user);
  return security;
}

static int create_private_directory(const wchar_t *argument) {
  wchar_t path[32768]; HANDLE ancestors[256];
  DWORD count = anchor_parents(argument, path, ancestors);
  PSECURITY_DESCRIPTOR security = private_security(TRUE);
  SECURITY_ATTRIBUTES attributes = { sizeof(attributes), security, FALSE };
  checked(CreateDirectoryW(path, &attributes), "exclusive private directory");
  int result = inspect_path(path);
  for (DWORD i = 0; i < count; i++) CloseHandle(ancestors[i]);
  LocalFree(security);
  return result;
}

static int create_private_file(const wchar_t *argument) {
  wchar_t path[32768]; HANDLE ancestors[256];
  DWORD count = anchor_parents(argument, path, ancestors);
  PSECURITY_DESCRIPTOR security = private_security(FALSE);
  SECURITY_ATTRIBUTES attributes = { sizeof(attributes), security, FALSE };
  HANDLE file = CreateFileW(path, GENERIC_WRITE | FILE_READ_ATTRIBUTES | READ_CONTROL, FILE_SHARE_READ,
    &attributes, CREATE_NEW, FILE_ATTRIBUTE_NORMAL | FILE_FLAG_OPEN_REPARSE_POINT | FILE_FLAG_WRITE_THROUGH, NULL);
  if (file == INVALID_HANDLE_VALUE) fail("exclusive private file");
  checked(GetFileType(file) == FILE_TYPE_DISK, "private file type");
  BYTE bytes[65536]; DWORD total = 0;
  for (;;) {
    DWORD read;
    if (!ReadFile(GetStdHandle(STD_INPUT_HANDLE), bytes, sizeof(bytes), &read, NULL)) {
      if (GetLastError() == ERROR_BROKEN_PIPE) break;
      fail("private file input");
    }
    if (!read) break;
    if (total > 1048576 - read) { SetLastError(ERROR_FILE_TOO_LARGE); fail("private file input bound"); }
    DWORD written; checked(WriteFile(file, bytes, read, &written, NULL) && written == read, "private file write");
    total += read;
  }
  checked(FlushFileBuffers(file), "private file durability");
  int result = inspect_file_handle(file);
  CloseHandle(file);
  for (DWORD i = 0; i < count; i++) CloseHandle(ancestors[i]);
  LocalFree(security);
  return result;
}

/* A retained kernel byte-range lock proves this exact keeper's lifetime.
 * PID reuse and stale JSON never turn an uncertain owner into a lost one. */
static int owner_lock(const wchar_t *argument, BOOL probe) {
  wchar_t path[32768]; HANDLE ancestors[256];
  DWORD count = anchor_parents(argument, path, ancestors);
  PSECURITY_DESCRIPTOR security = private_security(FALSE);
  SECURITY_ATTRIBUTES attributes = { sizeof(attributes), security, FALSE };
  HANDLE file = CreateFileW(path, GENERIC_READ | GENERIC_WRITE | READ_CONTROL,
    FILE_SHARE_READ | FILE_SHARE_WRITE, &attributes, probe ? OPEN_EXISTING : CREATE_NEW,
    FILE_FLAG_OPEN_REPARSE_POINT | FILE_FLAG_WRITE_THROUGH, NULL);
  if (file == INVALID_HANDLE_VALUE) {
    if (probe && GetLastError() == ERROR_FILE_NOT_FOUND) return 0;
    fail("owner lock file");
  }
  BY_HANDLE_FILE_INFORMATION info; BOOL own;
  checked(GetFileInformationByHandle(file, &info), "owner lock identity");
  if ((info.dwFileAttributes & (FILE_ATTRIBUTE_REPARSE_POINT | FILE_ATTRIBUTE_DIRECTORY))
    || info.nNumberOfLinks != 1 || !file_privacy(file, &own)) {
    SetLastError(ERROR_ACCESS_DENIED); fail("private owner lock");
  }
  OVERLAPPED position = {0};
  if (!LockFileEx(file, LOCKFILE_EXCLUSIVE_LOCK | LOCKFILE_FAIL_IMMEDIATELY, 0, 1, 0, &position)) {
    if (probe && GetLastError() == ERROR_LOCK_VIOLATION) return 73;
    fail("owner lock acquisition");
  }
  if (!probe) {
    checked(FlushFileBuffers(file), "owner lock durability");
    DWORD written;
    checked(WriteFile(GetStdHandle(STD_OUTPUT_HANDLE), "owned\n", 6, &written, NULL) && written == 6, "owner lock acknowledgement");
    BYTE input; DWORD read;
    while (ReadFile(GetStdHandle(STD_INPUT_HANDLE), &input, 1, &read, NULL) && read) {}
  }
  checked(UnlockFileEx(file, 0, 1, 0, &position), "owner lock release");
  CloseHandle(file);
  for (DWORD i = 0; i < count; i++) CloseHandle(ancestors[i]);
  LocalFree(security); return 0;
}

/* Read-only OS identity probe. Never grant, signal or infer exit from a PID.
 * Creation identity and liveness come from the same non-inherited handle. */
static int emit_process_identity(HANDLE process, DWORD pid) {
  FILETIME created, exited, kernel, user;
  checked(GetProcessTimes(process, &created, &exited, &kernel, &user), "process creation identity");
  DWORD state = WaitForSingleObject(process, 0);
  if (state != WAIT_OBJECT_0 && state != WAIT_TIMEOUT) fail("process identity state");
  BOOL inJob;
  checked(IsProcessInJob(process, NULL, &inJob), "containing job identity");
  printf("{\"protocol\":\"devryan.windows-process-identity/1\",\"pid\":%lu,\"startIdentity\":\"win32:%08lx%08lx\",\"active\":%s,\"inJob\":%s}\n",
    pid, created.dwHighDateTime, created.dwLowDateTime, state == WAIT_TIMEOUT ? "true" : "false", inJob ? "true" : "false");
  return 0;
}
static int inspect_process(const wchar_t *argument) {
  if (!*argument) return 125;
  for (const wchar_t *p = argument; *p; p++) if (*p < L'0' || *p > L'9') return 125;
  wchar_t *end; errno = 0;
  unsigned long pid = wcstoul(argument, &end, 10);
  if (errno || *end || !pid) return 125;
  HANDLE process = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION | SYNCHRONIZE, FALSE, (DWORD)pid);
  if (!process) fail("process identity handle");
  int result = emit_process_identity(process, (DWORD)pid); CloseHandle(process); return result;
}
static wchar_t *joined(const wchar_t *left, const wchar_t *right) {
  size_t n = wcslen(left) + wcslen(right) + 2;
  wchar_t *value = calloc(n, sizeof(wchar_t));
  if (!value) fail("allocation");
  swprintf(value, n, L"%s\\%s", left, right); return value;
}

/* Never follow a reparse point while granting access. A hard link in the view
 * would share the source security descriptor, so reject multiply linked files
 * before changing any label or DACL. Views are copied, not hard linked. */
static HANDLE grant_tree(const wchar_t *name, PSECURITY_DESCRIPTOR security, BOOL root) {
  HANDLE file = CreateFileW(name, READ_CONTROL | WRITE_DAC | WRITE_OWNER | FILE_READ_ATTRIBUTES,
    FILE_SHARE_READ, NULL, OPEN_EXISTING,
    FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT, NULL);
  if (file == INVALID_HANDLE_VALUE) fail("private tree handle");
  BY_HANDLE_FILE_INFORMATION info;
  checked(GetFileInformationByHandle(file, &info), "private tree attributes");
  if (info.dwFileAttributes & FILE_ATTRIBUTE_REPARSE_POINT) {
    if (root) { SetLastError(ERROR_ACCESS_DENIED); fail("scope root reparse boundary"); }
    CloseHandle(file); return NULL;
  }
  if (root) {
    BOOL own;
    if (!(info.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY) || !file_privacy(file, &own)) {
      SetLastError(ERROR_ACCESS_DENIED); fail("private scope root");
    }
  }
  if (!(info.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY) && info.nNumberOfLinks > 1) {
    SetLastError(ERROR_ACCESS_DENIED); fail("private tree hard link");
  }
  PSID owner; PSECURITY_DESCRIPTOR observedSecurity;
  DWORD ownerError = GetSecurityInfo(file, SE_FILE_OBJECT, OWNER_SECURITY_INFORMATION,
    &owner, NULL, NULL, NULL, &observedSecurity);
  if (ownerError != ERROR_SUCCESS) { SetLastError(ownerError); fail("scope file owner"); }
  TOKEN_USER *user = current_user();
  if (!owner || !EqualSid(owner, user->User.Sid)) { SetLastError(ERROR_ACCESS_DENIED); fail("current scope owner"); }
  free(user); LocalFree(observedSecurity);
  BOOL present, defaulted; PACL dacl, sacl;
  checked(GetSecurityDescriptorDacl(security, &present, &dacl, &defaulted) && present, "private DACL");
  checked(GetSecurityDescriptorSacl(security, &present, &sacl, &defaulted) && present, "private integrity");
  DWORD error = SetSecurityInfo(file, SE_FILE_OBJECT,
    DACL_SECURITY_INFORMATION | PROTECTED_DACL_SECURITY_INFORMATION | LABEL_SECURITY_INFORMATION,
    NULL, NULL, dacl, sacl);
  if (error != ERROR_SUCCESS) { SetLastError(error); fail("private tree security"); }
  if (!(info.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY)) { CloseHandle(file); return NULL; }
  wchar_t *pattern = joined(name, L"*"); WIN32_FIND_DATAW found;
  HANDLE search = FindFirstFileW(pattern, &found); free(pattern);
  if (search == INVALID_HANDLE_VALUE) {
    if (GetLastError() == ERROR_FILE_NOT_FOUND) {
      if (root) return file;
      CloseHandle(file); return NULL;
    }
    fail("private tree enumeration");
  }
  do {
    if (!wcscmp(found.cFileName, L".") || !wcscmp(found.cFileName, L"..")) continue;
    wchar_t *child = joined(name, found.cFileName); grant_tree(child, security, FALSE); free(child);
  } while (FindNextFileW(search, &found));
  if (GetLastError() != ERROR_NO_MORE_FILES) fail("private tree enumeration");
  FindClose(search);
  if (root) return file;
  CloseHandle(file); return NULL;
}

/* The host's binary policy binds the three granted roots to the exact lease.
 * It is not a list of arbitrary host paths whose ACLs a worker may widen. */
static HANDLE read_execution_policy(const wchar_t *argument, const wchar_t *view,
  const wchar_t *scratch, const wchar_t *cache) {
  wchar_t canonical[32768]; HANDLE ancestors[256];
  DWORD count = anchor_parents(argument, canonical, ancestors);
  HANDLE file = CreateFileW(canonical, GENERIC_READ, FILE_SHARE_READ, NULL,
    OPEN_EXISTING, FILE_FLAG_OPEN_REPARSE_POINT, NULL);
  if (file == INVALID_HANDLE_VALUE) fail("execution policy handle");
  BY_HANDLE_FILE_INFORMATION info; LARGE_INTEGER size = {0};
  checked(GetFileInformationByHandle(file, &info) && GetFileSizeEx(file, &size), "execution policy identity");
  if ((info.dwFileAttributes & (FILE_ATTRIBUTE_DIRECTORY | FILE_ATTRIBUTE_REPARSE_POINT))
    || info.nNumberOfLinks != 1 || size.QuadPart < 8 || size.QuadPart > 65536 || size.QuadPart % 2) {
    SetLastError(ERROR_INVALID_DATA); fail("execution policy bound");
  }
  BOOL own;
  if (!file_privacy(file, &own)) { SetLastError(ERROR_ACCESS_DENIED); fail("private execution policy"); }
  wchar_t *bytes = calloc((size_t)size.QuadPart + sizeof(wchar_t), 1);
  if (!bytes) fail("execution policy allocation");
  DWORD read;
  checked(ReadFile(file, bytes, (DWORD)size.QuadPart, &read, NULL) && read == (DWORD)size.QuadPart, "execution policy read");
  wchar_t *cursor = bytes, *end = bytes + size.QuadPart / 2;
  const wchar_t *expected[] = { L"DevRyan-Windows-LPAC-1", view, scratch, cache };
  for (unsigned int i = 0; i < 4; i++) {
    wchar_t *zero = wmemchr(cursor, 0, (size_t)(end - cursor));
    if (!zero || wcscmp(cursor, expected[i])) { SetLastError(ERROR_INVALID_DATA); fail("execution policy binding"); }
    cursor = zero + 1;
  }
  if (cursor != end) { SetLastError(ERROR_INVALID_DATA); fail("execution policy trailing data"); }
  free(bytes);
  for (DWORD i = 0; i < count; i++) CloseHandle(ancestors[i]);
  return file;
}

static PSECURITY_DESCRIPTOR execution_security(const wchar_t *owner, const wchar_t *container, BOOL writable) {
  wchar_t descriptor[2048];
  /* OWNER RIGHTS suppresses implicit owner WRITE_DAC. The host retains its
   * explicit full grant; the LPAC receives data access without ACL ownership. */
  swprintf(descriptor, 2048,
    L"O:%sD:P(A;OICI;FA;;;%s)(A;OICI;FA;;;SY)(A;OICI;RC;;;OW)(A;OICI;%s;;;%s)S:(ML;OICI;NW;;;LW)",
    owner, owner, writable ? L"0x1301bf" : L"GRGX", container);
  PSECURITY_DESCRIPTOR security;
  checked(ConvertStringSecurityDescriptorToSecurityDescriptorW(descriptor, SDDL_REVISION_1, &security, NULL), "LPAC scope security");
  return security;
}

static PSECURITY_DESCRIPTOR execution_object_security(const wchar_t *owner, const wchar_t *container) {
  wchar_t descriptor[2048];
  /* File-specific access bits are not desktop/process access bits. These
   * objects belong only to this execution; never apply this to a host object. */
  swprintf(descriptor, 2048, L"O:%sD:P(A;;GA;;;%s)(A;;GA;;;SY)(A;;RC;;;OW)(A;;GA;;;%s)S:(ML;;NW;;;LW)", owner, owner, container);
  PSECURITY_DESCRIPTOR security;
  checked(ConvertStringSecurityDescriptorToSecurityDescriptorW(descriptor, SDDL_REVISION_1, &security, NULL), "private object security");
  return security;
}

/* Copy the selected executable from a pinned no-follow handle, never change
 * its installed ACL. The sealed copy lives beside, outside, the writable view
 * and scratch. Children execute the same read-only copy through execPath. */
static wchar_t *stage_execution_runtime(const wchar_t *source, const wchar_t *view,
  PSECURITY_DESCRIPTOR readonlySecurity) {
  wchar_t canonical[32768]; HANDLE ancestors[256];
  DWORD count = anchor_parents(source, canonical, ancestors);
  HANDLE input = CreateFileW(canonical, GENERIC_READ, FILE_SHARE_READ, NULL, OPEN_EXISTING,
    FILE_FLAG_OPEN_REPARSE_POINT, NULL);
  if (input == INVALID_HANDLE_VALUE) fail("runtime input handle");
  BY_HANDLE_FILE_INFORMATION info;
  checked(GetFileInformationByHandle(input, &info), "runtime input identity");
  if (info.dwFileAttributes & (FILE_ATTRIBUTE_DIRECTORY | FILE_ATTRIBUTE_REPARSE_POINT)) {
    SetLastError(ERROR_ACCESS_DENIED); fail("runtime input boundary");
  }
  wchar_t root[32768]; checked(wcslen(view) < 32768, "runtime scope length"); wcscpy(root, view);
  wchar_t *separator = wcsrchr(root, L'\\');
  if (!separator) { SetLastError(ERROR_INVALID_PARAMETER); fail("runtime scope parent"); }
  *separator = 0;
  wchar_t *directory = joined(root, L"runtime");
  PSECURITY_DESCRIPTOR private = private_security(TRUE);
  SECURITY_ATTRIBUTES attributes = { sizeof(attributes), private, FALSE };
  checked(CreateDirectoryW(directory, &attributes), "exclusive runtime scope");
  wchar_t *target = joined(directory, wcsrchr(canonical, L'\\') + 1);
  HANDLE output = CreateFileW(target, GENERIC_WRITE | READ_CONTROL | WRITE_DAC | WRITE_OWNER,
    FILE_SHARE_READ, &attributes, CREATE_NEW, FILE_FLAG_WRITE_THROUGH, NULL);
  if (output == INVALID_HANDLE_VALUE) fail("exclusive runtime copy");
  BYTE buffer[65536]; DWORD read;
  for (;;) {
    checked(ReadFile(input, buffer, sizeof(buffer), &read, NULL), "runtime copy read");
    if (!read) break;
    DWORD written;
    checked(WriteFile(output, buffer, read, &written, NULL) && written == read, "runtime copy write");
  }
  checked(FlushFileBuffers(output), "runtime copy durability"); CloseHandle(output); CloseHandle(input);
  for (DWORD i = 0; i < count; i++) CloseHandle(ancestors[i]);
  HANDLE sealed = grant_tree(directory, readonlySecurity, TRUE);
  CloseHandle(sealed); LocalFree(private); free(directory);
  return target;
}

static SID_AND_ATTRIBUTES *execution_capabilities(DWORD *count) {
  const WELL_KNOWN_SID_TYPE kinds[] = { WinCapabilityInternetClientSid,
    WinCapabilityInternetClientServerSid, WinCapabilityPrivateNetworkClientServerSid };
  *count = 4;
  SID_AND_ATTRIBUTES *result = calloc(*count, sizeof(*result));
  if (!result) fail("network capability allocation");
  for (DWORD i = 0; i < 3; i++) {
    DWORD size = SECURITY_MAX_SID_SIZE;
    result[i].Sid = LocalAlloc(LMEM_FIXED, size);
    if (!result[i].Sid) fail("network capability allocation");
    checked(CreateWellKnownSid(kinds[i], NULL, result[i].Sid, &size), "network capability identity");
    result[i].Attributes = SE_GROUP_ENABLED;
  }
  /* LPAC otherwise cannot read the system registry used by DLL startup.
   * This grants only the OS's registryRead capability, never registry writes
   * or access to files lacking this execution's package SID. */
  PSID *groups = NULL, *sids = NULL; DWORD groupCount = 0, sidCount = 0;
  checked(DeriveCapabilitySidsFromName(L"registryRead", &groups, &groupCount, &sids, &sidCount), "system registry capability");
  for (DWORD i = 0; i < groupCount; i++) LocalFree(groups[i]);
  LocalFree(groups);
  if (sidCount != 1) { SetLastError(ERROR_INVALID_DATA); fail("system registry capability count"); }
  result[3].Sid = sids[0]; result[3].Attributes = SE_GROUP_ENABLED; LocalFree(sids);
  return result;
}

static wchar_t *command_line(int argc, wchar_t **argv, int first) {
  size_t size = 1;
  for (int i = first; i < argc; i++) size += wcslen(argv[i]) * 2 + 4;
  wchar_t *line = calloc(size, sizeof(wchar_t)), *out = line;
  if (!line) fail("command allocation");
  for (int i = first; i < argc; i++) {
    if (i != first) *out++ = L' ';
    *out++ = L'"'; unsigned int slashes = 0;
    for (const wchar_t *p = argv[i]; ; p++) {
      if (*p == L'\\') { slashes++; continue; }
      unsigned int count = slashes * ((*p == L'"' || !*p) ? 2 : 1);
      while (count--) *out++ = L'\\'; slashes = 0;
      if (!*p) break;
      if (*p == L'"') *out++ = L'\\';
      *out++ = *p;
    }
    *out++ = L'"';
  }
  *out = 0; return line;
}

static DWORD parent_id(void) {
  HANDLE snapshot = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
  if (snapshot == INVALID_HANDLE_VALUE) fail("owner snapshot");
  PROCESSENTRY32 entry = { .dwSize = sizeof(entry) }; DWORD parent = 0;
  if (Process32First(snapshot, &entry)) do {
    if (entry.th32ProcessID == GetCurrentProcessId()) { parent = entry.th32ParentProcessID; break; }
  } while (Process32Next(snapshot, &entry));
  CloseHandle(snapshot); if (!parent) fail("execution owner"); return parent;
}

/* A recycled parent PID cannot authorize a new owner. Open the actual process,
 * require creation before this supervisor, and retain that handle until drain. */
static HANDLE parent_process(DWORD *pid) {
  *pid = parent_id();
  HANDLE parent = OpenProcess(SYNCHRONIZE | PROCESS_QUERY_LIMITED_INFORMATION, FALSE, *pid);
  if (!parent) fail("owner handle");
  FILETIME parentCreated, created, exited, kernel, user;
  checked(GetProcessTimes(parent, &parentCreated, &exited, &kernel, &user), "owner creation identity");
  checked(GetProcessTimes(GetCurrentProcess(), &created, &exited, &kernel, &user), "supervisor creation identity");
  if (CompareFileTime(&parentCreated, &created) >= 0 || WaitForSingleObject(parent, 0) != WAIT_TIMEOUT) {
    SetLastError(ERROR_INVALID_PARAMETER); fail("original owner identity");
  }
  return parent;
}

int wmain(int argc, wchar_t **argv) {
  if (argc == 2 && !wcscmp(argv[1], L"--inspect-job-boundary")) return inspect_job_boundary();
  if (argc == 3 && !wcscmp(argv[1], L"--inspect-process")) return inspect_process(argv[2]);
  if (argc == 2 && !wcscmp(argv[1], L"--inspect-parent")) {
    DWORD pid; HANDLE parent = parent_process(&pid);
    int result = emit_process_identity(parent, pid); CloseHandle(parent); return result;
  }
  if (argc == 3 && !wcscmp(argv[1], L"--inspect-path")) return inspect_path(argv[2]);
  if (argc == 3 && !wcscmp(argv[1], L"--create-private-directory")) return create_private_directory(argv[2]);
  if (argc == 3 && !wcscmp(argv[1], L"--create-private-file")) return create_private_file(argv[2]);
  if (argc == 3 && !wcscmp(argv[1], L"--owner-lock")) return owner_lock(argv[2], FALSE);
  if (argc == 3 && !wcscmp(argv[1], L"--owner-probe")) return owner_lock(argv[2], TRUE);
  // The host uses a named cancellation event because TerminateProcess would
  // close the job safely but could not write a termination acknowledgement.
  if (argc == 3 && !wcscmp(argv[1], L"--cancel")) {
    HANDLE event = OpenEventW(EVENT_MODIFY_STATE, FALSE, argv[2]);
    if (!event) fail("cancel event"); checked(SetEvent(event), "cancel signal"); CloseHandle(event); return 0;
  }
  if (argc < 7 || wcscmp(argv[5], L"--")) return 125;
  DWORD uiMask = maximum_ui_limits(os_build());
  HANDLE receipt = CreateFileW(argv[4], GENERIC_WRITE, 0, NULL, CREATE_NEW, FILE_ATTRIBUTE_NORMAL, NULL);
  if (receipt == INVALID_HANDLE_VALUE) fail("exclusive receipt");
  DWORD parentPid; HANDLE parent = parent_process(&parentPid);
  HANDLE token, restricted;
  checked(OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY | TOKEN_DUPLICATE | TOKEN_ASSIGN_PRIMARY | TOKEN_ADJUST_DEFAULT, &token), "host token");
  DWORD length = 0; GetTokenInformation(token, TokenUser, NULL, 0, &length);
  TOKEN_USER *user = calloc(1, length);
  if (!user) fail("user allocation");
  checked(GetTokenInformation(token, TokenUser, user, length, &length), "user identity");
  LUID luid; checked(AllocateLocallyUniqueId(&luid), "scope identity");
  const wchar_t *cache = _wgetenv(L"DEVRYAN_EXECUTION_CACHE");
  if (!cache || !*cache) { SetLastError(ERROR_INVALID_PARAMETER); fail("execution cache identity"); }
  HANDLE policy = read_execution_policy(argv[3], argv[1], argv[2], cache);
  wchar_t profileName[96];
  swprintf(profileName, 96, L"DevRyan-%lu-%lu-%lu", GetCurrentProcessId(), (DWORD)luid.HighPart, luid.LowPart);
  PSID sid; DWORD capabilityCount;
  SID_AND_ATTRIBUTES *capabilities = execution_capabilities(&capabilityCount);
  HRESULT profileResult = CreateAppContainerProfile(profileName, L"DevRyan execution", L"Private execution scope",
    capabilities, capabilityCount, &sid);
  if (FAILED(profileResult)) { SetLastError((DWORD)profileResult); fail("exclusive LPAC profile"); }
  wcscpy(active_profile, profileName);
  checked(CreateRestrictedToken(token, DISABLE_MAX_PRIVILEGE | LUA_TOKEN,
    0, NULL, 0, NULL, 0, NULL, &restricted), "restricted token");
  // Elevated runners otherwise default new files to the Administrators group.
  // Worker-created files must retain the scoped host principal as their owner.
  TOKEN_OWNER childOwner = { user->User.Sid };
  checked(SetTokenInformation(restricted, TokenOwner, &childOwner, sizeof(childOwner)), "child file owner");
  PSID integrity; checked(ConvertStringSidToSidW(L"S-1-16-4096", &integrity), "integrity SID");
  TOKEN_MANDATORY_LABEL label = { { integrity, SE_GROUP_INTEGRITY } };
  checked(SetTokenInformation(restricted, TokenIntegrityLevel, &label, sizeof(label) + GetLengthSid(integrity)), "LPAC integrity");
  LPWSTR sidText, userText;
  checked(ConvertSidToStringSidW(sid, &sidText), "scope string");
  checked(ConvertSidToStringSidW(user->User.Sid, &userText), "owner string");
  PSECURITY_DESCRIPTOR security = execution_security(userText, sidText, TRUE);
  HANDLE roots[3]; DWORD rootCount = 2;
  roots[0] = grant_tree(argv[1], security, TRUE); roots[1] = grant_tree(argv[2], security, TRUE);
  if (wcscmp(cache, argv[2])) roots[rootCount++] = grant_tree(cache, security, TRUE);
  PSECURITY_DESCRIPTOR readonlySecurity = execution_security(userText, sidText, FALSE);
  wchar_t *runtime = stage_execution_runtime(argv[6], argv[1], readonlySecurity);
  LocalFree(readonlySecurity);
  BOOL present, defaulted; PACL dacl;
  PSECURITY_DESCRIPTOR objectSecurity = execution_object_security(userText, sidText);
  checked(GetSecurityDescriptorDacl(objectSecurity, &present, &dacl, &defaulted) && present, "process DACL");
  TOKEN_DEFAULT_DACL defaultDacl = { dacl };
  checked(SetTokenInformation(restricted, TokenDefaultDacl, &defaultDacl, sizeof(defaultDacl)), "child process security");
  wchar_t eventName[192];
  DWORD eventLength = GetEnvironmentVariableW(L"DEVRYAN_EXECUTION_CANCEL_EVENT", eventName, 192);
  if (!eventLength || eventLength >= 192) fail("cancel identity");
  HANDLE cancel = CreateEventW(NULL, TRUE, FALSE, eventName);
  if (!cancel || GetLastError() == ERROR_ALREADY_EXISTS) fail("exclusive cancel event");
  wchar_t desktopName[96]; swprintf(desktopName, 96, L"DevRyan-%lu-%lu", (DWORD)luid.HighPart, luid.LowPart);
  SECURITY_ATTRIBUTES desktopSecurity = { sizeof(desktopSecurity), objectSecurity, FALSE };
  HDESK desktop = CreateDesktopW(desktopName, NULL, NULL, 0, GENERIC_ALL, &desktopSecurity);
  if (!desktop) fail("private desktop");
  HANDLE job = CreateJobObjectW(NULL, NULL);
  if (!job) fail("process job");
  active_job = job;
  JOBOBJECT_EXTENDED_LIMIT_INFORMATION limits = {0};
  limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE | JOB_OBJECT_LIMIT_DIE_ON_UNHANDLED_EXCEPTION;
  checked(SetInformationJobObject(job, JobObjectExtendedLimitInformation, &limits, sizeof(limits)), "job ownership");
  JOBOBJECT_BASIC_UI_RESTRICTIONS ui = { uiMask }, observedUI = {0};
  checked(SetInformationJobObject(job, JobObjectBasicUIRestrictions, &ui, sizeof(ui)), "job UI boundary");
  checked(QueryInformationJobObject(job, JobObjectBasicUIRestrictions, &observedUI, sizeof(observedUI), NULL), "job UI readback");
  if (observedUI.UIRestrictionsClass != uiMask) { SetLastError(ERROR_ACCESS_DENIED); fail("exact job UI boundary"); }
  STARTUPINFOEXW startup = {0}; startup.StartupInfo.cb = sizeof(startup); startup.StartupInfo.lpDesktop = desktopName;
  startup.StartupInfo.dwFlags = STARTF_USESTDHANDLES;
  HANDLE handles[3]; DWORD kinds[] = { STD_INPUT_HANDLE, STD_OUTPUT_HANDLE, STD_ERROR_HANDLE };
  for (unsigned int i = 0; i < 3; i++) {
    checked(DuplicateHandle(GetCurrentProcess(), GetStdHandle(kinds[i]), GetCurrentProcess(), &handles[i], 0, TRUE, DUPLICATE_SAME_ACCESS), "pipe handle");
  }
  startup.StartupInfo.hStdInput = handles[0]; startup.StartupInfo.hStdOutput = handles[1]; startup.StartupInfo.hStdError = handles[2];
  SIZE_T bytes = 0; InitializeProcThreadAttributeList(NULL, 4, 0, &bytes);
  startup.lpAttributeList = malloc(bytes); if (!startup.lpAttributeList) fail("handle list allocation");
  checked(InitializeProcThreadAttributeList(startup.lpAttributeList, 4, 0, &bytes), "process attributes");
  checked(UpdateProcThreadAttribute(startup.lpAttributeList, 0, PROC_THREAD_ATTRIBUTE_HANDLE_LIST,
    handles, sizeof(handles), NULL, NULL), "inherited handle boundary");
  // The kernel assigns the child while creating it. A suspended process
  // followed by AssignProcessToJobObject leaves an escape window on host death.
  checked(UpdateProcThreadAttribute(startup.lpAttributeList, 0, PROC_THREAD_ATTRIBUTE_JOB_LIST,
    &job, sizeof(job), NULL, NULL), "atomic command ownership");
  SECURITY_CAPABILITIES app = { sid, capabilities, capabilityCount, 0 };
  checked(UpdateProcThreadAttribute(startup.lpAttributeList, 0, PROC_THREAD_ATTRIBUTE_SECURITY_CAPABILITIES,
    &app, sizeof(app), NULL, NULL), "LPAC command identity");
  DWORD packagePolicy = PROCESS_CREATION_ALL_APPLICATION_PACKAGES_OPT_OUT;
  checked(UpdateProcThreadAttribute(startup.lpAttributeList, 0, PROC_THREAD_ATTRIBUTE_ALL_APPLICATION_PACKAGES_POLICY,
    &packagePolicy, sizeof(packagePolicy), NULL, NULL), "LPAC ambient access refusal");
  wchar_t cwd[32768]; DWORD cwdLength = GetEnvironmentVariableW(L"DEVRYAN_EXECUTION_CWD", cwd, 32768);
  if (!cwdLength || cwdLength >= 32768) wcscpy(cwd, argv[1]);
  wchar_t *originalRuntime = argv[6]; argv[6] = runtime;
  wchar_t *command = command_line(argc, argv, 6); argv[6] = originalRuntime;
  PROCESS_INFORMATION process = {0};
  checked(CreateProcessAsUserW(restricted, NULL, command, NULL, NULL, TRUE,
    CREATE_SUSPENDED | CREATE_NO_WINDOW | EXTENDED_STARTUPINFO_PRESENT, NULL, cwd, &startup.StartupInfo, &process), "confined command");
  checked(ResumeThread(process.hThread) != (DWORD)-1, "command start");
  for (unsigned int i = 0; i < 3; i++) CloseHandle(handles[i]);
  HANDLE wait[] = { process.hProcess, cancel, parent };
  DWORD reason = WaitForMultipleObjects(3, wait, FALSE, INFINITE), code = 125;
  BOOL cancelled = reason != WAIT_OBJECT_0;
  if (!cancelled) checked(GetExitCodeProcess(process.hProcess, &code), "command result");
  checked(TerminateJobObject(job, cancelled ? 130 : code), "stop descendants");
  for (;;) {
    JOBOBJECT_BASIC_ACCOUNTING_INFORMATION state;
    checked(QueryInformationJobObject(job, JobObjectBasicAccountingInformation, &state, sizeof(state), NULL), "termination acknowledgement");
    if (!state.ActiveProcesses) break;
    Sleep(10);
  }
  if (cancelled) code = 130;
  CloseHandle(process.hThread); CloseHandle(process.hProcess); CloseHandle(job); active_job = NULL;
  HRESULT removedProfile = DeleteAppContainerProfile(profileName);
  if (FAILED(removedProfile)) { SetLastError((DWORD)removedProfile); fail("LPAC profile settlement"); }
  *active_profile = 0;
  char result[160]; int count = snprintf(result, sizeof(result), "{\"terminated\":true,\"confined\":true,\"cancelled\":%s,\"exitCode\":%lu}\n", cancelled ? "true" : "false", code);
  DWORD written; checked(WriteFile(receipt, result, count, &written, NULL) && written == (DWORD)count && FlushFileBuffers(receipt), "durable receipt");
  CloseHandle(receipt);
  for (DWORD i = 0; i < rootCount; i++) CloseHandle(roots[i]);
  CloseHandle(cancel); CloseHandle(parent); CloseDesktop(desktop); CloseHandle(restricted); CloseHandle(token);
  DeleteProcThreadAttributeList(startup.lpAttributeList); free(startup.lpAttributeList); free(command); free(user);
  CloseHandle(policy); free(runtime);
  for (DWORD i = 0; i < capabilityCount; i++) LocalFree(capabilities[i].Sid);
  free(capabilities);
  LocalFree(objectSecurity); LocalFree(security); LocalFree(sidText); LocalFree(userText); LocalFree(integrity); FreeSid(sid);
  return (int)code;
}
