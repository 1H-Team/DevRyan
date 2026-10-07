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
#include <wincrypt.h>
#include <tlhelp32.h>
#include <winver.h>
#include <stdio.h>
#include <stdlib.h>
#include <wchar.h>
#include <errno.h>
#include <string.h>
#include <stddef.h>

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
static BOOL private_object_privacy(HANDLE file, BOOL *own, BOOL inherited, SE_OBJECT_TYPE objectType) {
  PSID owner; PACL dacl; PSECURITY_DESCRIPTOR security;
  DWORD error = GetSecurityInfo(file, objectType, OWNER_SECURITY_INFORMATION | DACL_SECURITY_INFORMATION,
    &owner, NULL, &dacl, NULL, &security);
  if (error != ERROR_SUCCESS) { SetLastError(error); fail("file ownership"); }
  TOKEN_USER *user = current_user();
  *own = owner && EqualSid(owner, user->User.Sid);
  BOOL private = *own && dacl != NULL;
  SECURITY_DESCRIPTOR_CONTROL control; DWORD revision;
  checked(GetSecurityDescriptorControl(security, &control, &revision), "file security control");
  if (!inherited && !(control & SE_DACL_PROTECTED)) private = FALSE;
  PSID system; checked(ConvertStringSidToSidW(L"S-1-5-18", &system), "system identity");
  BOOL ownerAccess = FALSE;
  if (dacl) for (DWORD i = 0; i < dacl->AceCount; i++) {
    ACE_HEADER *header; checked(GetAce(dacl, i, (void **)&header), "file security entry");
    if (header->AceType != ACCESS_ALLOWED_ACE_TYPE || (!inherited && (header->AceFlags & INHERITED_ACE))) { private = FALSE; continue; }
    ACCESS_ALLOWED_ACE *ace = (ACCESS_ALLOWED_ACE *)header;
    PSID principal = &ace->SidStart;
    if (EqualSid(principal, user->User.Sid)) {
      DWORD required = objectType == SE_KERNEL_OBJECT ? MUTEX_ALL_ACCESS : FILE_ALL_ACCESS;
      if ((ace->Mask & required) == required || (ace->Mask & GENERIC_ALL)) ownerAccess = TRUE;
    } else if (!EqualSid(principal, system)) private = FALSE;
  }
  if (!ownerAccess) private = FALSE;
  LocalFree(system); LocalFree(security); free(user);
  return private;
}
static BOOL file_privacy_mode(HANDLE file, BOOL *own, BOOL inherited) { return private_object_privacy(file, own, inherited, SE_FILE_OBJECT); }
static BOOL file_privacy(HANDLE file, BOOL *own) { return file_privacy_mode(file, own, FALSE); }

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
static DWORD anchor_parents_access(const wchar_t *argument, wchar_t *path, HANDLE *ancestors, DWORD access);

static BOOL same_file(HANDLE left, HANDLE right) {
  FILE_ID_INFO a = {0}, b = {0};
  checked(GetFileInformationByHandleEx(left, FileIdInfo, &a, sizeof(a))
    && GetFileInformationByHandleEx(right, FileIdInfo, &b, sizeof(b)), "execution path identity");
  return a.VolumeSerialNumber == b.VolumeSerialNumber && !memcmp(a.FileId.Identifier, b.FileId.Identifier, sizeof(a.FileId.Identifier));
}

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
  return anchor_parents_access(argument, path, ancestors, 0);
}

static DWORD anchor_parents_sharing(const wchar_t *argument, wchar_t *path, HANDLE *ancestors, DWORD access, DWORD sharing) {
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
    HANDLE parent = CreateFileW(path, FILE_READ_ATTRIBUTES | READ_CONTROL | (end == parentLength ? access : 0), sharing, NULL, OPEN_EXISTING,
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
static DWORD anchor_parents_access(const wchar_t *argument, wchar_t *path, HANDLE *ancestors, DWORD access) {
  return anchor_parents_sharing(argument,path,ancestors,access,FILE_SHARE_READ);
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

static HANDLE private_namespace_mutex;
/* ponytail: SDK subtree CAS serializes namespace mutations for one user;
 * contention is bounded by 120 seconds. Measure before replacing this ceiling
 * with ordered per-tree locks. Per-parent publication locks remain the default
 * ownership guard, and are acquired only after this coordination mutex. */
static void release_private_namespace_mutex(void) {
  if (!private_namespace_mutex) return;
  ReleaseMutex(private_namespace_mutex); CloseHandle(private_namespace_mutex); private_namespace_mutex = NULL;
}
static void acquire_private_namespace_mutex(void) {
  TOKEN_USER *user = current_user(); LPWSTR sid;
  checked(ConvertSidToStringSidW(user->User.Sid, &sid), "private namespace mutex user");
  wchar_t name[256]; int length = swprintf(name, 256, L"Global\\DevRyan-private-namespace-%ls", sid);
  if (length <= 0 || length >= 256) { SetLastError(ERROR_INVALID_PARAMETER); fail("private namespace mutex name"); }
  PSECURITY_DESCRIPTOR security = private_security(FALSE); SECURITY_ATTRIBUTES attributes = { sizeof(attributes), security, FALSE };
  HANDLE mutex = CreateMutexW(&attributes, FALSE, name); DWORD error = GetLastError();
  LocalFree(security); LocalFree(sid); free(user);
  if (!mutex) { SetLastError(error); fail("private namespace mutex handle"); }
  BOOL own;
  if (!private_object_privacy(mutex, &own, FALSE, SE_KERNEL_OBJECT)) { SetLastError(ERROR_ACCESS_DENIED); fail("private namespace mutex identity"); }
  DWORD waited = WaitForSingleObject(mutex, 120000);
  if (waited != WAIT_OBJECT_0 && waited != WAIT_ABANDONED) { SetLastError(ERROR_TIMEOUT); fail("private namespace mutex acquisition"); }
  /* Abandonment conveys only the mutex. Every operation still validates the
   * physical parent/intent/file IDs; it cannot infer prior mutation success. */
  private_namespace_mutex = mutex;
  if (atexit(release_private_namespace_mutex)) { SetLastError(ERROR_NOT_ENOUGH_MEMORY); fail("private namespace mutex cleanup"); }
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

/* Fixed names inside the held parent unify case and 8.3 spellings. One parent
 * serializes all private publication and recovery operations. */
static wchar_t *publication_path(const wchar_t *target, const wchar_t *name) {
  const wchar_t *separator = wcsrchr(target, L'\\');
  if (!separator) { SetLastError(ERROR_INVALID_PARAMETER); fail("publication parent"); }
  size_t parentLength = (size_t)(separator - target) + 1;
  size_t length = parentLength + wcslen(name) + 1;
  if (length > 32768) { SetLastError(ERROR_FILENAME_EXCED_RANGE); fail("publication path bound"); }
  wchar_t *path = calloc(length, sizeof(wchar_t));
  if (!path) fail("publication path allocation");
  wmemcpy(path, target, parentLength); wcscpy(path + parentLength, name); return path;
}

static void require_private_file(HANDLE file) {
  BY_HANDLE_FILE_INFORMATION info; BOOL own;
  checked(GetFileInformationByHandle(file, &info), "publication file identity");
  if ((info.dwFileAttributes & (FILE_ATTRIBUTE_REPARSE_POINT | FILE_ATTRIBUTE_DIRECTORY))
    || info.nNumberOfLinks != 1 || !file_privacy(file, &own)) {
    SetLastError(ERROR_ACCESS_DENIED); fail("private publication file");
  }
}

/* Readers share this retained guard; publication takes it exclusively.
 * Neither a disappearing target nor stale bytes can bypass an active intent. */
static HANDLE publication_guard(const wchar_t *target, HANDLE parent, BOOL exclusive) {
  BOOL own;
  if (!file_privacy(parent, &own)) { SetLastError(ERROR_ACCESS_DENIED); fail("private publication parent"); }
  wchar_t *name = publication_path(target, L".DevRyan-publication.lock");
  PSECURITY_DESCRIPTOR security = private_security(FALSE);
  SECURITY_ATTRIBUTES attributes = { sizeof(attributes), security, FALSE };
  HANDLE file = CreateFileW(name, GENERIC_READ | GENERIC_WRITE | READ_CONTROL,
    FILE_SHARE_READ | FILE_SHARE_WRITE, &attributes, OPEN_ALWAYS,
    FILE_FLAG_OPEN_REPARSE_POINT | FILE_FLAG_WRITE_THROUGH, NULL);
  if (file == INVALID_HANDLE_VALUE) fail("publication guard handle");
  free(name); LocalFree(security); require_private_file(file);
  OVERLAPPED position = {0};
  checked(LockFileEx(file, LOCKFILE_FAIL_IMMEDIATELY | (exclusive ? LOCKFILE_EXCLUSIVE_LOCK : 0),
    0, 1, 0, &position), "publication guard acquisition");
  checked(FlushFileBuffers(file), "publication guard durability");
  return file;
}

/* One bounded intent per held private parent. Completed intents remain in
 * place: an uncertain namespace sync must not erase its own recovery record.
 * Historical receipts/backups are pruned only by their retained native IDs;
 * the current intent's receipt and recovery backup are never pruned. */
typedef struct {
  BYTE magic[16]; DWORD phase, oldPresent;
  FILE_ID_INFO parent, old, staged;
  ULONGLONG oldSize, stagedSize;
  BYTE oldHash[32], stagedHash[32];
  wchar_t target[256], nonce[33];
  BYTE checksum[32];
} publication_intent;
static const BYTE publication_magic[16] = "DevRyan-pub-v1";

static void hash_bytes(const BYTE *bytes, DWORD size, BYTE *digest) {
  HCRYPTPROV provider; HCRYPTHASH hash;
  checked(CryptAcquireContextW(&provider, NULL, NULL, PROV_RSA_AES, CRYPT_VERIFYCONTEXT), "publication hash provider");
  checked(CryptCreateHash(provider, CALG_SHA_256, 0, 0, &hash), "publication hash");
  checked(CryptHashData(hash, bytes, size, 0), "publication hash bytes");
  DWORD length = 32; checked(CryptGetHashParam(hash, HP_HASHVAL, digest, &length, 0) && length == 32, "publication hash result");
  CryptDestroyHash(hash); CryptReleaseContext(provider, 0);
}

static void hash_file_bound(HANDLE file, ULONGLONG *size, BYTE *digest, ULONGLONG maximum) {
  require_private_file(file); LARGE_INTEGER length, start = {0};
  checked(GetFileSizeEx(file, &length), "publication hash size");
  if (length.QuadPart < 0 || (ULONGLONG)length.QuadPart > maximum) { SetLastError(ERROR_FILE_TOO_LARGE); fail("publication size bound"); }
  checked(SetFilePointerEx(file, start, NULL, FILE_BEGIN), "publication hash position");
  HCRYPTPROV provider; HCRYPTHASH hash;
  checked(CryptAcquireContextW(&provider, NULL, NULL, PROV_RSA_AES, CRYPT_VERIFYCONTEXT), "publication hash provider");
  checked(CryptCreateHash(provider, CALG_SHA_256, 0, 0, &hash), "publication file hash");
  BYTE bytes[65536]; DWORD read; ULONGLONG total = 0;
  for (;;) {
    checked(ReadFile(file, bytes, sizeof(bytes), &read, NULL), "publication hash read");
    if (!read) break;
    total += read;
    if (total > (ULONGLONG)length.QuadPart) { SetLastError(ERROR_INVALID_DATA); fail("publication hash changed"); }
    checked(CryptHashData(hash, bytes, read, 0), "publication file hash bytes");
  }
  if (total != (ULONGLONG)length.QuadPart) { SetLastError(ERROR_INVALID_DATA); fail("publication hash truncated"); }
  DWORD returned = 32; checked(CryptGetHashParam(hash, HP_HASHVAL, digest, &returned, 0) && returned == 32, "publication file digest");
  CryptDestroyHash(hash); CryptReleaseContext(provider, 0); *size = total;
}
static void hash_file(HANDLE file, ULONGLONG *size, BYTE *digest) { hash_file_bound(file, size, digest, 64 * 1024 * 1024); }

static BOOL identity_equal(const FILE_ID_INFO *left, const FILE_ID_INFO *right) {
  return left->VolumeSerialNumber == right->VolumeSerialNumber
    && !memcmp(left->FileId.Identifier, right->FileId.Identifier, sizeof(left->FileId.Identifier));
}

static HANDLE open_publication_file(const wchar_t *path, DWORD disposition, DWORD access) {
  PSECURITY_DESCRIPTOR security = private_security(FALSE);
  SECURITY_ATTRIBUTES attributes = { sizeof(attributes), security, FALSE };
  HANDLE file = CreateFileW(path, GENERIC_READ | READ_CONTROL | access, FILE_SHARE_READ,
    &attributes, disposition, FILE_FLAG_OPEN_REPARSE_POINT | FILE_FLAG_WRITE_THROUGH, NULL);
  DWORD error = GetLastError(); LocalFree(security);
  if (file == INVALID_HANDLE_VALUE && disposition == OPEN_EXISTING && error == ERROR_FILE_NOT_FOUND) return NULL;
  if (file == INVALID_HANDLE_VALUE) { SetLastError(error); fail("private publication handle"); }
  require_private_file(file); return file;
}

static void validate_intent(const publication_intent *intent, HANDLE parent) {
  BYTE digest[32]; hash_bytes((const BYTE *)intent, (DWORD)offsetof(publication_intent, checksum), digest);
  FILE_ID_INFO identity; checked(GetFileInformationByHandleEx(parent, FileIdInfo, &identity, sizeof(identity)), "publication parent identity");
  if (memcmp(intent->magic, publication_magic, sizeof(publication_magic)) || memcmp(digest, intent->checksum, sizeof(digest))
    || !identity_equal(&identity, &intent->parent) || intent->phase < 1 || intent->phase > 4 || intent->oldPresent > 1
    || !intent->target[0] || !wmemchr(intent->target, 0, 256) || wcspbrk(intent->target, L"\\/:")
    || intent->nonce[32] || wcslen(intent->nonce) != 32 || intent->oldSize > 64 * 1024 * 1024 || intent->stagedSize > 64 * 1024 * 1024
    || (intent->phase <= 2 && intent->staged.VolumeSerialNumber != intent->parent.VolumeSerialNumber)
    || (intent->phase >= 3 && (intent->staged.VolumeSerialNumber || intent->stagedSize))
    || intent->oldPresent && intent->old.VolumeSerialNumber != intent->parent.VolumeSerialNumber) {
    SetLastError(ERROR_INVALID_DATA); fail("publication intent binding");
  }
  if (intent->phase >= 3) {
    BYTE zeroId[16] = {0}, zeroHash[32] = {0};
    if (memcmp(intent->staged.FileId.Identifier, zeroId, sizeof(zeroId)) || memcmp(intent->stagedHash, zeroHash, sizeof(zeroHash))) {
      SetLastError(ERROR_INVALID_DATA); fail("deletion intent staged binding");
    }
  }
  for (DWORD i = 0; i < 32; i++) if (!((intent->nonce[i] >= L'0' && intent->nonce[i] <= L'9') || (intent->nonce[i] >= L'a' && intent->nonce[i] <= L'f'))) {
    SetLastError(ERROR_INVALID_DATA); fail("publication intent nonce");
  }
}

static BOOL read_intent(HANDLE file, HANDLE parent, publication_intent *intent) {
  if (!file) return FALSE;
  require_private_file(file); LARGE_INTEGER length, start = {0}; DWORD read;
  checked(GetFileSizeEx(file, &length) && length.QuadPart == sizeof(*intent)
    && SetFilePointerEx(file, start, NULL, FILE_BEGIN)
    && ReadFile(file, intent, sizeof(*intent), &read, NULL) && read == sizeof(*intent), "bounded publication intent");
  validate_intent(intent, parent); return TRUE;
}

static void write_intent(HANDLE file, publication_intent *intent) {
  hash_bytes((const BYTE *)intent, (DWORD)offsetof(publication_intent, checksum), intent->checksum);
  LARGE_INTEGER start = {0}; DWORD written;
  checked(SetFilePointerEx(file, start, NULL, FILE_BEGIN)
    && WriteFile(file, intent, sizeof(*intent), &written, NULL) && written == sizeof(*intent)
    && SetEndOfFile(file) && FlushFileBuffers(file), "durable bounded publication intent");
}

static void verify_publication_file(HANDLE file, const FILE_ID_INFO *expected, ULONGLONG size, const BYTE *digest) {
  if (!file) { SetLastError(ERROR_FILE_NOT_FOUND); fail("publication expected file"); }
  FILE_ID_INFO identity; checked(GetFileInformationByHandleEx(file, FileIdInfo, &identity, sizeof(identity)), "publication retained identity");
  ULONGLONG actualSize; BYTE actualHash[32]; hash_file(file, &actualSize, actualHash);
  if (!identity_equal(&identity, expected) || actualSize != size || memcmp(actualHash, digest, sizeof(actualHash))) {
    SetLastError(ERROR_INVALID_DATA); fail("publication expected identity");
  }
}

static wchar_t *publication_nonce_path(const wchar_t *target, const wchar_t *nonce, const wchar_t *suffix) {
  wchar_t name[96]; swprintf(name, 96, L".DevRyan-publication-%s.%s", nonce, suffix); return publication_path(target, name);
}

static HANDLE require_settled_intent(const wchar_t *target, HANDLE parent, const publication_intent *intent) {
  if (intent->phase != 2 && intent->phase != 4) { SetLastError(ERROR_IO_PENDING); fail("private publication unsettled"); }
  wchar_t *published = publication_path(target, intent->target), *receiptPath = publication_nonce_path(target, intent->nonce, L"receipt");
  HANDLE file = open_publication_file(published, OPEN_EXISTING, FALSE), receipt = open_publication_file(receiptPath, OPEN_EXISTING, FALSE);
  if (intent->phase == 2) verify_publication_file(file, &intent->staged, intent->stagedSize, intent->stagedHash);
  else {
    if (file) { SetLastError(ERROR_INVALID_DATA); fail("deletion settlement target exists"); }
    wchar_t *backupPath = publication_nonce_path(target, intent->nonce, L"backup");
    file = open_publication_file(backupPath, OPEN_EXISTING, 0); free(backupPath);
    if (intent->oldPresent) verify_publication_file(file, &intent->old, intent->oldSize, intent->oldHash);
    else if (file) { SetLastError(ERROR_INVALID_DATA); fail("deletion unexpected backup"); }
  }
  publication_intent accepted = {0};
  if (!read_intent(receipt, parent, &accepted) || memcmp(&accepted, intent, sizeof(accepted))) {
    SetLastError(ERROR_INVALID_DATA); fail("publication settlement receipt");
  }
  CloseHandle(receipt); free(published); free(receiptPath); return file;
}

static HANDLE require_no_publication(const wchar_t *target, HANDLE parent) {
  wchar_t *name = publication_path(target, L".DevRyan-publication.intent");
  HANDLE file = open_publication_file(name, OPEN_EXISTING, FALSE); publication_intent intent = {0};
  HANDLE published = read_intent(file, parent, &intent) ? require_settled_intent(target, parent, &intent) : NULL;
  if (file) CloseHandle(file); free(name);
  return published;
}

static void rename_publication_file(HANDLE file, HANDLE parent, const wchar_t *name) {
  DWORD length = (DWORD)(wcslen(name) * sizeof(wchar_t));
  DWORD size = (DWORD)offsetof(FILE_RENAME_INFO, FileName) + length;
  FILE_RENAME_INFO *rename = calloc(1, size); if (!rename) fail("publication rename allocation");
  rename->RootDirectory = parent; rename->FileNameLength = length; memcpy(rename->FileName, name, length);
  checked(SetFileInformationByHandle(file, FileRenameInfo, rename, size), "identity held exclusive publication rename");
  free(rename); checked(FlushFileBuffers(parent), "publication namespace durability");
}

static void finish_publication(const wchar_t *target, HANDLE parent, HANDLE intentFile, publication_intent *intent) {
  wchar_t *candidatePath = publication_nonce_path(target, intent->nonce, L"candidate"), *backupPath = publication_nonce_path(target, intent->nonce, L"backup");
  HANDLE candidate = open_publication_file(candidatePath, OPEN_EXISTING, DELETE), backup = open_publication_file(backupPath, OPEN_EXISTING, DELETE);
  HANDLE named = open_publication_file(target, OPEN_EXISTING, DELETE); FILE_ID_INFO identity = {0};
  if (named) checked(GetFileInformationByHandleEx(named, FileIdInfo, &identity, sizeof(identity)), "publication current identity");
  if (named && identity_equal(&identity, &intent->staged)) {
    if (candidate || intent->oldPresent != (DWORD)(backup != NULL)) { SetLastError(ERROR_INVALID_DATA); fail("publication completed namespace"); }
    verify_publication_file(named, &intent->staged, intent->stagedSize, intent->stagedHash);
  } else {
    verify_publication_file(candidate, &intent->staged, intent->stagedSize, intent->stagedHash);
    if (named) {
      if (!intent->oldPresent || backup) { SetLastError(ERROR_INVALID_DATA); fail("publication old namespace"); }
      verify_publication_file(named, &intent->old, intent->oldSize, intent->oldHash);
      rename_publication_file(named, parent, wcsrchr(backupPath, L'\\') + 1); backup = named; named = NULL;
    } else if (intent->oldPresent != (DWORD)(backup != NULL)) { SetLastError(ERROR_INVALID_DATA); fail("publication missing old identity"); }
    if (backup) verify_publication_file(backup, &intent->old, intent->oldSize, intent->oldHash);
    rename_publication_file(candidate, parent, intent->target); named = candidate; candidate = NULL;
  }
  if (backup) verify_publication_file(backup, &intent->old, intent->oldSize, intent->oldHash);
  wchar_t *receiptPath = publication_nonce_path(target, intent->nonce, L"receipt");
  HANDLE receipt = open_publication_file(receiptPath, OPEN_EXISTING, FALSE); publication_intent completed = *intent; completed.phase = 2;
  hash_bytes((const BYTE *)&completed, (DWORD)offsetof(publication_intent, checksum), completed.checksum);
  if (receipt) {
    publication_intent previous = {0};
    if (!read_intent(receipt, parent, &previous) || memcmp(&previous, &completed, sizeof(previous))) { SetLastError(ERROR_INVALID_DATA); fail("publication receipt replacement"); }
  } else {
    receipt = open_publication_file(receiptPath, CREATE_NEW, GENERIC_WRITE); write_intent(receipt, &completed);
  }
  checked(FlushFileBuffers(parent), "publication receipt namespace durability");
  write_intent(intentFile, &completed); checked(FlushFileBuffers(parent), "publication commit namespace durability"); *intent = completed;
  CloseHandle(receipt); CloseHandle(named); if (backup) CloseHandle(backup); if (candidate) CloseHandle(candidate);
  free(candidatePath); free(backupPath); free(receiptPath);
}

static void emit_publication(const publication_intent *intent) {
  if (intent->phase == 4) {
    printf("{\"protocol\":\"devryan.windows-private-deletion/1\",\"status\":\"deleted\",\"nonce\":\"%ls\",\"parentVolume\":\"%016llx\",\"parentFileId\":\"", intent->nonce, (unsigned long long)intent->parent.VolumeSerialNumber);
    for (DWORD i = 0; i < 16; i++) printf("%02x", (unsigned int)intent->parent.FileId.Identifier[i]);
    printf("\",\"oldToken\":");
    if (!intent->oldPresent) printf("null");
    else {
      printf("\"%016llx:", (unsigned long long)intent->old.VolumeSerialNumber);
      for (DWORD i = 0; i < 16; i++) printf("%02x", (unsigned int)intent->old.FileId.Identifier[i]);
      printf(":"); for (DWORD i = 0; i < 32; i++) printf("%02x", (unsigned int)intent->oldHash[i]);
      printf(":%llu\"", (unsigned long long)intent->oldSize);
    }
    printf(",\"namespaceFlushed\":true}\n"); return;
  }
  printf("{\"protocol\":\"devryan.windows-private-publication/1\",\"status\":\"published\",\"nonce\":\"%ls\",\"parentVolume\":\"%016llx\",\"parentFileId\":\"", intent->nonce, (unsigned long long)intent->parent.VolumeSerialNumber);
  for (DWORD i = 0; i < 16; i++) printf("%02x", (unsigned int)intent->parent.FileId.Identifier[i]);
  printf("\",\"volume\":\"%016llx\",\"fileId\":\"", (unsigned long long)intent->staged.VolumeSerialNumber);
  for (DWORD i = 0; i < 16; i++) printf("%02x", (unsigned int)intent->staged.FileId.Identifier[i]);
  printf("\",\"size\":%llu,\"sha256\":\"", (unsigned long long)intent->stagedSize);
  for (DWORD i = 0; i < 32; i++) printf("%02x", (unsigned int)intent->stagedHash[i]);
  printf("\",\"namespaceFlushed\":true}\n");
}

static void finish_deletion(const wchar_t *target, HANDLE parent, HANDLE intentFile, publication_intent *intent) {
  wchar_t *backupPath = publication_nonce_path(target, intent->nonce, L"backup");
  HANDLE named = open_publication_file(target, OPEN_EXISTING, DELETE), backup = open_publication_file(backupPath, OPEN_EXISTING, DELETE);
  if (named) {
    if (!intent->oldPresent || backup) { SetLastError(ERROR_INVALID_DATA); fail("deletion old namespace"); }
    verify_publication_file(named, &intent->old, intent->oldSize, intent->oldHash);
    rename_publication_file(named, parent, wcsrchr(backupPath, L'\\') + 1); backup = named; named = NULL;
  } else if (intent->oldPresent != (DWORD)(backup != NULL)) { SetLastError(ERROR_INVALID_DATA); fail("deletion missing old identity"); }
  if (backup) verify_publication_file(backup, &intent->old, intent->oldSize, intent->oldHash);
  wchar_t *receiptPath = publication_nonce_path(target, intent->nonce, L"receipt");
  HANDLE receipt = open_publication_file(receiptPath, OPEN_EXISTING, 0); publication_intent completed = *intent; completed.phase = 4;
  hash_bytes((const BYTE *)&completed, (DWORD)offsetof(publication_intent, checksum), completed.checksum);
  if (receipt) {
    publication_intent previous = {0};
    if (!read_intent(receipt, parent, &previous) || memcmp(&previous, &completed, sizeof(previous))) { SetLastError(ERROR_INVALID_DATA); fail("deletion receipt replacement"); }
  } else {
    receipt = open_publication_file(receiptPath, CREATE_NEW, GENERIC_WRITE); write_intent(receipt, &completed);
  }
  checked(FlushFileBuffers(parent), "deletion receipt namespace durability");
  write_intent(intentFile, &completed); checked(FlushFileBuffers(parent), "deletion commit namespace durability"); *intent = completed;
  CloseHandle(receipt); if (backup) CloseHandle(backup); free(backupPath); free(receiptPath);
}

typedef struct { wchar_t nonce[33]; FILE_ID_INFO receipt; ULONGLONG created; } publication_history_entry;
static int publication_history_order(const void *left, const void *right) {
  const publication_history_entry *a = left, *b = right;
  if (a->created != b->created) return a->created > b->created ? -1 : 1;
  return wcscmp(a->nonce, b->nonce);
}
static void delete_publication_artifact(HANDLE file, HANDLE parent) {
  FILE_DISPOSITION_INFO disposition = { TRUE };
  checked(SetFileInformationByHandle(file, FileDispositionInfo, &disposition, sizeof(disposition)), "publication history identity held deletion");
  CloseHandle(file); checked(FlushFileBuffers(parent), "publication history deletion namespace durability");
}
static int prune_publication_history(wchar_t **argv) {
  wchar_t *end; errno = 0; unsigned long keep = wcstoul(argv[3], &end, 10);
  if (errno || *end || !*argv[3] || keep > 32) return 125;
  wchar_t target[32768]; HANDLE parents[256]; DWORD ancestors = anchor_parents_access(argv[2], target, parents, GENERIC_WRITE);
  HANDLE parent = parents[ancestors - 1], guard = publication_guard(target, parent, TRUE);
  checked(FlushFileBuffers(parent), "private namespace durability prerequisite");
  wchar_t *intentPath = publication_path(target, L".DevRyan-publication.intent");
  HANDLE intentFile = open_publication_file(intentPath, OPEN_EXISTING, 0); publication_intent current = {0};
  BOOL present = read_intent(intentFile, parent, &current);
  HANDLE proof = present ? require_settled_intent(target, parent, &current) : NULL;
  publication_history_entry *entries = calloc(4096, sizeof(*entries)); if (!entries) fail("publication history allocation");
  wchar_t *pattern = publication_path(target, L".DevRyan-publication-*.receipt");
  WIN32_FIND_DATAW found; HANDLE search = FindFirstFileW(pattern, &found); free(pattern); DWORD scanned = 0, count = 0;
  if (search != INVALID_HANDLE_VALUE) {
    do {
      if (++scanned > 4096) { SetLastError(ERROR_FILE_TOO_LARGE); fail("publication history scan bound"); }
      wchar_t *name = publication_path(target, found.cFileName); HANDLE file = open_publication_file(name, OPEN_EXISTING, 0); publication_intent receipt = {0};
      if (!read_intent(file, parent, &receipt) || (receipt.phase != 2 && receipt.phase != 4)) { SetLastError(ERROR_INVALID_DATA); fail("publication history completed receipt"); }
      wchar_t *expectedName = publication_nonce_path(target, receipt.nonce, L"receipt");
      if (wcscmp(wcsrchr(expectedName, L'\\') + 1, found.cFileName)) { SetLastError(ERROR_INVALID_DATA); fail("publication history nonce filename"); }
      if (!_wcsicmp(receipt.target, wcsrchr(target, L'\\') + 1)) {
        FILETIME created; checked(GetFileTime(file, &created, NULL, NULL), "publication history creation identity");
        wcscpy(entries[count].nonce, receipt.nonce); entries[count].created = ((ULONGLONG)created.dwHighDateTime << 32) | created.dwLowDateTime;
        checked(GetFileInformationByHandleEx(file, FileIdInfo, &entries[count].receipt, sizeof(entries[count].receipt)), "publication history retained receipt identity"); count++;
      }
      CloseHandle(file); free(name); free(expectedName);
    } while (FindNextFileW(search, &found));
    if (GetLastError() != ERROR_NO_MORE_FILES) fail("publication history enumeration"); FindClose(search);
  } else if (GetLastError() != ERROR_FILE_NOT_FOUND) fail("publication history enumeration");
  qsort(entries, count, sizeof(*entries), publication_history_order); DWORD retained = 0, historical = 0, pruned = 0;
  for (DWORD i = 0; i < count; i++) {
    if (present && !wcscmp(entries[i].nonce, current.nonce)) { retained++; continue; }
    if (historical++ < keep) { retained++; continue; }
    wchar_t *name = publication_nonce_path(target, entries[i].nonce, L"receipt"), *backupPath = publication_nonce_path(target, entries[i].nonce, L"backup");
    HANDLE receiptFile = open_publication_file(name, OPEN_EXISTING, DELETE); publication_intent receipt = {0}; FILE_ID_INFO identity;
    checked(GetFileInformationByHandleEx(receiptFile, FileIdInfo, &identity, sizeof(identity)), "publication history deletion receipt identity");
    if (!identity_equal(&identity, &entries[i].receipt) || !read_intent(receiptFile, parent, &receipt)
      || wcscmp(receipt.nonce, entries[i].nonce) || _wcsicmp(receipt.target, wcsrchr(target, L'\\') + 1)
      || (receipt.phase != 2 && receipt.phase != 4)) { SetLastError(ERROR_INVALID_DATA); fail("publication history deletion binding"); }
    wchar_t *candidatePath = publication_nonce_path(target, receipt.nonce, L"candidate");
    HANDLE candidate = open_publication_file(candidatePath, OPEN_EXISTING, 0); free(candidatePath);
    if (candidate) { SetLastError(ERROR_INVALID_DATA); fail("publication history unexpected candidate"); }
    HANDLE backup = open_publication_file(backupPath, OPEN_EXISTING, DELETE);
    if (backup) {
      if (!receipt.oldPresent) { SetLastError(ERROR_INVALID_DATA); fail("publication history unexpected backup"); }
      verify_publication_file(backup, &receipt.old, receipt.oldSize, receipt.oldHash); delete_publication_artifact(backup, parent);
    }
    /* Missing historical backup is the restart point after its flushed
     * deletion; this operation still deletes only the held receipt ID. */
    delete_publication_artifact(receiptFile, parent); pruned++; free(name); free(backupPath);
  }
  printf("{\"protocol\":\"devryan.windows-publication-pruning/1\",\"retained\":%lu,\"pruned\":%lu,\"namespaceFlushed\":true}\n", retained, pruned);
  if (proof) CloseHandle(proof); if (intentFile) CloseHandle(intentFile); CloseHandle(guard); free(entries); free(intentPath);
  for (DWORD i = 0; i < ancestors; i++) CloseHandle(parents[i]); return 0;
}

static void require_no_orphan_candidate(const wchar_t *target) {
  wchar_t *pattern = publication_path(target, L".DevRyan-publication-*.candidate"); WIN32_FIND_DATAW found;
  HANDLE search = FindFirstFileW(pattern, &found); free(pattern);
  if (search != INVALID_HANDLE_VALUE) {
    FindClose(search); SetLastError(ERROR_IO_PENDING); fail("publication orphan candidate requires attended recovery");
  }
  if (GetLastError() != ERROR_FILE_NOT_FOUND) fail("publication candidate inventory");
}

static int publish_private_file(const wchar_t *argument, const wchar_t *expected, const wchar_t *nonce, BOOL recovery, BOOL deleting, DWORD maximum) {
  wchar_t path[32768]; HANDLE ancestors[256];
  DWORD count = anchor_parents_access(argument, path, ancestors, GENERIC_WRITE); HANDLE parent = ancestors[count - 1];
  HANDLE guard = publication_guard(path, parent, TRUE);
  /* Refuse before candidate, backup or intent mutation when the per-user
   * directory handle cannot establish namespace durability. */
  checked(FlushFileBuffers(parent), "private namespace durability prerequisite");
  const wchar_t *basename = wcsrchr(path, L'\\') + 1;
  if (wcslen(basename) >= 256 || !_wcsnicmp(basename, L".DevRyan-publication", 20)) { SetLastError(ERROR_INVALID_PARAMETER); fail("publication target name"); }
  wchar_t *intentPath = publication_path(path, L".DevRyan-publication.intent");
  HANDLE intentFile = open_publication_file(intentPath, OPEN_EXISTING, GENERIC_WRITE); publication_intent intent = {0};
  BOOL present = read_intent(intentFile, parent, &intent);
  if (recovery) {
    if (!present || wcscmp(intent.target, basename) || wcscmp(intent.nonce, nonce)) { SetLastError(ERROR_INVALID_DATA); fail("publication recovery binding"); }
    if (intent.phase == 1) finish_publication(path, parent, intentFile, &intent);
    if (intent.phase == 3) finish_deletion(path, parent, intentFile, &intent);
    HANDLE settled = require_settled_intent(path, parent, &intent); if (settled) CloseHandle(settled);
  } else {
    if (present) { HANDLE settled = require_settled_intent(path, parent, &intent); if (settled) CloseHandle(settled); }
    require_no_orphan_candidate(path);
    if (wcslen(nonce) != 32) { SetLastError(ERROR_INVALID_PARAMETER); fail("publication nonce"); }
    for (DWORD i = 0; i < 32; i++) if (!((nonce[i] >= L'0' && nonce[i] <= L'9') || (nonce[i] >= L'a' && nonce[i] <= L'f'))) { SetLastError(ERROR_INVALID_PARAMETER); fail("publication nonce"); }
    memset(&intent, 0, sizeof(intent)); memcpy(intent.magic, publication_magic, sizeof(publication_magic)); intent.phase = deleting ? 3 : 1;
    wcscpy(intent.target, basename); wcscpy(intent.nonce, nonce);
    checked(GetFileInformationByHandleEx(parent, FileIdInfo, &intent.parent, sizeof(intent.parent)), "publication retained parent");
    HANDLE old = open_publication_file(path, OPEN_EXISTING, DELETE); wchar_t oldToken[160] = L"absent";
    if (old) {
      intent.oldPresent = 1; checked(GetFileInformationByHandleEx(old, FileIdInfo, &intent.old, sizeof(intent.old)), "publication old identity");
      hash_file_bound(old, &intent.oldSize, intent.oldHash, maximum);
      swprintf(oldToken, 160, L"%016llx:", (unsigned long long)intent.old.VolumeSerialNumber);
      size_t offset = wcslen(oldToken);
      for (DWORD i = 0; i < 16; i++) swprintf(oldToken + offset + i * 2, 160 - offset - i * 2, L"%02x", (unsigned int)intent.old.FileId.Identifier[i]);
      wcscat(oldToken, L":"); offset = wcslen(oldToken);
      for (DWORD i = 0; i < 32; i++) swprintf(oldToken + offset + i * 2, 160 - offset - i * 2, L"%02x", (unsigned int)intent.oldHash[i]);
      offset = wcslen(oldToken); swprintf(oldToken + offset, 160 - offset, L":%llu", (unsigned long long)intent.oldSize);
    }
    if (wcscmp(expected, oldToken) || old && intent.old.VolumeSerialNumber != intent.parent.VolumeSerialNumber) { SetLastError(ERROR_INVALID_DATA); fail("publication old compare and swap"); }
    wchar_t *candidatePath = NULL; HANDLE candidate = NULL;
    if (!deleting) {
    candidatePath = publication_nonce_path(path, nonce, L"candidate"); candidate = open_publication_file(candidatePath, CREATE_NEW, GENERIC_WRITE | DELETE);
    BYTE bytes[65536]; DWORD total = 0;
    for (;;) {
      DWORD read;
      if (!ReadFile(GetStdHandle(STD_INPUT_HANDLE), bytes, sizeof(bytes), &read, NULL)) {
        if (GetLastError() == ERROR_BROKEN_PIPE) break;
        fail("publication candidate input");
      }
      if (!read) break;
      if (read > maximum || total > maximum - read) { SetLastError(ERROR_FILE_TOO_LARGE); fail("publication candidate bound"); }
      DWORD written; checked(WriteFile(candidate, bytes, read, &written, NULL) && written == read, "publication candidate bytes"); total += read;
    }
    checked(FlushFileBuffers(candidate), "publication candidate data durability"); hash_file(candidate, &intent.stagedSize, intent.stagedHash);
    checked(GetFileInformationByHandleEx(candidate, FileIdInfo, &intent.staged, sizeof(intent.staged)), "publication staged identity");
    }
    if (!intentFile) intentFile = open_publication_file(intentPath, CREATE_NEW, GENERIC_WRITE);
    write_intent(intentFile, &intent); validate_intent(&intent, parent); checked(FlushFileBuffers(parent), "publication intent namespace durability");
    if (candidate) CloseHandle(candidate); if (old) CloseHandle(old); free(candidatePath);
    if (deleting) finish_deletion(path, parent, intentFile, &intent);
    else finish_publication(path, parent, intentFile, &intent);
  }
  emit_publication(&intent); CloseHandle(intentFile); CloseHandle(guard); free(intentPath);
  for (DWORD i = 0; i < count; i++) CloseHandle(ancestors[i]); return 0;
}

static int inspect_publication(const wchar_t *argument) {
  wchar_t path[32768]; HANDLE ancestors[256]; DWORD count = anchor_parents(argument, path, ancestors);
  HANDLE parent = ancestors[count - 1], guard = publication_guard(path, parent, FALSE);
  wchar_t *name = publication_path(path, L".DevRyan-publication.intent");
  HANDLE file = open_publication_file(name, OPEN_EXISTING, 0); publication_intent intent = {0};
  BOOL present = read_intent(file, parent, &intent);
  if (present && wcscmp(intent.target, wcsrchr(path, L'\\') + 1)) {
    if (intent.phase != 2 && intent.phase != 4) { SetLastError(ERROR_IO_PENDING); fail("publication other target pending"); }
    HANDLE settled = require_settled_intent(path, parent, &intent); if (settled) CloseHandle(settled);
    present = FALSE;
  }
  if (present && (intent.phase == 2 || intent.phase == 4)) { HANDLE settled = require_settled_intent(path, parent, &intent); if (settled) CloseHandle(settled); }
  printf("{\"protocol\":\"devryan.windows-publication-state/1\",\"status\":\"%s\",\"nonce\":", present ? intent.phase == 2 ? "published" : intent.phase == 4 ? "deleted" : "pending" : "none");
  if (present) printf("\"%ls\"", intent.nonce); else printf("null");
  printf("}\n");
  if (file) CloseHandle(file); CloseHandle(guard); free(name);
  for (DWORD i = 0; i < count; i++) CloseHandle(ancestors[i]); return 0;
}

static int inspect_private_settlement(const wchar_t *argument, const wchar_t *nonce) {
  wchar_t path[32768]; HANDLE ancestors[256]; DWORD count = anchor_parents(argument, path, ancestors);
  HANDLE parent = ancestors[count - 1], guard = publication_guard(path, parent, FALSE);
  wchar_t *name = publication_path(path, L".DevRyan-publication.intent");
  HANDLE file = open_publication_file(name, OPEN_EXISTING, 0); publication_intent intent = {0};
  if (!read_intent(file, parent, &intent) || wcscmp(intent.nonce, nonce)
    || _wcsicmp(intent.target, wcsrchr(path, L'\\') + 1) || (intent.phase != 2 && intent.phase != 4)) {
    SetLastError(ERROR_INVALID_DATA); fail("publication inspected settlement binding");
  }
  HANDLE settled = require_settled_intent(path, parent, &intent);
  emit_publication(&intent);
  if (settled) CloseHandle(settled); CloseHandle(file); CloseHandle(guard); free(name);
  for (DWORD i = 0; i < count; i++) CloseHandle(ancestors[i]); return 0;
}

/* This is a feasibility receipt, never a publication grant. No volume handle,
 * privilege adjustment or suppressed directory flush can satisfy the gate. */
static int inspect_namespace_durability(const wchar_t *argument) {
  wchar_t path[32768]; HANDLE ancestors[256];
  DWORD count = anchor_parents_access(argument, path, ancestors, GENERIC_WRITE);
  HANDLE parent = ancestors[count - 1]; BOOL own;
  if (!file_privacy(parent, &own)) { SetLastError(ERROR_ACCESS_DENIED); fail("private durability parent"); }
  FILE_ID_INFO identity = {0};
  checked(GetFileInformationByHandleEx(parent, FileIdInfo, &identity, sizeof(identity)), "durability parent identity");
  BOOL flushed = FlushFileBuffers(parent); DWORD error = flushed ? 0 : GetLastError();
  printf("{\"protocol\":\"devryan.windows-namespace-durability/1\",\"volume\":\"%016llx\",\"fileId\":\"", (unsigned long long)identity.VolumeSerialNumber);
  for (DWORD i = 0; i < sizeof(identity.FileId.Identifier); i++) printf("%02x", (unsigned int)identity.FileId.Identifier[i]);
  printf("\",\"directoryFlushed\":%s,\"windowsError\":%lu,\"publicationQualified\":false}\n", flushed ? "true" : "false", error);
  for (DWORD i = 0; i < count; i++) CloseHandle(ancestors[i]);
  return 0;
}

/* The identity and bytes are observed through one retained no-follow handle.
 * No writer or replacement may race this read, including on parent paths. */
static int read_private_file(const wchar_t *argument, DWORD maximum) {
  wchar_t path[32768]; HANDLE ancestors[256];
  DWORD count = anchor_parents(argument, path, ancestors);
  HANDLE guard = publication_guard(path, ancestors[count - 1], FALSE);
  HANDLE published = require_no_publication(path, ancestors[count - 1]);
  HANDLE file = CreateFileW(path, GENERIC_READ, FILE_SHARE_READ, NULL, OPEN_EXISTING, FILE_FLAG_OPEN_REPARSE_POINT, NULL);
  if (file == INVALID_HANDLE_VALUE) fail("private read handle");
  BY_HANDLE_FILE_INFORMATION info; LARGE_INTEGER size = {0}; BOOL own;
  checked(GetFileInformationByHandle(file, &info) && GetFileSizeEx(file, &size), "private read identity");
  if ((info.dwFileAttributes & (FILE_ATTRIBUTE_REPARSE_POINT | FILE_ATTRIBUTE_DIRECTORY)) || info.nNumberOfLinks != 1
    || size.QuadPart < 0 || (ULONGLONG)size.QuadPart > maximum || !file_privacy(file, &own)) {
    SetLastError(ERROR_ACCESS_DENIED); fail("private read boundary");
  }
  inspect_file_handle(file); checked(fflush(stdout) == 0, "private read identity output");
  BYTE bytes[65536]; DWORD read;
  for (;;) {
    checked(ReadFile(file, bytes, sizeof(bytes), &read, NULL), "private read bytes");
    if (!read) break;
    DWORD written;
    checked(WriteFile(GetStdHandle(STD_OUTPUT_HANDLE), bytes, read, &written, NULL) && written == read, "private read output");
  }
  CloseHandle(file);
  if (published) CloseHandle(published);
  CloseHandle(guard);
  for (DWORD i = 0; i < count; i++) CloseHandle(ancestors[i]);
  return 0;
}

/* A retained kernel byte-range lock proves this exact keeper's lifetime.
 * PID reuse and stale JSON never turn an uncertain owner into a lost one. */
static HANDLE parent_process(DWORD *pid);
static int owner_lock(const wchar_t *argument, BOOL probe, BOOL reusable) {
  wchar_t path[32768]; HANDLE ancestors[256];
  DWORD count = anchor_parents(argument, path, ancestors);
  if (reusable) {
    BOOL own;
    if (!count || !file_privacy(ancestors[count - 1], &own)) {
      SetLastError(ERROR_ACCESS_DENIED); fail("private lock parent");
    }
  }
  PSECURITY_DESCRIPTOR security = private_security(FALSE);
  SECURITY_ATTRIBUTES attributes = { sizeof(attributes), security, FALSE };
  HANDLE file = CreateFileW(path, GENERIC_READ | GENERIC_WRITE | READ_CONTROL,
    FILE_SHARE_READ | FILE_SHARE_WRITE, &attributes, probe ? OPEN_EXISTING : reusable ? OPEN_ALWAYS : CREATE_NEW,
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
    if ((probe || reusable) && GetLastError() == ERROR_LOCK_VIOLATION) return 73;
    fail("owner lock acquisition");
  }
  if (!probe) {
    DWORD parentPid; HANDLE parent = parent_process(&parentPid);
    HANDLE input = GetStdHandle(STD_INPUT_HANDLE);
    if (GetFileType(input) != FILE_TYPE_PIPE) { SetLastError(ERROR_INVALID_HANDLE); fail("owner lifetime pipe"); }
    checked(FlushFileBuffers(file), "owner lock durability");
    DWORD written;
    checked(WriteFile(GetStdHandle(STD_OUTPUT_HANDLE), "owned\n", 6, &written, NULL) && written == 6, "owner lock acknowledgement");
    for (;;) {
      DWORD state = WaitForSingleObject(parent, 25);
      if (state == WAIT_OBJECT_0) break;
      if (state != WAIT_TIMEOUT) fail("owner lifetime wait");
      DWORD available;
      if (!PeekNamedPipe(input, NULL, 0, NULL, &available, NULL)) {
        if (GetLastError() == ERROR_BROKEN_PIPE || GetLastError() == ERROR_PIPE_NOT_CONNECTED) break;
        fail("owner lifetime input");
      }
      if (available) { SetLastError(ERROR_INVALID_DATA); fail("owner lifetime protocol"); }
    }
    CloseHandle(parent);
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

static DWORD parent_id(DWORD subject) {
  HANDLE snapshot = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
  if (snapshot == INVALID_HANDLE_VALUE) fail("owner snapshot");
  PROCESSENTRY32 entry = { .dwSize = sizeof(entry) }; DWORD parent = 0;
  if (Process32First(snapshot, &entry)) do {
    if (entry.th32ProcessID == subject) { parent = entry.th32ParentProcessID; break; }
  } while (Process32Next(snapshot, &entry));
  CloseHandle(snapshot); if (!parent) fail("execution owner"); return parent;
}

/* A recycled parent PID cannot authorize a new owner. Open the actual process,
 * require creation before this supervisor, and retain that handle until drain. */
static HANDLE parent_process(DWORD *pid) {
  *pid = parent_id(GetCurrentProcessId());
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

/* Cancellation names include the retained supervisor's creation identity.
 * A reused PID or another execution's event never acknowledges this request. */
static void cancel_event_name(const wchar_t *base, DWORD pid, FILETIME created, wchar_t *name) {
  if (wcslen(base) > 120 || wcsncmp(base, L"Local\\DevRyan-", 14)) {
    SetLastError(ERROR_INVALID_PARAMETER); fail("cancel event scope");
  }
  for (const wchar_t *p = base + 14; *p; p++) if (!((*p >= L'a' && *p <= L'z')
    || (*p >= L'A' && *p <= L'Z') || (*p >= L'0' && *p <= L'9') || *p == L'-')) {
    SetLastError(ERROR_INVALID_PARAMETER); fail("cancel event name");
  }
  swprintf(name, 192, L"%s-%lu-win32:%08lx%08lx", base, pid, created.dwHighDateTime, created.dwLowDateTime);
}

static int cancel_process(const wchar_t *base, const wchar_t *argument, const wchar_t *expected) {
  if (!*argument) return 125;
  for (const wchar_t *p = argument; *p; p++) if (*p < L'0' || *p > L'9') return 125;
  wchar_t *end; errno = 0; unsigned long pid = wcstoul(argument, &end, 10);
  if (errno || *end || !pid) return 125;
  HANDLE supervisor = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION | SYNCHRONIZE, FALSE, (DWORD)pid);
  if (!supervisor) fail("cancel supervisor handle");
  FILETIME created = {0}, exited = {0}, kernel = {0}, user = {0}, ownerCreated = {0}, helperCreated = {0};
  checked(GetProcessTimes(supervisor, &created, &exited, &kernel, &user), "cancel supervisor identity");
  wchar_t identity[24]; swprintf(identity, 24, L"win32:%08lx%08lx", created.dwHighDateTime, created.dwLowDateTime);
  DWORD ownerPid; HANDLE owner = parent_process(&ownerPid);
  checked(GetProcessTimes(owner, &ownerCreated, &exited, &kernel, &user), "cancel owner identity");
  checked(GetProcessTimes(GetCurrentProcess(), &helperCreated, &exited, &kernel, &user), "cancel helper identity");
  if (wcscmp(identity, expected) || WaitForSingleObject(supervisor, 0) != WAIT_TIMEOUT
    || parent_id((DWORD)pid) != ownerPid || CompareFileTime(&ownerCreated, &created) >= 0
    || CompareFileTime(&created, &helperCreated) >= 0) {
    SetLastError(ERROR_ACCESS_DENIED); fail("cancel owned supervisor");
  }
  wchar_t name[192]; cancel_event_name(base, (DWORD)pid, created, name);
  HANDLE event = OpenEventW(EVENT_MODIFY_STATE, FALSE, name);
  if (!event) fail("cancel event");
  checked(SetEvent(event), "cancel signal");
  CloseHandle(event); CloseHandle(owner); CloseHandle(supervisor); return 0;
}

/* Trusted self-only probe separates native child creation from Node's pipe
 * setup. It cannot run outside the existing AppContainer/job boundary. */
static int diagnose_descendant(BOOL leaf) {
  HANDLE token; DWORD app = 0, returned; BOOL inJob;
  checked(OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &token), "diagnostic token");
  checked(GetTokenInformation(token, TokenIsAppContainer, &app, sizeof(app), &returned), "diagnostic AppContainer");
  checked(IsProcessInJob(GetCurrentProcess(), NULL, &inJob), "diagnostic containing job");
  CloseHandle(token);
  if (!app || !inJob) return 125;
  if (leaf) { puts("DevRyan confined descendant started"); return 0; }
  wchar_t executable[32768];
  DWORD length = GetModuleFileNameW(NULL, executable, 32768);
  if (!length || length >= 32768) fail("diagnostic executable");
  HANDLE image = CreateFileW(executable, GENERIC_READ, FILE_SHARE_READ, NULL, OPEN_EXISTING, FILE_FLAG_OPEN_REPARSE_POINT, NULL);
  DWORD imageError = image == INVALID_HANDLE_VALUE ? GetLastError() : 0;
  if (image != INVALID_HANDLE_VALUE) CloseHandle(image);
  DWORD nullErrors[2];
  for (DWORD i = 0; i < 2; i++) {
    HANDLE device = CreateFileW(L"NUL", i ? FILE_GENERIC_WRITE | FILE_READ_ATTRIBUTES : FILE_GENERIC_READ,
      FILE_SHARE_READ | FILE_SHARE_WRITE, NULL, OPEN_EXISTING, 0, NULL);
    nullErrors[i] = device == INVALID_HANDLE_VALUE ? GetLastError() : 0;
    if (device != INVALID_HANDLE_VALUE) CloseHandle(device);
  }
  LUID pipeId; checked(AllocateLocallyUniqueId(&pipeId), "diagnostic pipe identity");
  DWORD pipeErrors[2];
  for (DWORD i = 0; i < 2; i++) {
    wchar_t name[192]; swprintf(name, 192, L"\\\\.\\pipe\\%sDevRyan-diagnostic-%lu-%lu-%lu", i ? L"LOCAL\\" : L"",
      GetCurrentProcessId(), (DWORD)pipeId.HighPart, pipeId.LowPart);
    HANDLE pipe = CreateNamedPipeW(name, PIPE_ACCESS_DUPLEX | FILE_FLAG_FIRST_PIPE_INSTANCE,
      PIPE_TYPE_BYTE | PIPE_READMODE_BYTE | PIPE_WAIT, 1, 4096, 4096, 0, NULL);
    pipeErrors[i] = pipe == INVALID_HANDLE_VALUE ? GetLastError() : 0;
    if (pipe != INVALID_HANDLE_VALUE) CloseHandle(pipe);
  }
  STARTUPINFOEXW startup = {0}; startup.StartupInfo.cb = sizeof(startup); startup.StartupInfo.dwFlags = STARTF_USESTDHANDLES;
  HANDLE handles[3]; DWORD kinds[] = {STD_INPUT_HANDLE, STD_OUTPUT_HANDLE, STD_ERROR_HANDLE};
  for (DWORD i = 0; i < 3; i++) checked(DuplicateHandle(GetCurrentProcess(), GetStdHandle(kinds[i]), GetCurrentProcess(),
    &handles[i], 0, TRUE, DUPLICATE_SAME_ACCESS), "diagnostic standard handle");
  startup.StartupInfo.hStdInput = handles[0]; startup.StartupInfo.hStdOutput = handles[1]; startup.StartupInfo.hStdError = handles[2];
  SIZE_T size = 0; InitializeProcThreadAttributeList(NULL, 1, 0, &size);
  startup.lpAttributeList = malloc(size); if (!startup.lpAttributeList) fail("diagnostic attributes allocation");
  checked(InitializeProcThreadAttributeList(startup.lpAttributeList, 1, 0, &size), "diagnostic process attributes");
  checked(UpdateProcThreadAttribute(startup.lpAttributeList, 0, PROC_THREAD_ATTRIBUTE_HANDLE_LIST,
    handles, sizeof(handles), NULL, NULL), "diagnostic three handles");
  wchar_t *arguments[] = {executable, L"--diagnose-descendant-leaf"}, *command = command_line(2, arguments, 0);
  PROCESS_INFORMATION child = {0};
  BOOL created = CreateProcessW(NULL, command, NULL, NULL, TRUE, CREATE_NO_WINDOW | EXTENDED_STARTUPINFO_PRESENT,
    NULL, NULL, &startup.StartupInfo, &child);
  DWORD error = created ? 0 : GetLastError(), code = 125;
  if (created) {
    if (WaitForSingleObject(child.hProcess, 5000) != WAIT_OBJECT_0) {
      checked(TerminateProcess(child.hProcess, 125), "diagnostic child stop");
      checked(WaitForSingleObject(child.hProcess, 5000) == WAIT_OBJECT_0, "diagnostic child settlement");
    }
    checked(GetExitCodeProcess(child.hProcess, &code), "diagnostic child result");
    CloseHandle(child.hThread); CloseHandle(child.hProcess);
  }
  for (DWORD i = 0; i < 3; i++) CloseHandle(handles[i]);
  DeleteProcThreadAttributeList(startup.lpAttributeList); free(startup.lpAttributeList); free(command);
  printf("{\"protocol\":\"devryan.windows-descendant-startup/1\",\"imageReadError\":%lu,\"nullReadError\":%lu,\"nullWriteError\":%lu,\"generalPipeError\":%lu,\"localPipeError\":%lu,\"created\":%s,\"windowsError\":%lu,\"exitCode\":%lu}\n",
    imageError, nullErrors[0], nullErrors[1], pipeErrors[0], pipeErrors[1], created ? "true" : "false", error, code);
  return created && !code ? 0 : 125;
}

typedef struct {
  HANDLE pipe;
  DWORD expected, count, error, hash;
  BOOL input;
  BYTE *capture;
  DWORD captureCapacity, captureLength;
} diagnostic_stream;

static DWORD WINAPI transfer_diagnostic_stream(void *argument) {
  diagnostic_stream *stream = argument; BYTE buffer[4096];
  stream->hash = 2166136261u;
  for (;;) {
    DWORD transferred;
    if (stream->input) {
      if (stream->count == stream->expected) break;
      DWORD remaining = stream->expected - stream->count;
      DWORD count = remaining < sizeof(buffer) ? remaining : (DWORD)sizeof(buffer);
      for (DWORD i = 0; i < count; i++) buffer[i] = (BYTE)((stream->count + i) % 251);
      if (!WriteFile(stream->pipe, buffer, count, &transferred, NULL) || transferred != count) {
        stream->error = GetLastError(); if (!stream->error) stream->error = ERROR_WRITE_FAULT; break;
      }
    } else {
      if (!ReadFile(stream->pipe, buffer, sizeof(buffer), &transferred, NULL)) {
        DWORD error = GetLastError();
        if (error != ERROR_BROKEN_PIPE) stream->error = error;
        break;
      }
      if (!transferred) break;
      if (stream->count > 1048576 - transferred) { stream->error = ERROR_FILE_TOO_LARGE; break; }
      if (stream->capture && stream->captureLength < stream->captureCapacity) {
        DWORD remaining = stream->captureCapacity - stream->captureLength;
        DWORD count = transferred < remaining ? transferred : remaining;
        memcpy(stream->capture + stream->captureLength, buffer, count); stream->captureLength += count;
      }
      for (DWORD i = 0; i < transferred; i++) stream->hash = (stream->hash ^ buffer[i]) * 16777619u;
    }
    stream->count += transferred;
  }
  CloseHandle(stream->pipe); stream->pipe = NULL;
  return 0;
}

/* Exact three-handle launch using AppContainer LOCAL pipes. This experiments
 * with supplied stdio only; the pinned runtime's own nested spawning APIs are
 * unchanged. The enclosing production supervisor still owns every descendant. */
static int diagnose_local_stdio(int argc, wchar_t **argv) {
  HANDLE token; DWORD app = 0, returned; BOOL inJob;
  checked(OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &token), "local stdio token");
  checked(GetTokenInformation(token, TokenIsAppContainer, &app, sizeof(app), &returned), "local stdio AppContainer");
  checked(IsProcessInJob(GetCurrentProcess(), NULL, &inJob), "local stdio job"); CloseHandle(token);
  if (!app || !inJob || argc < 5) return 125;
  wchar_t *end; errno = 0; unsigned long length = wcstoul(argv[2], &end, 10);
  if (errno || !*argv[2] || *end || length > 262144) return 125;
  LUID identity; checked(AllocateLocallyUniqueId(&identity), "local pipe identity");
  diagnostic_stream streams[3] = {0}; HANDLE handles[3], threads[3];
  BYTE stderrCapture[4096]; streams[2].capture = stderrCapture; streams[2].captureCapacity = sizeof(stderrCapture);
  SECURITY_ATTRIBUTES inherited = {sizeof(inherited), NULL, TRUE};
  for (DWORD i = 0; i < 3; i++) {
    wchar_t name[192]; swprintf(name, 192, L"\\\\.\\pipe\\LOCAL\\DevRyan-stdio-%lu-%lu-%lu-%lu",
      GetCurrentProcessId(), (DWORD)identity.HighPart, identity.LowPart, i);
    streams[i].input = i == 0; streams[i].expected = (DWORD)length;
    streams[i].pipe = CreateNamedPipeW(name, (i ? PIPE_ACCESS_INBOUND : PIPE_ACCESS_OUTBOUND) | FILE_FLAG_FIRST_PIPE_INSTANCE,
      PIPE_TYPE_BYTE | PIPE_READMODE_BYTE | PIPE_WAIT | PIPE_REJECT_REMOTE_CLIENTS, 1, 4096, 4096, 0, NULL);
    if (streams[i].pipe == INVALID_HANDLE_VALUE) fail("LOCAL pipe server");
    handles[i] = CreateFileW(name, i ? GENERIC_WRITE : GENERIC_READ, 0, &inherited, OPEN_EXISTING, 0, NULL);
    if (handles[i] == INVALID_HANDLE_VALUE) fail("LOCAL pipe client");
    if (!ConnectNamedPipe(streams[i].pipe, NULL) && GetLastError() != ERROR_PIPE_CONNECTED) fail("LOCAL pipe connection");
  }
  STARTUPINFOEXW startup = {0}; startup.StartupInfo.cb = sizeof(startup); startup.StartupInfo.dwFlags = STARTF_USESTDHANDLES;
  startup.StartupInfo.hStdInput = handles[0]; startup.StartupInfo.hStdOutput = handles[1]; startup.StartupInfo.hStdError = handles[2];
  SIZE_T bytes = 0; InitializeProcThreadAttributeList(NULL, 1, 0, &bytes);
  startup.lpAttributeList = malloc(bytes); if (!startup.lpAttributeList) fail("LOCAL stdio attributes allocation");
  checked(InitializeProcThreadAttributeList(startup.lpAttributeList, 1, 0, &bytes), "LOCAL stdio process attributes");
  checked(UpdateProcThreadAttribute(startup.lpAttributeList, 0, PROC_THREAD_ATTRIBUTE_HANDLE_LIST,
    handles, sizeof(handles), NULL, NULL), "LOCAL stdio three handles");
  wchar_t *command = command_line(argc, argv, 3); PROCESS_INFORMATION child = {0};
  BOOL created = CreateProcessW(NULL, command, NULL, NULL, TRUE, CREATE_NO_WINDOW | EXTENDED_STARTUPINFO_PRESENT,
    NULL, NULL, &startup.StartupInfo, &child);
  DWORD error = created ? 0 : GetLastError(), code = 125; BOOL settled = created;
  for (DWORD i = 0; i < 3; i++) CloseHandle(handles[i]);
  for (DWORD i = 0; i < 3; i++) {
    threads[i] = CreateThread(NULL, 0, transfer_diagnostic_stream, &streams[i], 0, NULL);
    if (!threads[i]) fail("LOCAL stdio transfer thread");
  }
  if (created) {
    checked(IsProcessInJob(child.hProcess, NULL, &inJob) && inJob, "LOCAL stdio inherited job");
    if (WaitForSingleObject(child.hProcess, 15000) != WAIT_OBJECT_0) {
      settled = FALSE; checked(TerminateProcess(child.hProcess, 125), "LOCAL stdio timeout stop");
      checked(WaitForSingleObject(child.hProcess, 5000) == WAIT_OBJECT_0, "LOCAL stdio child settlement");
    }
    checked(GetExitCodeProcess(child.hProcess, &code), "LOCAL stdio child result");
    CloseHandle(child.hThread); CloseHandle(child.hProcess);
  }
  for (DWORD i = 0; i < 3; i++) {
    if (WaitForSingleObject(threads[i], 5000) != WAIT_OBJECT_0) {
      settled = FALSE;
      if (!CancelSynchronousIo(threads[i]) && GetLastError() != ERROR_NOT_FOUND) fail("LOCAL stdio transfer cancellation");
      checked(WaitForSingleObject(threads[i], 5000) == WAIT_OBJECT_0, "LOCAL stdio transfer settlement");
    }
    CloseHandle(threads[i]);
  }
  /* Keep bounded child diagnostics only in the synthetic fixture artifact.
   * Runtime bytes never become supervisor JSON or user-facing CI output. */
  wchar_t directory[32768]; DWORD directoryLength = GetFullPathNameW(argv[3], 32768, directory, NULL);
  if (!directoryLength || directoryLength >= 32768 || !wcsrchr(directory, L'\\')) fail("LOCAL stdio stderr artifact directory");
  *wcsrchr(directory, L'\\') = 0;
  wchar_t *capturePath = joined(directory, L"runtime-stderr.bin");
  HANDLE capture = CreateFileW(capturePath, GENERIC_WRITE, 0, NULL, CREATE_NEW,
    FILE_FLAG_OPEN_REPARSE_POINT | FILE_FLAG_WRITE_THROUGH, NULL);
  if (capture == INVALID_HANDLE_VALUE) fail("LOCAL stdio stderr artifact creation");
  DWORD captured;
  checked(WriteFile(capture, stderrCapture, streams[2].captureLength, &captured, NULL)
    && captured == streams[2].captureLength && FlushFileBuffers(capture), "LOCAL stdio stderr artifact write");
  CloseHandle(capture); free(capturePath);
  DeleteProcThreadAttributeList(startup.lpAttributeList); free(startup.lpAttributeList); free(command);
  printf("{\"protocol\":\"devryan.windows-local-stdio/1\",\"created\":%s,\"windowsError\":%lu,\"exitCode\":%lu,\"settled\":%s,\"inputBytes\":%lu,\"inputError\":%lu,\"stdoutBytes\":%lu,\"stdoutHash\":%lu,\"stdoutError\":%lu,\"stderrBytes\":%lu,\"stderrHash\":%lu,\"stderrError\":%lu,\"admission\":false}\n",
    created ? "true" : "false", error, code, settled ? "true" : "false", streams[0].count, streams[0].error,
    streams[1].count, streams[1].hash, streams[1].error, streams[2].count, streams[2].hash, streams[2].error);
  return created && settled && !code && !streams[0].error && !streams[1].error && !streams[2].error ? 0 : 125;
}

/* Updater trees are bounded, private, same-volume snapshots. They never share
 * the credential ACL relaxation: inherited owner/SYSTEM grants are accepted
 * only underneath the held protected installation root. */
typedef struct { HANDLE *files; DWORD count; BOOL removing; } update_tree_snapshot;
/* Existing Git configuration is immutable during a fixed offline relocation.
 * These read handles outlive parsing and every Git descendant. Final output
 * hashing reuses their identities; unchanged config bytes require no data write. */
static update_tree_snapshot native_import_configs;
typedef struct { DWORD entries; ULONGLONG bytes; HCRYPTHASH hash; BOOL flush; update_tree_snapshot *snapshot;
  const wchar_t *copyRoot; BOOL runtimeExclusions, seal; } update_tree_state;
static BOOL private_control_name(const wchar_t *name) {
  const wchar_t *fixed[]={L".DevRyan-publication.lock",L".DevRyan-publication.intent"};
  for(DWORD i=0;i<2;i++)if(!_wcsicmp(name,fixed[i])){
    if(wcscmp(name,fixed[i])){SetLastError(ERROR_INVALID_NAME);fail("copy publication control case alias");}return TRUE;}
  const wchar_t *prefix = L".DevRyan-publication-"; size_t length = wcslen(prefix);
  if (_wcsnicmp(name, prefix, length) || wcslen(name) < length + 33) return FALSE;
  for (DWORD i = 0; i < 32; i++) if (!(name[length + i] >= L'0' && name[length + i] <= L'9')
    && !(name[length + i] >= L'a' && name[length + i] <= L'f') && !(name[length+i]>=L'A'&&name[length+i]<=L'F')) return FALSE;
  const wchar_t *suffix = name + length + 32;
  const wchar_t *suffixes[]={L".receipt",L".backup",L".candidate"};
  for(DWORD i=0;i<3;i++)if(!_wcsicmp(suffix,suffixes[i])){
    BOOL canonical=!wcsncmp(name,prefix,length)&&!wcscmp(suffix,suffixes[i]);
    for(DWORD j=0;j<32;j++)if(name[length+j]>=L'A'&&name[length+j]<=L'F')canonical=FALSE;
    if(!canonical){SetLastError(ERROR_INVALID_NAME);fail("copy publication control case alias");}return TRUE;}
  return FALSE;
}
static BOOL runtime_copy_excluded(const wchar_t *relative) {
  if (!_wcsicmp(relative, L"orchestration\\owner.lock") || !_wcsicmp(relative, L"harness\\provider-recovery\\runtime-owner.lock")) return TRUE;
  const wchar_t *mutation = L"harness\\session-mutations\\"; size_t n = wcslen(mutation);
  if (!_wcsnicmp(relative, mutation, n) && wcslen(relative) > n + 64 && relative[n + 64] == L'\\') {
    BOOL hex = TRUE; for (DWORD i = 0; i < 64; i++) if (!(relative[n + i] >= L'0' && relative[n + i] <= L'9')
      && !(relative[n + i] >= L'a' && relative[n + i] <= L'f') && !(relative[n+i]>=L'A'&&relative[n+i]<=L'F')) hex = FALSE;
    const wchar_t *tail = relative + n + 65;
    if (hex && (!_wcsicmp(tail, L"context-cache") || !_wcsnicmp(tail, L"context-cache\\", 14)
      || !_wcsicmp(tail, L"owner.lock") || !_wcsnicmp(tail, L"git\\index", 9) && !wcschr(tail + 9, L'\\'))) return TRUE;
  }
  const wchar_t *prefixes[] = { L"harness\\provider-recovery\\", L"harness\\context\\" };
  for (DWORD i = 0; i < 2; i++) {
    n = wcslen(prefixes[i]); size_t length = wcslen(relative);
    if (!_wcsnicmp(relative, prefixes[i], n) && length > n + 5 && !wcschr(relative + n, L'\\') && !_wcsicmp(relative + length - 5, L".lock")) return TRUE;
  }
  const wchar_t *base = wcsrchr(relative, L'\\'); base = base ? base + 1 : relative;
  const wchar_t *temporary = wcsstr(base, L".tmp-");
  return temporary && temporary != base && temporary[5];
}
static BOOL copy_excluded(const wchar_t *source, const wchar_t *directory, const wchar_t *name, update_tree_state *state, HANDLE parent) {
  if (!state->copyRoot) return FALSE;
  if (private_control_name(name)) {
    const wchar_t *suffix = wcsrchr(name, L'.');
    if (suffix && !wcscmp(suffix, L".candidate")) { SetLastError(ERROR_IO_PENDING); fail("copy unsettled publication candidate"); }
    if (!wcscmp(name, L".DevRyan-publication.intent")) {
      wchar_t *target = joined(directory, L"copy-proof");
      HANDLE settled = require_no_publication(target, parent); if (settled) CloseHandle(settled); free(target);
    }
    return TRUE;
  }
  return state->runtimeExclusions && runtime_copy_excluded(source + wcslen(state->copyRoot) + 1);
}
static int update_name_order(const void *left, const void *right) {
  return wcscmp(*(const wchar_t * const *)left, *(const wchar_t * const *)right);
}
static HANDLE update_tree(const wchar_t *source, const wchar_t *destination, DWORD depth, update_tree_state *state, DWORD access) {
  if (depth > 64 || ++state->entries > 65536) { SetLastError(ERROR_FILE_TOO_LARGE); fail("update tree entry bound"); }
  DWORD removalAccess = state->snapshot && state->snapshot->removing ? DELETE | GENERIC_WRITE : 0;
  HANDLE input = INVALID_HANDLE_VALUE;BOOL immutableConfig=FALSE;
  size_t sourceLength=wcslen(source);
  if(native_import_configs.count&&sourceLength>=11&&!_wcsicmp(source+sourceLength-11,L"\\git\\config")){
    HANDLE probe=CreateFileW(source,FILE_READ_ATTRIBUTES|READ_CONTROL,FILE_SHARE_READ|FILE_SHARE_WRITE,NULL,OPEN_EXISTING,FILE_FLAG_OPEN_REPARSE_POINT,NULL);
    if(probe==INVALID_HANDLE_VALUE)fail("import final configuration identity");
    for(DWORD i=0;i<native_import_configs.count;i++)if(same_file(probe,native_import_configs.files[i])){
      checked(DuplicateHandle(GetCurrentProcess(),native_import_configs.files[i],GetCurrentProcess(),&input,0,FALSE,DUPLICATE_SAME_ACCESS),"import retained configuration hash");immutableConfig=TRUE;break;}
    CloseHandle(probe);
  }
  if(input==INVALID_HANDLE_VALUE)input = CreateFileW(source, GENERIC_READ | READ_CONTROL | access | removalAccess | (state->flush ? GENERIC_WRITE : 0) | (state->seal ? WRITE_DAC : 0), FILE_SHARE_READ, NULL, OPEN_EXISTING,
    FILE_FLAG_OPEN_REPARSE_POINT | FILE_FLAG_BACKUP_SEMANTICS, NULL);
  if (input == INVALID_HANDLE_VALUE) fail("update tree held input");
  if (state->snapshot) state->snapshot->files[state->snapshot->count++] = input;
  BY_HANDLE_FILE_INFORMATION info; BOOL own;
  checked(GetFileInformationByHandle(input, &info), "update tree identity");
  if ((info.dwFileAttributes & FILE_ATTRIBUTE_REPARSE_POINT) || !(depth ? file_privacy_mode(input, &own, TRUE) : file_privacy(input, &own))
    || !(info.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY) && info.nNumberOfLinks != 1) {
    SetLastError(ERROR_ACCESS_DENIED); fail("update tree private boundary");
  }
  BOOL directory = (info.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY) != 0;
  if (!depth && !directory) { SetLastError(ERROR_INVALID_DATA); fail("update installation directory"); }
  if (state->seal && !immutableConfig) {
    PSECURITY_DESCRIPTOR sealedSecurity = private_security(directory); BOOL present, defaulted; PACL dacl;
    checked(GetSecurityDescriptorDacl(sealedSecurity,&present,&dacl,&defaulted)&&present,"import output private DACL");
    DWORD error = SetSecurityInfo(input,SE_FILE_OBJECT,DACL_SECURITY_INFORMATION|PROTECTED_DACL_SECURITY_INFORMATION,NULL,NULL,dacl,NULL);
    LocalFree(sealedSecurity); if(error!=ERROR_SUCCESS){SetLastError(error);fail("import output retained private seal");}
    if(!file_privacy(input,&own)){SetLastError(ERROR_ACCESS_DENIED);fail("import output sealed privacy");}
  }
  BYTE kind = directory ? 1 : 0; checked(CryptHashData(state->hash, &kind, 1, 0), "update tree kind");
  PSECURITY_DESCRIPTOR security = destination ? private_security(directory) : NULL;
  SECURITY_ATTRIBUTES attributes = { sizeof(attributes), security, FALSE };
  if (directory) {
    HANDLE output = INVALID_HANDLE_VALUE;
    if (destination) {
      checked(CreateDirectoryW(destination, &attributes), "update exclusive snapshot directory");
      output = CreateFileW(destination, GENERIC_READ | GENERIC_WRITE | READ_CONTROL, FILE_SHARE_READ, NULL, OPEN_EXISTING,
        FILE_FLAG_OPEN_REPARSE_POINT | FILE_FLAG_BACKUP_SEMANTICS, NULL);
      if (output == INVALID_HANDLE_VALUE) fail("update snapshot directory handle");
    }
    wchar_t *pattern = joined(source, L"*"); WIN32_FIND_DATAW found;
    HANDLE search = FindFirstFileW(pattern, &found); free(pattern);
    wchar_t **names = calloc(65536, sizeof(wchar_t *)); DWORD count = 0;
    if (!names) fail("update tree name allocation");
    if (search != INVALID_HANDLE_VALUE) {
      do {
        if (!wcscmp(found.cFileName, L".") || !wcscmp(found.cFileName, L"..")) continue;
        if (count == 65536 || wcspbrk(found.cFileName, L"\\/:")) { SetLastError(ERROR_INVALID_DATA); fail("update tree name bound"); }
        wchar_t *childPath = joined(source, found.cFileName);
        BOOL excluded = copy_excluded(childPath, source, found.cFileName, state, input); free(childPath);
        if (excluded) continue;
        names[count] = _wcsdup(found.cFileName); if (!names[count++]) fail("update tree name copy");
      } while (FindNextFileW(search, &found));
      if (GetLastError() != ERROR_NO_MORE_FILES) fail("update tree enumeration");
      FindClose(search);
    } else if (GetLastError() != ERROR_FILE_NOT_FOUND) fail("update tree enumeration");
    qsort(names, count, sizeof(wchar_t *), update_name_order);
    checked(CryptHashData(state->hash, (BYTE *)&count, sizeof(count), 0), "update tree child count");
    for (DWORD i = 0; i < count; i++) {
      DWORD length = (DWORD)(wcslen(names[i]) * sizeof(wchar_t));
      checked(CryptHashData(state->hash, (BYTE *)&length, sizeof(length), 0)
        && CryptHashData(state->hash, (BYTE *)names[i], length, 0), "update tree child name");
      wchar_t *child = joined(source, names[i]), *copy = destination ? joined(destination, names[i]) : NULL;
      HANDLE held = update_tree(child, copy, depth + 1, state, 0); if (!state->snapshot) CloseHandle(held);
      free(child); free(copy); free(names[i]);
    }
    free(names);
    if (output != INVALID_HANDLE_VALUE) { checked(FlushFileBuffers(output), "update snapshot namespace durability"); CloseHandle(output); }
  } else {
    LARGE_INTEGER length, start = {0}; checked(GetFileSizeEx(input, &length), "update file size");
    if (length.QuadPart < 0 || state->bytes + (ULONGLONG)length.QuadPart > 8ULL * 1024 * 1024 * 1024) {
      SetLastError(ERROR_FILE_TOO_LARGE); fail("update tree byte bound");
    }
    state->bytes += (ULONGLONG)length.QuadPart;
    checked(CryptHashData(state->hash, (BYTE *)&length.QuadPart, sizeof(length.QuadPart), 0), "update tree file length");
    HANDLE output = INVALID_HANDLE_VALUE;
    if (destination) {
      output = CreateFileW(destination, GENERIC_WRITE | READ_CONTROL, 0, &attributes, CREATE_NEW,
        FILE_FLAG_OPEN_REPARSE_POINT | FILE_FLAG_WRITE_THROUGH, NULL);
      if (output == INVALID_HANDLE_VALUE) fail("update exclusive snapshot file");
    }
    BYTE buffer[65536]; DWORD read, written; ULONGLONG total = 0;
    checked(SetFilePointerEx(input, start, NULL, FILE_BEGIN), "update file position");
    for (;;) {
      checked(ReadFile(input, buffer, sizeof(buffer), &read, NULL), "update held file read"); if (!read) break;
      total += read; if (total > (ULONGLONG)length.QuadPart) { SetLastError(ERROR_INVALID_DATA); fail("update file changed"); }
      checked(CryptHashData(state->hash, buffer, read, 0), "update file hash");
      if (output != INVALID_HANDLE_VALUE) checked(WriteFile(output, buffer, read, &written, NULL) && written == read, "update snapshot write");
    }
    if (total != (ULONGLONG)length.QuadPart) { SetLastError(ERROR_INVALID_DATA); fail("update file truncated"); }
    if (output != INVALID_HANDLE_VALUE) { checked(FlushFileBuffers(output), "update snapshot data durability"); CloseHandle(output); }
  }
  if (state->flush && !immutableConfig) checked(FlushFileBuffers(input), directory ? "NSIS installed directory durability" : "NSIS installed file durability");
  if (security) LocalFree(security); return input;
}
static HANDLE hash_update_tree_policy(const wchar_t *source, const wchar_t *destination, DWORD access, wchar_t *token, BOOL flush, update_tree_snapshot *snapshot, BOOL filtering, BOOL runtimeExclusions, BOOL seal) {
  HCRYPTPROV provider; update_tree_state state = {0};
  state.flush = flush;
  state.snapshot = snapshot;
  state.copyRoot = filtering ? source : NULL; state.runtimeExclusions = runtimeExclusions;
  state.seal = seal;
  checked(CryptAcquireContextW(&provider, NULL, NULL, PROV_RSA_AES, CRYPT_VERIFYCONTEXT)
    && CryptCreateHash(provider, CALG_SHA_256, 0, 0, &state.hash), "update tree hash owner");
  HANDLE root = update_tree(source, destination, 0, &state, access);
  FILE_ID_INFO identity; BYTE digest[32]; DWORD length = 32;
  checked(GetFileInformationByHandleEx(root, FileIdInfo, &identity, sizeof(identity))
    && CryptGetHashParam(state.hash, HP_HASHVAL, digest, &length, 0) && length == 32, "update tree proof");
  swprintf(token, 160, L"%016llx:", (unsigned long long)identity.VolumeSerialNumber);
  for (DWORD i = 0; i < 16; i++) swprintf(token + 17 + i * 2, 160 - 17 - i * 2, L"%02x", (unsigned int)identity.FileId.Identifier[i]);
  token[49] = L':';
  for (DWORD i = 0; i < 32; i++) swprintf(token + 50 + i * 2, 160 - 50 - i * 2, L"%02x", (unsigned int)digest[i]);
  swprintf(token + 114, 46, L":%llu:%lu", (unsigned long long)state.bytes, state.entries);
  CryptDestroyHash(state.hash); CryptReleaseContext(provider, 0); return root;
}
static HANDLE hash_update_tree_options(const wchar_t *source, const wchar_t *destination, DWORD access, wchar_t *token, BOOL flush, update_tree_snapshot *snapshot, BOOL filtering, BOOL runtimeExclusions) {
  return hash_update_tree_policy(source,destination,access,token,flush,snapshot,filtering,runtimeExclusions,FALSE);
}
static HANDLE hash_update_tree_internal(const wchar_t *source, const wchar_t *destination, DWORD access, wchar_t *token, BOOL flush, update_tree_snapshot *snapshot) {
  return hash_update_tree_options(source, destination, access, token, flush, snapshot, FALSE, FALSE);
}
static HANDLE hash_update_tree(const wchar_t *source, const wchar_t *destination, DWORD access, wchar_t *token) {
  return hash_update_tree_internal(source, destination, access, token, FALSE, NULL);
}
static HANDLE hash_update_tree_mode(const wchar_t *source, const wchar_t *destination, DWORD access, wchar_t *token, BOOL flush) {
  return hash_update_tree_internal(source, destination, access, token, flush, NULL);
}
static int copy_private_tree(wchar_t **argv) {
  BOOL runtime = !wcscmp(argv[5], L"runtime-bundle");
  if (!runtime && wcscmp(argv[5], L"none")) return 125;
  wchar_t source[32768], destination[32768], token[160], filtered[160], copied[160];
  HANDLE sourceParents[256], destinationParents[256];
  DWORD destinationCount = anchor_parents_sharing(argv[3], destination, destinationParents, GENERIC_WRITE, FILE_SHARE_READ | FILE_SHARE_WRITE);
  DWORD sourceCount = anchor_parents_sharing(argv[2], source, sourceParents, 0, FILE_SHARE_READ | FILE_SHARE_WRITE);
  /* Read source, write destination. The global namespace mutex was acquired
   * first; parent guards fail immediately, so aliases never create a wait cycle. */
  HANDLE sourceParent = sourceParents[sourceCount - 1], destinationParent = destinationParents[destinationCount - 1];
  BOOL sameParent = same_file(sourceParent, destinationParent);
  HANDLE sourceGuard = publication_guard(source, sourceParent, sameParent);
  HANDLE destinationGuard = sameParent ? NULL : publication_guard(destination, destinationParent, TRUE);
  for (DWORD i = 0; i < destinationCount; i++) {
    HANDLE sourceRoot = CreateFileW(source, FILE_READ_ATTRIBUTES | READ_CONTROL, FILE_SHARE_READ, NULL, OPEN_EXISTING,
      FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT, NULL);
    if (sourceRoot == INVALID_HANDLE_VALUE) fail("copy source root identity");
    BOOL overlaps = same_file(sourceRoot, destinationParents[i]); CloseHandle(sourceRoot);
    if (overlaps) { SetLastError(ERROR_INVALID_PARAMETER); fail("copy destination overlaps source"); }
  }
  checked(FlushFileBuffers(destinationParent), "private namespace durability prerequisite");
  update_tree_snapshot snapshot = {0}; snapshot.files = calloc(65536, sizeof(HANDLE));
  if (!snapshot.files) fail("copy retained source allocation");
  hash_update_tree_options(source, NULL, 0, token, FALSE, &snapshot, TRUE, runtime);
  if (wcscmp(token, argv[4])) { SetLastError(ERROR_INVALID_DATA); fail("copy source compare and swap"); }
  HANDLE input = hash_update_tree_options(source, destination, 0, filtered, FALSE, NULL, TRUE, runtime); CloseHandle(input);
  if (wcscmp(token, filtered)) { SetLastError(ERROR_INVALID_DATA); fail("copy source changed during snapshot"); }
  update_tree_snapshot destinationSnapshot = {0}; destinationSnapshot.files = calloc(65536,sizeof(HANDLE));
  if (!destinationSnapshot.files) fail("copy retained destination allocation");
  hash_update_tree_internal(destination, NULL, 0, copied, FALSE, &destinationSnapshot);
  if (wcscmp(filtered + 50, copied + 50)) { SetLastError(ERROR_INVALID_DATA); fail("copy filtered content proof"); }
  FILE_ID_INFO left, right;
  checked(GetFileInformationByHandleEx(sourceParent, FileIdInfo, &left, sizeof(left)), "copy source parent identity");
  checked(GetFileInformationByHandleEx(destinationParent, FileIdInfo, &right, sizeof(right)), "copy destination parent identity");
  checked(FlushFileBuffers(destinationParent), "copy namespace durability");
  printf("{\"protocol\":\"devryan.windows-private-tree-copy/1\",\"sourceToken\":\"%ls\",\"destinationToken\":\"%ls\",\"sourceParentVolume\":\"%016llx\",\"sourceParentFileId\":\"", token, copied, (unsigned long long)left.VolumeSerialNumber);
  for (DWORD i = 0; i < 16; i++) printf("%02x", (unsigned int)left.FileId.Identifier[i]);
  printf("\",\"destinationParentVolume\":\"%016llx\",\"destinationParentFileId\":\"", (unsigned long long)right.VolumeSerialNumber);
  for (DWORD i = 0; i < 16; i++) printf("%02x", (unsigned int)right.FileId.Identifier[i]);
  printf("\",\"namespaceFlushed\":true,\"exclusions\":\"%s\"}\n", runtime ? "runtime-bundle" : "none");
  for (DWORD i = 0; i < destinationSnapshot.count; i++) CloseHandle(destinationSnapshot.files[i]); free(destinationSnapshot.files);
  for (DWORD i = 0; i < snapshot.count; i++) CloseHandle(snapshot.files[i]); free(snapshot.files);
  CloseHandle(sourceGuard); if(destinationGuard) CloseHandle(destinationGuard);
  for (DWORD i = 0; i < sourceCount; i++) CloseHandle(sourceParents[i]);
  for (DWORD i = 0; i < destinationCount; i++) CloseHandle(destinationParents[i]); return 0;
}
static int inspect_copy_tree(wchar_t **argv) {
  BOOL runtime = !wcscmp(argv[3], L"runtime-bundle");
  if (!runtime && wcscmp(argv[3], L"none")) return 125;
  wchar_t source[32768], token[160]; HANDLE parents[256]; DWORD count = anchor_parents(argv[2], source, parents);
  HANDLE guard = publication_guard(source, parents[count - 1], FALSE);
  HANDLE root = hash_update_tree_options(source, NULL, 0, token, FALSE, NULL, TRUE, runtime);
  printf("{\"protocol\":\"devryan.windows-update-tree/1\",\"token\":\"%ls\",\"namespaceFlushed\":false}\n", token);
  CloseHandle(root); CloseHandle(guard); for (DWORD i = 0; i < count; i++) CloseHandle(parents[i]); return 0;
}
static void update_file_token(HANDLE file, wchar_t *token, ULONGLONG *size);
static void sqlite_output_inventory(const wchar_t *root, const wchar_t *basename) {
  wchar_t *pattern = joined(root, L"*"); WIN32_FIND_DATAW found;
  HANDLE search = FindFirstFileW(pattern, &found); free(pattern);
  if (search == INVALID_HANDLE_VALUE) fail("sqlite output inventory");
  DWORD files = 0;
  do {
    if (!wcscmp(found.cFileName, L".") || !wcscmp(found.cFileName, L"..")) continue;
    if (!wcscmp(found.cFileName, basename)) { files++; continue; }
    if (!wcscmp(found.cFileName, L".DevRyan-publication.lock")) continue;
    SetLastError(ERROR_INVALID_DATA); fail("sqlite output unexpected namespace");
  } while (FindNextFileW(search, &found));
  if (GetLastError() != ERROR_NO_MORE_FILES || files != 1) { SetLastError(ERROR_INVALID_DATA); fail("sqlite output exact namespace"); }
  FindClose(search);
}
static int hold_sqlite_output(wchar_t **argv) {
  if (!*argv[3] || wcslen(argv[3]) > 255 || wcspbrk(argv[3], L"\\/:") || !wcscmp(argv[3], L".") || !wcscmp(argv[3], L"..")) return 125;
  wchar_t *requested = joined(argv[2], argv[3]), target[32768]; HANDLE parents[256];
  DWORD count = anchor_parents_access(requested, target, parents, GENERIC_WRITE); free(requested);
  HANDLE parent = parents[count - 1], guard = publication_guard(target, parent, TRUE);
  checked(FlushFileBuffers(parent), "private namespace durability prerequisite");
  PSECURITY_DESCRIPTOR security = private_security(FALSE); SECURITY_ATTRIBUTES attributes = {sizeof(attributes), security, FALSE};
  /* Attribute/security access and read/write sharing allow SQLite to fill this
   * exact empty identity; absent delete sharing prevents replacement. */
  HANDLE initial = CreateFileW(target, GENERIC_WRITE | FILE_READ_ATTRIBUTES | READ_CONTROL, FILE_SHARE_READ | FILE_SHARE_WRITE, &attributes, CREATE_NEW,
    FILE_FLAG_OPEN_REPARSE_POINT | FILE_FLAG_WRITE_THROUGH, NULL); LocalFree(security);
  if (initial == INVALID_HANDLE_VALUE) fail("sqlite exclusive empty output");
  HANDLE identity = CreateFileW(target, FILE_READ_ATTRIBUTES | READ_CONTROL, FILE_SHARE_READ | FILE_SHARE_WRITE, NULL, OPEN_EXISTING,
    FILE_FLAG_OPEN_REPARSE_POINT, NULL);
  if (identity == INVALID_HANDLE_VALUE || !same_file(initial, identity)) { SetLastError(ERROR_INVALID_DATA); fail("sqlite initial retained identity"); }
  checked(FlushFileBuffers(initial) && FlushFileBuffers(parent), "sqlite empty output durability"); CloseHandle(initial);
  require_private_file(identity); sqlite_output_inventory(argv[2], argv[3]);
  DWORD keeperPid; HANDLE keeper = parent_process(&keeperPid), input = GetStdHandle(STD_INPUT_HANDLE);
  if (GetFileType(input) != FILE_TYPE_PIPE) { SetLastError(ERROR_INVALID_HANDLE); fail("sqlite output lifetime pipe"); }
  release_private_namespace_mutex();
  printf("{\"protocol\":\"devryan.windows-sqlite-output/1\",\"status\":\"held\"}\n"); fflush(stdout);
  ULONGLONG deadline = GetTickCount64() + 120000; BOOL commit = FALSE; BYTE command[7]; DWORD commandBytes = 0;
  for (;;) {
    DWORD status = WaitForSingleObject(keeper, 25), available = 0;
    if (status == WAIT_OBJECT_0) { SetLastError(ERROR_OPERATION_ABORTED); fail("sqlite keeper exited"); }
    if (status != WAIT_TIMEOUT) fail("sqlite keeper lifetime");
    if (GetTickCount64() >= deadline) { SetLastError(ERROR_TIMEOUT); fail("sqlite output deadline"); }
    if (!PeekNamedPipe(input, NULL, 0, NULL, &available, NULL)) {
      if (GetLastError() == ERROR_BROKEN_PIPE || GetLastError() == ERROR_PIPE_NOT_CONNECTED) break;
      fail("sqlite output input");
    }
    if (!available) continue;
    if (available > sizeof(command) - commandBytes) { SetLastError(ERROR_INVALID_DATA); fail("sqlite output command bound"); }
    DWORD read; checked(ReadFile(input, command + commandBytes, available, &read, NULL) && read, "sqlite output command"); commandBytes += read;
    if (commandBytes < sizeof(command)) continue;
    if (!memcmp(command, "commit\n", 7)) { commit = TRUE; break; }
    if (!memcmp(command, "cancel\n", 7)) break;
    SetLastError(ERROR_INVALID_DATA); fail("sqlite output protocol");
  }
  if (commit) {
    HANDLE output = CreateFileW(target, GENERIC_READ | GENERIC_WRITE | READ_CONTROL, FILE_SHARE_READ, NULL, OPEN_EXISTING,
      FILE_FLAG_OPEN_REPARSE_POINT | FILE_FLAG_WRITE_THROUGH, NULL);
    if (output == INVALID_HANDLE_VALUE) fail("sqlite output writer settlement");
    require_private_file(output);
    if (!same_file(identity, output)) { SetLastError(ERROR_INVALID_DATA); fail("sqlite output identity changed"); }
    sqlite_output_inventory(argv[2], argv[3]);
    BYTE header[16]; DWORD read; LARGE_INTEGER databaseLength;
    checked(GetFileSizeEx(output, &databaseLength) && databaseLength.QuadPart >= 100 && ReadFile(output, header, sizeof(header), &read, NULL) && read == sizeof(header)
      && !memcmp(header, "SQLite format 3\0", sizeof(header)), "sqlite output database header");
    checked(FlushFileBuffers(output) && FlushFileBuffers(parent), "sqlite output data namespace durability");
    wchar_t token[160]; ULONGLONG size; update_file_token(output, token, &size);
    printf("{\"protocol\":\"devryan.windows-update-file/1\",\"token\":\"%ls\",\"size\":%llu}\n", token, (unsigned long long)size);
    CloseHandle(output);
  }
  CloseHandle(identity); CloseHandle(guard); CloseHandle(keeper);
  for (DWORD i = 0; i < count; i++) CloseHandle(parents[i]); return commit ? 0 : 125;
}

/* Offline importer ownership is deliberately separate from LPAC command
 * admission. Only the verified compiled controller and fixed migration argv
 * may run here; no caller-selected shell/command or ambient environment. */
static void native_import_job_name(const wchar_t *nonce, wchar_t *name) {
  if(wcslen(nonce)!=32){SetLastError(ERROR_INVALID_PARAMETER);fail("import nonce bound");}
  for(DWORD i=0;i<32;i++)if(!(nonce[i]>=L'0'&&nonce[i]<=L'9')&&!(nonce[i]>=L'a'&&nonce[i]<=L'f')){SetLastError(ERROR_INVALID_PARAMETER);fail("import nonce syntax");}
  TOKEN_USER *user=current_user();LPWSTR sid;checked(ConvertSidToStringSidW(user->User.Sid,&sid),"import user identity");
  int length=swprintf(name,256,L"Global\\DevRyan-Native-Import-%s-%s",sid,nonce);
  LocalFree(sid);free(user);if(length<1||length>=256){SetLastError(ERROR_INVALID_PARAMETER);fail("import job name bound");}
}
static int inspect_native_import_child(const wchar_t *nonce) {
  wchar_t name[256];native_import_job_name(nonce,name);
  HANDLE job=OpenJobObjectW(JOB_OBJECT_QUERY|READ_CONTROL,FALSE,name);if(!job)fail("import child job handle");
  BOOL own;if(!private_object_privacy(job,&own,FALSE,SE_KERNEL_OBJECT)){SetLastError(ERROR_ACCESS_DENIED);fail("import child private job");}
  DWORD pid;HANDLE parent=parent_process(&pid);BOOL inJob;
  checked(IsProcessInJob(parent,job,&inJob),"import child exact job membership");
  JOBOBJECT_EXTENDED_LIMIT_INFORMATION limits={0};
  checked(QueryInformationJobObject(job,JobObjectExtendedLimitInformation,&limits,sizeof(limits),NULL),"import child job policy");
  DWORD expected=JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE|JOB_OBJECT_LIMIT_DIE_ON_UNHANDLED_EXCEPTION;
  if(!inJob||limits.BasicLimitInformation.LimitFlags!=expected){SetLastError(ERROR_ACCESS_DENIED);fail("import child owned job policy");}
  FILETIME created,exited,kernel,user;checked(GetProcessTimes(parent,&created,&exited,&kernel,&user),"import child creation identity");
  printf("{\"protocol\":\"devryan.windows-native-import-child/1\",\"nonce\":\"%ls\",\"pid\":%lu,\"startIdentity\":\"win32:%08lx%08lx\",\"inJob\":true,\"jobOwned\":true,\"admission\":false}\n",nonce,pid,created.dwHighDateTime,created.dwLowDateTime);
  CloseHandle(parent);CloseHandle(job);return 0;
}
typedef struct { HANDLE input; const BYTE *bytes; DWORD length, error; } native_import_input;
static DWORD WINAPI write_native_import_input(void *argument) {
  native_import_input *state=argument;DWORD position=0;
  while(position<state->length){DWORD written,amount=state->length-position;if(amount>65536)amount=65536;
    if(!WriteFile(state->input,state->bytes+position,amount,&written,NULL)||written!=amount){state->error=GetLastError();if(!state->error)state->error=ERROR_WRITE_FAULT;break;}position+=written;}
  CloseHandle(state->input);state->input=NULL;return 0;
}
typedef struct { HANDLE input; BYTE *bytes; DWORD length; BOOL eof; } native_import_output;
static void read_native_import_output(native_import_output *state) {
  if(state->eof)return;DWORD available;
  if(!PeekNamedPipe(state->input,NULL,0,NULL,&available,NULL)){
    if(GetLastError()==ERROR_BROKEN_PIPE||GetLastError()==ERROR_PIPE_NOT_CONNECTED){state->eof=TRUE;return;}fail("import output pipe");}
  while(available){
    DWORD amount=available>65536?65536:available,read;
    if(amount>1048576-state->length){SetLastError(ERROR_FILE_TOO_LARGE);fail("import output byte bound");}
    checked(ReadFile(state->input,state->bytes+state->length,amount,&read,NULL)&&read,"import output read");state->length+=read;
    if(!PeekNamedPipe(state->input,NULL,0,NULL,&available,NULL)){
      if(GetLastError()==ERROR_BROKEN_PIPE||GetLastError()==ERROR_PIPE_NOT_CONNECTED){state->eof=TRUE;return;}fail("import output remaining");}
  }
}
static void retire_import_intent(const wchar_t *root,const wchar_t *relative) {
  wchar_t *directory=joined(root,relative),*probe=joined(directory,L"import-publication-proof"),target[32768];HANDLE parents[256];
  DWORD attributes=GetFileAttributesW(directory);
  if(attributes==INVALID_FILE_ATTRIBUTES&&(GetLastError()==ERROR_FILE_NOT_FOUND||GetLastError()==ERROR_PATH_NOT_FOUND)){free(directory);free(probe);return;}
  DWORD count=anchor_parents_sharing(probe,target,parents,GENERIC_WRITE,FILE_SHARE_READ|FILE_SHARE_WRITE);
  HANDLE parent=parents[count-1],guard=publication_guard(target,parent,TRUE);
  wchar_t *intentPath=publication_path(target,L".DevRyan-publication.intent");
  HANDLE intentFile=open_publication_file(intentPath,OPEN_EXISTING,DELETE);publication_intent intent={0};
  if(read_intent(intentFile,parent,&intent)){
    HANDLE settled=require_settled_intent(target,parent,&intent);if(settled)CloseHandle(settled);
    checked(FlushFileBuffers(parent),"import settled authority retirement prerequisite");
    FILE_DISPOSITION_INFO disposition={TRUE};checked(SetFileInformationByHandle(intentFile,FileDispositionInfo,&disposition,sizeof(disposition)),"import settled retained intent retirement");
    CloseHandle(intentFile);intentFile=NULL;checked(FlushFileBuffers(parent),"import settled authority retirement durability");
  }
  if(intentFile)CloseHandle(intentFile);CloseHandle(guard);free(intentPath);free(directory);free(probe);for(DWORD i=0;i<count;i++)CloseHandle(parents[i]);
}
static BOOL canonical_import_key(const wchar_t *name) {
  if(wcslen(name)!=64)return FALSE;for(DWORD i=0;i<64;i++)if(!(name[i]>=L'0'&&name[i]<=L'9')&&!(name[i]>=L'a'&&name[i]<=L'f'))return FALSE;return TRUE;
}
static void hold_import_configs(const wchar_t *root,BOOL retire) {
  wchar_t *directory=joined(root,L"harness\\session-mutations"),*pattern=joined(directory,L"*");WIN32_FIND_DATAW found;
  HANDLE search=FindFirstFileW(pattern,&found);free(pattern);
  if(search==INVALID_HANDLE_VALUE){DWORD error=GetLastError();free(directory);if(error==ERROR_FILE_NOT_FOUND||error==ERROR_PATH_NOT_FOUND)return;SetLastError(error);fail("import Git directory inventory");}
  native_import_configs.files=calloc(65536,sizeof(HANDLE));if(!native_import_configs.files)fail("import retained Git configs allocation");
  do{
    if(!wcscmp(found.cFileName,L".")||!wcscmp(found.cFileName,L"..")||private_control_name(found.cFileName))continue;
    if(!(found.dwFileAttributes&FILE_ATTRIBUTE_DIRECTORY)||found.dwFileAttributes&FILE_ATTRIBUTE_REPARSE_POINT||!canonical_import_key(found.cFileName)){
      SetLastError(ERROR_INVALID_DATA);fail("import canonical Git change namespace");}
    wchar_t relative[128];swprintf(relative,128,L"harness\\session-mutations\\%s",found.cFileName);
    if(retire)retire_import_intent(root,relative);
    wchar_t *change=joined(directory,found.cFileName),*config=joined(change,L"git\\config"),canonical[32768];HANDLE parents[256];
    DWORD attributes=GetFileAttributesW(config);
    if(attributes==INVALID_FILE_ATTRIBUTES&&(GetLastError()==ERROR_FILE_NOT_FOUND||GetLastError()==ERROR_PATH_NOT_FOUND)){free(change);free(config);continue;}
    DWORD count=anchor_parents_sharing(config,canonical,parents,0,FILE_SHARE_READ|FILE_SHARE_WRITE);
    HANDLE file=open_publication_file(canonical,OPEN_EXISTING,0);if(!file){SetLastError(ERROR_FILE_NOT_FOUND);fail("import Git config disappeared");}
    if(native_import_configs.count==65536){SetLastError(ERROR_FILE_TOO_LARGE);fail("import retained Git configs bound");}
    native_import_configs.files[native_import_configs.count++]=file;
    for(DWORD i=0;i<count;i++)CloseHandle(parents[i]);free(change);free(config);
  }while(FindNextFileW(search,&found));
  if(GetLastError()!=ERROR_NO_MORE_FILES)fail("import Git config enumeration");FindClose(search);free(directory);
}
static void prepare_import_environment_directory(const wchar_t *requested) {
  wchar_t canonical[32768];HANDLE parents[256];DWORD count=anchor_parents_sharing(requested,canonical,parents,GENERIC_WRITE,FILE_SHARE_READ|FILE_SHARE_WRITE);
  BOOL own;if(!file_privacy(parents[count-1],&own)){SetLastError(ERROR_ACCESS_DENIED);fail("import private environment parent");}
  PSECURITY_DESCRIPTOR security=private_security(TRUE);SECURITY_ATTRIBUTES attributes={sizeof(attributes),security,FALSE};
  if(!CreateDirectoryW(canonical,&attributes)&&GetLastError()!=ERROR_ALREADY_EXISTS)fail("import protected environment creation");LocalFree(security);
  HANDLE directory=CreateFileW(canonical,GENERIC_READ|GENERIC_WRITE|READ_CONTROL,FILE_SHARE_READ|FILE_SHARE_WRITE,NULL,OPEN_EXISTING,FILE_FLAG_BACKUP_SEMANTICS|FILE_FLAG_OPEN_REPARSE_POINT,NULL);
  if(directory==INVALID_HANDLE_VALUE)fail("import held environment directory");BY_HANDLE_FILE_INFORMATION info;
  checked(GetFileInformationByHandle(directory,&info),"import environment directory identity");
  if(!(info.dwFileAttributes&FILE_ATTRIBUTE_DIRECTORY)||info.dwFileAttributes&FILE_ATTRIBUTE_REPARSE_POINT||!file_privacy(directory,&own)){SetLastError(ERROR_ACCESS_DENIED);fail("import protected environment boundary");}
  checked(FlushFileBuffers(directory)&&FlushFileBuffers(parents[count-1]),"import environment creation durability");CloseHandle(directory);for(DWORD i=0;i<count;i++)CloseHandle(parents[i]);
}
static wchar_t *native_import_environment(const wchar_t *root,const wchar_t *environmentRoot,const wchar_t *operation,const wchar_t *exclusions,BOOL mutating) {
  wchar_t windows[32768];UINT length=GetWindowsDirectoryW(windows,32768);
  if(!length||length>=32768){SetLastError(ERROR_INVALID_DATA);fail("import OS loader root");}
  /* Windows requires this block to be sorted, case-insensitively. */
  const wchar_t *names[]={L"DEVRYAN_NATIVE_IMPORT_ENVIRONMENT_ROOT",L"DEVRYAN_NATIVE_IMPORT_MUTATING",L"DEVRYAN_NATIVE_IMPORT_OPERATION",L"DEVRYAN_NATIVE_IMPORT_ROOT",L"DEVRYAN_NATIVE_IMPORT_ROOT_EXCLUSIONS",
    L"GIT_CONFIG_GLOBAL",L"GIT_CONFIG_NOSYSTEM",L"GIT_CONFIG_SYSTEM",L"GIT_TERMINAL_PROMPT",L"HOME",L"LANG",L"SystemRoot",L"TEMP",L"TMP",L"USERPROFILE",L"WINDIR",L"XDG_CACHE_HOME",L"XDG_CONFIG_HOME",L"XDG_DATA_HOME",L"XDG_STATE_HOME"};
  const wchar_t *relative[]={NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,L"global\\home",NULL,NULL,L"global\\tmp",L"global\\tmp",L"global\\home",NULL,L"global\\cache",L"global\\config",L"global\\data",L"global\\state"};
  size_t capacity=(wcslen(root)+wcslen(environmentRoot)+wcslen(windows)+128)*20+2;
  wchar_t *environment=calloc(capacity,sizeof(wchar_t));if(!environment)fail("import environment allocation");
  size_t position=0;
  for(DWORD i=0;i<20;i++){
    wchar_t *local=relative[i]?joined(environmentRoot,relative[i]):NULL;
    const wchar_t *value=local?local:i==0?environmentRoot:i==1?mutating?L"1":L"0":i==2?operation:i==3?root:i==4?exclusions:i==5||i==7?L"NUL":i==6?L"1":i==8?L"0":i==10?L"C.UTF-8":windows;
    int written=swprintf(environment+position,capacity-position,L"%s=%s",names[i],value);free(local);
    if(written<1||(size_t)written>=capacity-position){SetLastError(ERROR_INVALID_DATA);fail("import environment bound");}position+=(size_t)written+1;
  }
  /* The zero-filled allocation provides the required double terminator. */
  return environment;
}
static int hold_native_import(wchar_t **argv) {
  BOOL relocation=!wcscmp(argv[9],L"relocate-bundle-harness"),runtime=!wcscmp(argv[10],L"runtime-bundle"),mutating=!wcscmp(argv[11],L"1");
  if(!relocation&&wcscmp(argv[9],L"migrate")||!runtime&&wcscmp(argv[10],L"none")||!mutating&&wcscmp(argv[11],L"0")
    ||relocation!=runtime||!relocation&&!mutating)return 125;
  wchar_t jobName[256];native_import_job_name(argv[8],jobName);
  if(wcslen(argv[3])!=64)return 125;
  wchar_t controller[32768],root[32768],receiptPath[32768];HANDLE controllerParents[256],rootParents[256],receiptParents[256];
  DWORD controllerCount=anchor_parents_sharing(argv[2],controller,controllerParents,0,FILE_SHARE_READ|FILE_SHARE_WRITE);
  DWORD rootCount=anchor_parents_sharing(argv[5],root,rootParents,GENERIC_WRITE,FILE_SHARE_READ|FILE_SHARE_WRITE);
  DWORD receiptCount=anchor_parents_sharing(argv[7],receiptPath,receiptParents,GENERIC_WRITE,FILE_SHARE_READ|FILE_SHARE_WRITE);
  wchar_t receiptName[40];swprintf(receiptName,40,L"%s.json",argv[8]);
  if(wcscmp(wcsrchr(receiptPath,L'\\')+1,receiptName)){SetLastError(ERROR_INVALID_PARAMETER);fail("import fixed native receipt name");}
  wchar_t artifactRoot[32768];wcscpy(artifactRoot,controller);*wcsrchr(artifactRoot,L'\\')=0;
  const wchar_t *controllerName=wcsrchr(controller,L'\\')+1;
  if(wcsncmp(controllerName,L"DevRyan-native-controller",25)||wcslen(controllerName)<29||wcscmp(controllerName+wcslen(controllerName)-4,L".exe")){SetLastError(ERROR_INVALID_PARAMETER);fail("import fixed controller identity");}
  HANDLE rootParent=rootParents[rootCount-1],receiptParent=receiptParents[receiptCount-1];BOOL own;
  if(!file_privacy(rootParent,&own)||!file_privacy(receiptParent,&own)){SetLastError(ERROR_ACCESS_DENIED);fail("import private namespace parents");}
  HANDLE rootGuard=publication_guard(root,rootParent,TRUE);
  HANDLE receiptGuard=same_file(rootParent,receiptParent)?NULL:publication_guard(receiptPath,receiptParent,TRUE);
  checked(FlushFileBuffers(rootParent)&&FlushFileBuffers(receiptParent),"private namespace durability prerequisite");
  HANDLE receiptExisting=open_publication_file(receiptPath,OPEN_EXISTING,0);if(receiptExisting){SetLastError(ERROR_ALREADY_EXISTS);fail("import receipt requires absence");}
  update_tree_snapshot artifacts={0};artifacts.files=calloc(65536,sizeof(HANDLE));if(!artifacts.files)fail("import artifact retained allocation");
  wchar_t artifactToken[160];hash_update_tree_internal(artifactRoot,NULL,0,artifactToken,FALSE,&artifacts);
  if(wcscmp(artifactToken,argv[4])){SetLastError(ERROR_INVALID_DATA);fail("import artifact inventory compare and swap");}
  HANDLE image=open_publication_file(controller,OPEN_EXISTING,0);if(!image)fail("import controller file");
  ULONGLONG imageSize;BYTE imageHash[32];hash_file_bound(image,&imageSize,imageHash,8ULL*1024*1024*1024);
  wchar_t controllerToken[160];update_file_token(image,controllerToken,&imageSize);
  if(wcsncmp(controllerToken+50,argv[3],64)){SetLastError(ERROR_INVALID_DATA);fail("import accepted controller digest");}
  wchar_t initialToken[160];HANDLE initial=hash_update_tree_options(root,NULL,0,initialToken,FALSE,NULL,TRUE,runtime);
  if(wcscmp(initialToken,argv[6])){SetLastError(ERROR_INVALID_DATA);fail("import output root compare and swap");}
  HANDLE rootIdentity=CreateFileW(root,FILE_READ_ATTRIBUTES|READ_CONTROL,FILE_SHARE_READ|FILE_SHARE_WRITE,NULL,OPEN_EXISTING,
    FILE_FLAG_BACKUP_SEMANTICS|FILE_FLAG_OPEN_REPARSE_POINT,NULL);
  if(rootIdentity==INVALID_HANDLE_VALUE||!same_file(initial,rootIdentity)){SetLastError(ERROR_INVALID_DATA);fail("import retained output root");}CloseHandle(initial);
  /* The mutable output root and final receipt must be outside the retained
   * executable tree; check held identities rather than spelling prefixes. */
  for(DWORD i=0;i<artifacts.count;i++)if(same_file(artifacts.files[i],rootIdentity)||same_file(artifacts.files[i],rootParent)||same_file(artifacts.files[i],receiptParent)){
    SetLastError(ERROR_INVALID_PARAMETER);fail("import artifact output overlap");}
  for(DWORD i=0;i<receiptCount;i++)if(same_file(rootIdentity,receiptParents[i])){SetLastError(ERROR_INVALID_PARAMETER);fail("import receipt inside output root");}
  for(DWORD i=0;i<controllerCount;i++)if(same_file(rootIdentity,controllerParents[i])){SetLastError(ERROR_INVALID_PARAMETER);fail("import output contains artifacts");}
  wchar_t environmentRoot[32768];HANDLE environmentParents[256];DWORD environmentCount=0;HANDLE environmentIdentity=NULL,environmentGuard=NULL;
  BOOL separateEnvironment=wcscmp(argv[12],argv[5])!=0;
  if(relocation&&!separateEnvironment){SetLastError(ERROR_INVALID_PARAMETER);fail("import relocation isolated environment required");}
  if(separateEnvironment){
    environmentCount=anchor_parents_sharing(argv[12],environmentRoot,environmentParents,GENERIC_WRITE,FILE_SHARE_READ|FILE_SHARE_WRITE);
    environmentGuard=publication_guard(environmentRoot,environmentParents[environmentCount-1],TRUE);
    wchar_t emptyToken[160];HANDLE empty=hash_update_tree(environmentRoot,NULL,0,emptyToken);
    const wchar_t *counts=wcsrchr(emptyToken,L':');if(!counts||wcscmp(counts,L":1")){SetLastError(ERROR_INVALID_DATA);fail("import fresh isolated environment");}
    environmentIdentity=CreateFileW(environmentRoot,FILE_READ_ATTRIBUTES|READ_CONTROL,FILE_SHARE_READ|FILE_SHARE_WRITE,NULL,OPEN_EXISTING,FILE_FLAG_BACKUP_SEMANTICS|FILE_FLAG_OPEN_REPARSE_POINT,NULL);
    if(environmentIdentity==INVALID_HANDLE_VALUE||!same_file(empty,environmentIdentity)){SetLastError(ERROR_INVALID_DATA);fail("import retained isolated environment identity");}CloseHandle(empty);
    for(DWORD i=0;i<artifacts.count;i++)if(same_file(artifacts.files[i],environmentIdentity)||same_file(artifacts.files[i],environmentParents[environmentCount-1])){SetLastError(ERROR_INVALID_PARAMETER);fail("import environment artifact overlap");}
    for(DWORD i=0;i<environmentCount;i++)if(same_file(rootIdentity,environmentParents[i])){SetLastError(ERROR_INVALID_PARAMETER);fail("import environment source overlap");}
  }else wcscpy(environmentRoot,root);
  wchar_t gitToken[160]={0};
  if(relocation){
    wchar_t *git=joined(artifactRoot,L"git\\cmd\\git.exe");HANDLE gitFile=open_publication_file(git,OPEN_EXISTING,0);free(git);if(!gitFile)fail("import reviewed Git executable required");
    ULONGLONG gitSize;update_file_token(gitFile,gitToken,&gitSize);CloseHandle(gitFile);
    hold_import_configs(root,FALSE);
    if(mutating){const wchar_t *parents[]={L"orchestration",L"harness\\provider-recovery",L"harness\\context",L"harness\\evidence\\records"};
      for(DWORD i=0;i<4;i++)retire_import_intent(root,parents[i]);
      /* Config identity remains held while retiring only its record parent. */
      wchar_t *changes=joined(root,L"harness\\session-mutations"),*pattern=joined(changes,L"*");WIN32_FIND_DATAW found;HANDLE search=FindFirstFileW(pattern,&found);free(pattern);
      if(search!=INVALID_HANDLE_VALUE){do{if(canonical_import_key(found.cFileName)){wchar_t relative[128];swprintf(relative,128,L"harness\\session-mutations\\%s",found.cFileName);retire_import_intent(root,relative);}}while(FindNextFileW(search,&found));
        if(GetLastError()!=ERROR_NO_MORE_FILES)fail("import settled Git record inventory");FindClose(search);}else if(GetLastError()!=ERROR_FILE_NOT_FOUND&&GetLastError()!=ERROR_PATH_NOT_FOUND)fail("import settled Git record inventory");free(changes);
    }
  }else retire_import_intent(root,L"sources");
  wchar_t *global=joined(environmentRoot,L"global");prepare_import_environment_directory(global);
  const wchar_t *globals[]={L"home",L"data",L"config",L"state",L"cache",L"tmp",L"bin",L"log",L"repos"};
  for(DWORD i=0;i<9;i++){wchar_t *directory=joined(global,globals[i]);prepare_import_environment_directory(directory);free(directory);}free(global);
  DWORD keeperPid;HANDLE keeper=parent_process(&keeperPid),input=GetStdHandle(STD_INPUT_HANDLE);
  if(GetFileType(input)!=FILE_TYPE_PIPE){SetLastError(ERROR_INVALID_HANDLE);fail("import request lifetime pipe");}
  PSECURITY_DESCRIPTOR jobSecurity=private_security(FALSE);SECURITY_ATTRIBUTES attributes={sizeof(attributes),jobSecurity,FALSE};
  HANDLE job=CreateJobObjectW(&attributes,jobName);if(!job||GetLastError()==ERROR_ALREADY_EXISTS)fail("import exclusive job");active_job=job;
  JOBOBJECT_EXTENDED_LIMIT_INFORMATION limits={0};limits.BasicLimitInformation.LimitFlags=JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE|JOB_OBJECT_LIMIT_DIE_ON_UNHANDLED_EXCEPTION;
  checked(SetInformationJobObject(job,JobObjectExtendedLimitInformation,&limits,sizeof(limits)),"import job ownership");
  release_private_namespace_mutex();
  printf("{\"protocol\":\"devryan.windows-native-import/1\",\"status\":\"held\"}\n");fflush(stdout);
  BYTE *request=malloc(16*1024*1024);DWORD requestLength=0;ULONGLONG deadline=GetTickCount64()+120000;
  if(!request)fail("import request allocation");
  for(;;){DWORD status=WaitForSingleObject(keeper,25),available;
    if(status!=WAIT_TIMEOUT){SetLastError(ERROR_PROCESS_ABORTED);fail("import request keeper lost");}
    if(GetTickCount64()>=deadline){SetLastError(ERROR_TIMEOUT);fail("import request deadline");}
    if(!PeekNamedPipe(input,NULL,0,NULL,&available,NULL)){
      if(GetLastError()==ERROR_BROKEN_PIPE||GetLastError()==ERROR_PIPE_NOT_CONNECTED)break;fail("import request input");}
    if(!available)continue;DWORD amount=available>65536?65536:available,read;
    if(amount>16*1024*1024-requestLength){SetLastError(ERROR_FILE_TOO_LARGE);fail("import request byte bound");}
    checked(ReadFile(input,request+requestLength,amount,&read,NULL)&&read,"import request read");requestLength+=read;
  }
  if(!requestLength){SetLastError(ERROR_INVALID_DATA);fail("import empty request");}
  HANDLE token,restricted;checked(OpenProcessToken(GetCurrentProcess(),TOKEN_QUERY|TOKEN_DUPLICATE|TOKEN_ASSIGN_PRIMARY|TOKEN_ADJUST_DEFAULT,&token),"import current-user token");
  checked(CreateRestrictedToken(token,DISABLE_MAX_PRIVILEGE|LUA_TOKEN,0,NULL,0,NULL,0,NULL,&restricted),"import restricted current user");
  TOKEN_USER *identity=current_user();TOKEN_OWNER childOwner={identity->User.Sid};checked(SetTokenInformation(restricted,TokenOwner,&childOwner,sizeof(childOwner)),"import current-user file owner");
  BOOL present,defaulted;PACL dacl;checked(GetSecurityDescriptorDacl(jobSecurity,&present,&dacl,&defaulted)&&present,"import default private DACL");
  TOKEN_DEFAULT_DACL defaultDacl={dacl};checked(SetTokenInformation(restricted,TokenDefaultDacl,&defaultDacl,sizeof(defaultDacl)),"import child private creations");
  SECURITY_ATTRIBUTES inherited={sizeof(inherited),NULL,TRUE};HANDLE childHandles[3],hostInput,hostOutput,hostError;
  checked(CreatePipe(&childHandles[0],&hostInput,&inherited,65536),"import bounded stdin pipe");
  checked(CreatePipe(&hostOutput,&childHandles[1],&inherited,65536),"import bounded stdout pipe");
  checked(CreatePipe(&hostError,&childHandles[2],&inherited,65536),"import bounded stderr pipe");
  checked(SetHandleInformation(hostInput,HANDLE_FLAG_INHERIT,0)&&SetHandleInformation(hostOutput,HANDLE_FLAG_INHERIT,0)&&SetHandleInformation(hostError,HANDLE_FLAG_INHERIT,0),"import host handle isolation");
  STARTUPINFOEXW startup={0};startup.StartupInfo.cb=sizeof(startup);startup.StartupInfo.dwFlags=STARTF_USESTDHANDLES;
  startup.StartupInfo.hStdInput=childHandles[0];startup.StartupInfo.hStdOutput=childHandles[1];startup.StartupInfo.hStdError=childHandles[2];
  SIZE_T size=0;InitializeProcThreadAttributeList(NULL,2,0,&size);startup.lpAttributeList=malloc(size);if(!startup.lpAttributeList)fail("import attributes allocation");
  checked(InitializeProcThreadAttributeList(startup.lpAttributeList,2,0,&size)&&UpdateProcThreadAttribute(startup.lpAttributeList,0,PROC_THREAD_ATTRIBUTE_HANDLE_LIST,childHandles,sizeof(childHandles),NULL,NULL)
    &&UpdateProcThreadAttribute(startup.lpAttributeList,0,PROC_THREAD_ATTRIBUTE_JOB_LIST,&job,sizeof(job),NULL,NULL),"import atomic job and handle boundary");
  wchar_t *fixedArgs[]={controller,relocation?L"--relocate-bundle-harness":L"--migrate",L"--native-instance",argv[8]};
  wchar_t *command=command_line(4,fixedArgs,0),*environment=native_import_environment(root,environmentRoot,argv[9],argv[10],mutating);
  PROCESS_INFORMATION process={0};
  if(WaitForSingleObject(keeper,0)!=WAIT_TIMEOUT){SetLastError(ERROR_PROCESS_ABORTED);fail("import keeper lost before creation");}
  checked(CreateProcessAsUserW(restricted,controller,command,NULL,NULL,TRUE,CREATE_SUSPENDED|CREATE_NO_WINDOW|EXTENDED_STARTUPINFO_PRESENT|CREATE_UNICODE_ENVIRONMENT,
    environment,artifactRoot,&startup.StartupInfo,&process),"import fixed compiled process");
  for(DWORD i=0;i<3;i++)CloseHandle(childHandles[i]);
  native_import_input writer={hostInput,request,requestLength,0};HANDLE writerThread=CreateThread(NULL,0,write_native_import_input,&writer,0,NULL);if(!writerThread)fail("import input transfer owner");
  native_import_output output={hostOutput,malloc(1048576),0,FALSE},errors={hostError,malloc(1048576),0,FALSE};if(!output.bytes||!errors.bytes)fail("import output allocation");
  checked(ResumeThread(process.hThread)!=(DWORD)-1,"import process start");DWORD code=125;BOOL completed=FALSE;
  for(;;){read_native_import_output(&output);read_native_import_output(&errors);
    DWORD state=WaitForSingleObject(process.hProcess,10);
    if(state==WAIT_OBJECT_0){checked(GetExitCodeProcess(process.hProcess,&code),"import process result");completed=TRUE;break;}
    if(state!=WAIT_TIMEOUT)fail("import process lifetime");
    if(WaitForSingleObject(keeper,0)!=WAIT_TIMEOUT||GetTickCount64()>=deadline)break;
  }
  checked(TerminateJobObject(job,completed?code:125),"import descendants termination");ULONGLONG settlement=GetTickCount64()+5000;
  for(;;){JOBOBJECT_BASIC_ACCOUNTING_INFORMATION state;
    checked(QueryInformationJobObject(job,JobObjectBasicAccountingInformation,&state,sizeof(state),NULL),"import descendant settlement");
    if(!state.ActiveProcesses)break;if(GetTickCount64()>=settlement){SetLastError(ERROR_TIMEOUT);fail("import descendant settlement deadline");}Sleep(10);}
  if(WaitForSingleObject(writerThread,5000)!=WAIT_OBJECT_0){checked(CancelSynchronousIo(writerThread),"import input cancellation");checked(WaitForSingleObject(writerThread,5000)==WAIT_OBJECT_0,"import input thread settlement");}
  read_native_import_output(&output);read_native_import_output(&errors);
  if(!completed||code||writer.error||!output.eof||!errors.eof||WaitForSingleObject(keeper,0)!=WAIT_TIMEOUT){SetLastError(ERROR_PROCESS_ABORTED);fail("import successful owned completion");}
  update_tree_snapshot sealed={0};sealed.files=calloc(65536,sizeof(HANDLE));if(!sealed.files)fail("import sealed output allocation");
  wchar_t resultToken[160];HANDLE resultRoot=hash_update_tree_policy(root,NULL,0,resultToken,mutating,&sealed,TRUE,runtime,mutating);
  if(!same_file(resultRoot,rootIdentity)){SetLastError(ERROR_INVALID_DATA);fail("import final root identity");}
  checked(FlushFileBuffers(rootParent),"import output namespace durability");
  update_tree_snapshot sealedEnvironment={0};wchar_t environmentToken[160]={0};
  if(separateEnvironment){sealedEnvironment.files=calloc(65536,sizeof(HANDLE));if(!sealedEnvironment.files)fail("import sealed environment allocation");
    HANDLE sealedRoot=hash_update_tree_policy(environmentRoot,NULL,0,environmentToken,TRUE,&sealedEnvironment,FALSE,FALSE,TRUE);
    if(!same_file(environmentIdentity,sealedRoot)){SetLastError(ERROR_INVALID_DATA);fail("import final environment identity");}checked(FlushFileBuffers(environmentParents[environmentCount-1]),"import isolated environment namespace durability");}
  HANDLE receipt=open_publication_file(receiptPath,CREATE_NEW,GENERIC_WRITE);
  char gitValue[192],environmentValue[192];if(relocation)snprintf(gitValue,sizeof(gitValue),"\"%ls\"",gitToken);else strcpy(gitValue,"null");
  if(separateEnvironment)snprintf(environmentValue,sizeof(environmentValue),"\"%ls\"",environmentToken);else strcpy(environmentValue,"null");
  char result[1536];int length=snprintf(result,sizeof(result),"{\"protocol\":\"devryan.windows-native-import/1\",\"nonce\":\"%ls\",\"operation\":\"%ls\",\"rootExclusions\":\"%ls\",\"mutating\":%s,\"controllerToken\":\"%ls\",\"gitToken\":%s,\"rootToken\":\"%ls\",\"environmentToken\":%s,\"namespaceFlushed\":true,\"jobSettled\":true,\"exitCode\":0}\n",argv[8],argv[9],argv[10],mutating?"true":"false",controllerToken,gitValue,resultToken,environmentValue);
  DWORD written;checked(length>0&&(size_t)length<sizeof(result)&&WriteFile(receipt,result,(DWORD)length,&written,NULL)&&written==(DWORD)length
    &&FlushFileBuffers(receipt)&&FlushFileBuffers(receiptParent),"import final native durable receipt");
  /* Child bytes are carried in a length-delimited frame so controller JSON and
   * diagnostics cannot impersonate native settlement records. */
  printf("%s",result);printf("%lu:%lu\n",output.length,errors.length);fflush(stdout);
  checked(WriteFile(GetStdHandle(STD_OUTPUT_HANDLE),output.bytes,output.length,&written,NULL)&&written==output.length,"import stdout frame");
  checked(WriteFile(GetStdHandle(STD_OUTPUT_HANDLE),errors.bytes,errors.length,&written,NULL)&&written==errors.length,"import stderr frame");
  CloseHandle(receipt);for(DWORD i=0;i<sealed.count;i++)CloseHandle(sealed.files[i]);free(sealed.files);
  for(DWORD i=0;i<sealedEnvironment.count;i++)CloseHandle(sealedEnvironment.files[i]);free(sealedEnvironment.files);
  for(DWORD i=0;i<native_import_configs.count;i++)CloseHandle(native_import_configs.files[i]);free(native_import_configs.files);native_import_configs.files=NULL;native_import_configs.count=0;
  for(DWORD i=0;i<artifacts.count;i++)CloseHandle(artifacts.files[i]);free(artifacts.files);
  CloseHandle(rootIdentity);CloseHandle(image);CloseHandle(rootGuard);if(receiptGuard)CloseHandle(receiptGuard);
  if(environmentIdentity)CloseHandle(environmentIdentity);if(environmentGuard)CloseHandle(environmentGuard);for(DWORD i=0;i<environmentCount;i++)CloseHandle(environmentParents[i]);
  CloseHandle(writerThread);CloseHandle(hostOutput);CloseHandle(hostError);CloseHandle(process.hThread);CloseHandle(process.hProcess);CloseHandle(job);active_job=NULL;CloseHandle(keeper);
  CloseHandle(token);CloseHandle(restricted);free(identity);LocalFree(jobSecurity);free(command);free(environment);free(request);free(output.bytes);free(errors.bytes);
  DeleteProcThreadAttributeList(startup.lpAttributeList);free(startup.lpAttributeList);
  for(DWORD i=0;i<controllerCount;i++)CloseHandle(controllerParents[i]);for(DWORD i=0;i<rootCount;i++)CloseHandle(rootParents[i]);for(DWORD i=0;i<receiptCount;i++)CloseHandle(receiptParents[i]);return 0;
}
static int update_tree_operation(int argc, wchar_t **argv) {
  BOOL removing = !wcscmp(argv[1], L"--remove-update-tree"), inspect = argc == 3, copy = !wcscmp(argv[1], L"--clone-update-tree");
  wchar_t source[32768], destination[32768], token[160]; HANDLE parents[256], other[256];
  FILE_ID_INFO destinationParent = {0};
  if (!inspect && !removing) {
    DWORD aliases = anchor_parents(argv[3], destination, other);
    checked(GetFileInformationByHandleEx(other[aliases - 1], FileIdInfo, &destinationParent, sizeof(destinationParent)), "update destination parent identity");
    for (DWORD i = 0; i < aliases; i++) CloseHandle(other[i]);
  }
  DWORD count = anchor_parents_access(argv[2], source, parents, inspect ? 0 : GENERIC_WRITE);
  HANDLE parent = parents[count - 1], guard = publication_guard(source, parent, !inspect);
  if (!inspect) {
    /* Prove both spellings refer to the same held parent before accepting a
     * destination basename. Close duplicate read anchors before write opens. */
    FILE_ID_INFO actualParent; checked(GetFileInformationByHandleEx(parent, FileIdInfo, &actualParent, sizeof(actualParent)), "update source parent identity");
    if (!removing && !identity_equal(&actualParent, &destinationParent)) { SetLastError(ERROR_NOT_SAME_DEVICE); fail("update same parent boundary"); }
    checked(FlushFileBuffers(parent), "private namespace durability prerequisite");
  }
  update_tree_snapshot snapshot = {0};
  if (!inspect) { snapshot.files = calloc(65536, sizeof(HANDLE)); if (!snapshot.files) fail("update retained snapshot allocation"); snapshot.removing = removing; }
  HANDLE root = hash_update_tree_internal(source, NULL, inspect || copy ? 0 : DELETE, token, FALSE, inspect ? NULL : &snapshot);
  if (!inspect && wcscmp(token, argv[removing ? 3 : 4])) { SetLastError(ERROR_INVALID_DATA); fail("update tree compare and swap"); }
  if (!inspect && copy) {
    wchar_t during[160]; HANDLE copiedSource = hash_update_tree(source, destination, 0, during);
    if (wcscmp(token, during)) { SetLastError(ERROR_INVALID_DATA); fail("update source changed during snapshot"); } CloseHandle(copiedSource);
    wchar_t copied[160]; HANDLE output = hash_update_tree(destination, NULL, 0, copied);
    if (wcscmp(token + 50, copied + 50)) { SetLastError(ERROR_INVALID_DATA); fail("update snapshot integrity"); }
    wcscpy(token, copied); CloseHandle(output); checked(FlushFileBuffers(parent), "update snapshot namespace durability");
  } else if (removing) {
    /* Delete only the handles which supplied the compared tree. Reverse
     * preorder settles children before their held directories; never reopen
     * a name and accidentally delete its replacement. */
    for (DWORD i = snapshot.count; i > 0; i--) {
      HANDLE held = snapshot.files[i - 1]; BY_HANDLE_FILE_INFORMATION info;
      checked(GetFileInformationByHandle(held, &info), "update cleanup retained identity");
      if (info.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY) checked(FlushFileBuffers(held), "update cleanup directory durability");
      FILE_DISPOSITION_INFO disposition = { TRUE };
      checked(SetFileInformationByHandle(held, FileDispositionInfo, &disposition, sizeof(disposition)), "update cleanup snapshot held deletion");
      CloseHandle(held); snapshot.files[i - 1] = NULL;
    }
    root = NULL; checked(FlushFileBuffers(parent), "update cleanup namespace durability");
  }
  else if (!inspect) rename_publication_file(root, parent, wcsrchr(destination, L'\\') + 1);
  printf("{\"protocol\":\"devryan.windows-update-tree/1\",\"token\":\"%ls\",\"namespaceFlushed\":%s}\n", token, inspect ? "false" : "true");
  if (inspect && root) CloseHandle(root);
  for (DWORD i = 0; i < snapshot.count; i++) if (snapshot.files[i]) CloseHandle(snapshot.files[i]);
  free(snapshot.files); CloseHandle(guard); for (DWORD i = 0; i < count; i++) CloseHandle(parents[i]); return 0;
}

/* NSIS executes as the existing non-elevated user. This owner retains the
 * release hash, installation root, original process creation identity and
 * kernel job before acknowledging readiness. No LPAC admission is granted. */
static int hold_nsis(int argc, wchar_t **argv) {
  if (argc != 11) return 125;
  if (wcslen(argv[9]) != 32) return 125;
  for (const wchar_t *p = argv[9]; *p; p++) if (!(*p >= L'0' && *p <= L'9') && !(*p >= L'a' && *p <= L'f')) return 125;
  wchar_t installer[32768], target[32768]; HANDLE parents[256], targetParents[256];
  DWORD count = anchor_parents(argv[2], installer, parents);
  HANDLE image = open_publication_file(installer, OPEN_EXISTING, 0); if (!image) fail("NSIS installer identity");
  ULONGLONG size; BYTE digest[32]; hash_file_bound(image, &size, digest, 8ULL * 1024 * 1024 * 1024);
  wchar_t hash[65]; for (DWORD i = 0; i < 32; i++) swprintf(hash + i * 2, 65 - i * 2, L"%02x", (unsigned int)digest[i]);
  wchar_t *end; errno = 0; ULONGLONG expectedSize = _wcstoui64(argv[4], &end, 10);
  if (errno || *end || size != expectedSize || wcscmp(hash, argv[3])) { SetLastError(ERROR_INVALID_DATA); fail("NSIS release integrity"); }
  DWORD targetCount = anchor_parents_access(argv[5], target, targetParents, GENERIC_WRITE);
  HANDLE parent = targetParents[targetCount - 1]; BOOL own;
  if (!file_privacy(parent, &own)) { SetLastError(ERROR_ACCESS_DENIED); fail("NSIS private installation parent"); }
  checked(FlushFileBuffers(parent), "private namespace durability prerequisite");
  wchar_t receiptPath[32768]; HANDLE receiptParents[256];
  DWORD receiptCount = anchor_parents_access(argv[10], receiptPath, receiptParents, GENERIC_WRITE);
  HANDLE receiptParent = receiptParents[receiptCount - 1];
  if (!file_privacy(receiptParent, &own)) { SetLastError(ERROR_ACCESS_DENIED); fail("NSIS private receipt parent"); }
  checked(FlushFileBuffers(receiptParent), "private namespace durability prerequisite");
  HANDLE receipt = open_publication_file(receiptPath, CREATE_NEW, GENERIC_WRITE);
  checked(FlushFileBuffers(receipt) && FlushFileBuffers(receiptParent), "NSIS initial receipt durability");
  wchar_t treeToken[160]; HANDLE root = hash_update_tree(target, NULL, 0, treeToken);
  if (wcscmp(treeToken, argv[6])) { SetLastError(ERROR_INVALID_DATA); fail("NSIS installation compare and swap"); }
  HANDLE token, restricted;
  checked(OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY | TOKEN_DUPLICATE | TOKEN_ASSIGN_PRIMARY | TOKEN_ADJUST_DEFAULT, &token), "NSIS user token");
  checked(CreateRestrictedToken(token, DISABLE_MAX_PRIVILEGE | LUA_TOKEN, 0, NULL, 0, NULL, 0, NULL, &restricted), "NSIS per-user restricted token");
  TOKEN_USER *identity = current_user(); TOKEN_OWNER childOwner = { identity->User.Sid };
  checked(SetTokenInformation(restricted, TokenOwner, &childOwner, sizeof(childOwner)), "NSIS current-user file owner");
  PSID integrity; checked(ConvertStringSidToSidW(L"S-1-16-8192", &integrity), "NSIS medium integrity identity");
  TOKEN_MANDATORY_LABEL label = { { integrity, SE_GROUP_INTEGRITY } };
  checked(SetTokenInformation(restricted, TokenIntegrityLevel, &label, sizeof(label) + GetLengthSid(integrity)), "NSIS medium integrity boundary");
  DWORD groupsSize = 0; GetTokenInformation(restricted, TokenGroups, NULL, 0, &groupsSize);
  TOKEN_GROUPS *groups = calloc(1, groupsSize); if (!groups) fail("NSIS group allocation");
  checked(GetTokenInformation(restricted, TokenGroups, groups, groupsSize, &groupsSize), "NSIS user groups");
  PSID administrators; checked(ConvertStringSidToSidW(L"S-1-5-32-544", &administrators), "NSIS administrator identity");
  for (DWORD i = 0; i < groups->GroupCount; i++) if (EqualSid(groups->Groups[i].Sid, administrators)
    && (groups->Groups[i].Attributes & SE_GROUP_ENABLED) && !(groups->Groups[i].Attributes & SE_GROUP_USE_FOR_DENY_ONLY)) {
    SetLastError(ERROR_ACCESS_DENIED); fail("NSIS per-user administrator refusal");
  }
  free(groups); LocalFree(administrators);
  errno = 0; unsigned long pid = wcstoul(argv[7], &end, 10); if (errno || *end || !pid) return 125;
  HANDLE original = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION | SYNCHRONIZE, FALSE, (DWORD)pid);
  if (!original) fail("NSIS original owner handle");
  FILETIME created, exited, kernel, user; wchar_t creation[40];
  checked(GetProcessTimes(original, &created, &exited, &kernel, &user), "NSIS original owner identity");
  swprintf(creation, 40, L"win32:%08lx%08lx", created.dwHighDateTime, created.dwLowDateTime);
  if (wcscmp(creation, argv[8])) { SetLastError(ERROR_INVALID_DATA); fail("NSIS original owner creation time"); }
  DWORD keeperPid; HANDLE keeper = parent_process(&keeperPid);
  HANDLE job = CreateJobObjectW(NULL, NULL); if (!job) fail("NSIS process job"); active_job = job;
  JOBOBJECT_EXTENDED_LIMIT_INFORMATION limits = {0};
  limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE | JOB_OBJECT_LIMIT_DIE_ON_UNHANDLED_EXCEPTION;
  checked(SetInformationJobObject(job, JobObjectExtendedLimitInformation, &limits, sizeof(limits)), "NSIS job ownership");
  HANDLE input = GetStdHandle(STD_INPUT_HANDLE); if (GetFileType(input) != FILE_TYPE_PIPE) { SetLastError(ERROR_INVALID_HANDLE); fail("NSIS lifetime input"); }
  printf("{\"protocol\":\"devryan.windows-nsis-owner/1\",\"status\":\"held\",\"nonce\":\"%ls\"}\n", argv[9]); fflush(stdout);
  BYTE command[8]; DWORD read; checked(ReadFile(input, command, sizeof(command), &read, NULL) && read == 8 && !memcmp(command, "install\n", 8), "NSIS install authorization");
  ULONGLONG deadline = GetTickCount64() + 120000;
  DWORD originalState;
  while ((originalState = WaitForSingleObject(original, 25)) == WAIT_TIMEOUT) {
    if (WaitForSingleObject(keeper, 0) != WAIT_TIMEOUT || GetTickCount64() >= deadline) { SetLastError(ERROR_TIMEOUT); fail("NSIS original owner drain"); }
  }
  if (originalState != WAIT_OBJECT_0) fail("NSIS original owner settlement");
  /* The helper has durably published installing before authorizing this
   * command. Serialize SDK mutations only after original drain, so intent and
   * ACK publication cannot deadlock behind this installer lifetime. */
  acquire_private_namespace_mutex();
  if (WaitForSingleObject(keeper, 0) != WAIT_TIMEOUT) { SetLastError(ERROR_PROCESS_ABORTED); fail("NSIS keeper lost before install"); }
  wchar_t drainedToken[160]; HANDLE drained = hash_update_tree(target, NULL, 0, drainedToken);
  if (wcscmp(drainedToken, argv[6])) { SetLastError(ERROR_INVALID_DATA); fail("NSIS installation changed during drain"); } CloseHandle(drained);
  /* Permit in-place payload writes while retaining the exact protected root
   * against NSIS/other-process deletion or replacement. An installer which
   * requires replacing that root cannot satisfy this owner contract. */
  HANDLE namespaceRoot = CreateFileW(target, GENERIC_READ | READ_CONTROL, FILE_SHARE_READ | FILE_SHARE_WRITE, NULL,
    OPEN_EXISTING, FILE_FLAG_OPEN_REPARSE_POINT | FILE_FLAG_BACKUP_SEMANTICS, NULL);
  if (namespaceRoot == INVALID_HANDLE_VALUE) fail("NSIS retained namespace root");
  FILE_ID_INFO beforeRoot, heldRoot;
  checked(GetFileInformationByHandleEx(root, FileIdInfo, &beforeRoot, sizeof(beforeRoot))
    && GetFileInformationByHandleEx(namespaceRoot, FileIdInfo, &heldRoot, sizeof(heldRoot)), "NSIS root handoff identity");
  if (!identity_equal(&beforeRoot, &heldRoot)) { SetLastError(ERROR_INVALID_DATA); fail("NSIS root handoff changed"); }
  CloseHandle(root);
  SIZE_T attributesSize = 0; InitializeProcThreadAttributeList(NULL, 2, 0, &attributesSize);
  STARTUPINFOEXW startup = {0}; startup.StartupInfo.cb = sizeof(startup); startup.StartupInfo.dwFlags = STARTF_USESTDHANDLES;
  startup.lpAttributeList = malloc(attributesSize); if (!startup.lpAttributeList) fail("NSIS attributes allocation");
  checked(InitializeProcThreadAttributeList(startup.lpAttributeList, 2, 0, &attributesSize), "NSIS process attributes");
  HANDLE handles[3]; DWORD kinds[] = { STD_INPUT_HANDLE, STD_OUTPUT_HANDLE, STD_ERROR_HANDLE };
  for (DWORD i = 0; i < 3; i++) checked(DuplicateHandle(GetCurrentProcess(), GetStdHandle(kinds[i]), GetCurrentProcess(), &handles[i], 0, TRUE, DUPLICATE_SAME_ACCESS), "NSIS standard handle");
  startup.StartupInfo.hStdInput = handles[0]; startup.StartupInfo.hStdOutput = handles[1]; startup.StartupInfo.hStdError = handles[2];
  checked(UpdateProcThreadAttribute(startup.lpAttributeList, 0, PROC_THREAD_ATTRIBUTE_HANDLE_LIST, handles, sizeof(handles), NULL, NULL), "NSIS inherited handle boundary");
  checked(UpdateProcThreadAttribute(startup.lpAttributeList, 0, PROC_THREAD_ATTRIBUTE_JOB_LIST, &job, sizeof(job), NULL, NULL), "NSIS atomic job ownership");
  /* NSIS requires /D to be the last argument, without quotes even with spaces. */
  size_t length = wcslen(installer) + wcslen(target) + 40; wchar_t *line = calloc(length, sizeof(wchar_t));
  if (!line) fail("NSIS command allocation"); swprintf(line, length, L"\"%s\" /S /currentuser /D=%s", installer, target);
  PROCESS_INFORMATION process = {0};
  if (WaitForSingleObject(keeper, 0) != WAIT_TIMEOUT) { SetLastError(ERROR_PROCESS_ABORTED); fail("NSIS keeper lost before process creation"); }
  checked(CreateProcessAsUserW(restricted, installer, line, NULL, NULL, TRUE, EXTENDED_STARTUPINFO_PRESENT | CREATE_NO_WINDOW, NULL, NULL, &startup.StartupInfo, &process), "NSIS per-user process");
  for (DWORD i = 0; i < 3; i++) CloseHandle(handles[i]);
  HANDLE waits[] = { process.hProcess, keeper }; DWORD reason = WaitForMultipleObjects(2, waits, FALSE, 120000), code = 125;
  if (reason == WAIT_OBJECT_0) checked(GetExitCodeProcess(process.hProcess, &code), "NSIS result");
  checked(TerminateJobObject(job, code), "NSIS descendant termination"); deadline = GetTickCount64() + 5000;
  for (;;) {
    JOBOBJECT_BASIC_ACCOUNTING_INFORMATION state;
    checked(QueryInformationJobObject(job, JobObjectBasicAccountingInformation, &state, sizeof(state), NULL), "NSIS descendant settlement");
    if (!state.ActiveProcesses) break;
    if (GetTickCount64() >= deadline) { SetLastError(ERROR_TIMEOUT); fail("NSIS descendant settlement bound"); } Sleep(10);
  }
  checked(FlushFileBuffers(parent), "NSIS installation namespace durability");
  wchar_t installedToken[160]; HANDLE installed = hash_update_tree_mode(target, NULL, 0, installedToken, TRUE); CloseHandle(installed);
  char result[512]; int resultLength = snprintf(result, sizeof(result), "{\"protocol\":\"devryan.windows-nsis-owner/1\",\"status\":\"settled\",\"nonce\":\"%ls\",\"exitCode\":%lu,\"terminated\":true,\"namespaceFlushed\":true,\"targetToken\":\"%ls\"}\n", argv[9], code, installedToken);
  DWORD written; checked(resultLength > 0 && (size_t)resultLength < sizeof(result)
    && WriteFile(receipt, result, (DWORD)resultLength, &written, NULL) && written == (DWORD)resultLength
    && FlushFileBuffers(receipt) && FlushFileBuffers(receiptParent), "NSIS durable termination receipt");
  printf("%s", result); fflush(stdout); CloseHandle(receipt);
  CloseHandle(namespaceRoot);
  CloseHandle(process.hThread); CloseHandle(process.hProcess); CloseHandle(job); active_job = NULL; CloseHandle(image); CloseHandle(original); CloseHandle(keeper);
  DeleteProcThreadAttributeList(startup.lpAttributeList); free(startup.lpAttributeList); free(line);
  CloseHandle(restricted); CloseHandle(token); LocalFree(integrity); free(identity);
  for (DWORD i = 0; i < count; i++) CloseHandle(parents[i]); for (DWORD i = 0; i < targetCount; i++) CloseHandle(targetParents[i]);
  for (DWORD i = 0; i < receiptCount; i++) CloseHandle(receiptParents[i]); return (int)code;
}

static void update_file_token(HANDLE file, wchar_t *token, ULONGLONG *size) {
  BYTE digest[32]; FILE_ID_INFO identity;
  hash_file_bound(file, size, digest, 8ULL * 1024 * 1024 * 1024);
  checked(GetFileInformationByHandleEx(file, FileIdInfo, &identity, sizeof(identity)), "update installer identity");
  swprintf(token, 160, L"%016llx:", (unsigned long long)identity.VolumeSerialNumber);
  for (DWORD i = 0; i < 16; i++) swprintf(token + 17 + i * 2, 160 - 17 - i * 2, L"%02x", (unsigned int)identity.FileId.Identifier[i]);
  token[49] = L':'; for (DWORD i = 0; i < 32; i++) swprintf(token + 50 + i * 2, 160 - 50 - i * 2, L"%02x", (unsigned int)digest[i]);
  swprintf(token + 114, 46, L":%llu", (unsigned long long)*size);
}
static BOOL publication_protected_identity(const wchar_t *target, HANDLE parent, FILE_ID_INFO *identity) {
  HANDLE proof = require_no_publication(target, parent);
  if (!proof) return FALSE;
  checked(GetFileInformationByHandleEx(proof, FileIdInfo, identity, sizeof(*identity)), "mutable file publication proof");
  CloseHandle(proof); return TRUE;
}
static int update_download_file(int argc, wchar_t **argv) {
  BOOL reading = argc == 3; wchar_t target[32768], token[160]; HANDLE parents[256];
  DWORD count = anchor_parents_access(argv[2], target, parents, reading ? 0 : GENERIC_WRITE);
  HANDLE parent = parents[count - 1], guard = publication_guard(target, parent, !reading);
  if (!reading) checked(FlushFileBuffers(parent), "private namespace durability prerequisite");
  FILE_ID_INFO protectedIdentity; BOOL protectedPresent = publication_protected_identity(target, parent, &protectedIdentity);
  HANDLE file = open_publication_file(target, OPEN_EXISTING, reading ? 0 : GENERIC_WRITE);
  ULONGLONG size = 0, offset = 0, maximum = 0;
  if (!reading) {
    wchar_t *end; errno = 0; offset = _wcstoui64(argv[3], &end, 10);
    if (errno || *end || !*argv[3]) return 125;
    errno = 0; maximum = _wcstoui64(argv[4], &end, 10);
    if (errno || *end || !*argv[4] || !maximum || maximum > 8ULL * 1024 * 1024 * 1024 || offset > maximum) return 125;
    if (file) {
      FILE_ID_INFO identity; checked(GetFileInformationByHandleEx(file, FileIdInfo, &identity, sizeof(identity)), "mutable file retained identity");
      if (protectedPresent && identity_equal(&identity, &protectedIdentity)) { SetLastError(ERROR_INVALID_DATA); fail("mutable file current publication refused"); }
      update_file_token(file, token, &size);
      if (wcscmp(token, argv[5]) || offset && offset != size) { SetLastError(ERROR_INVALID_DATA); fail("update download compare and swap"); }
    } else if (wcscmp(argv[5], L"absent") || offset) { SetLastError(ERROR_INVALID_DATA); fail("update download absence binding"); }
    else file = open_publication_file(target, CREATE_NEW, GENERIC_WRITE);
    LARGE_INTEGER position; position.QuadPart = (LONGLONG)offset;
    checked(SetFilePointerEx(file, position, NULL, FILE_BEGIN) && (!offset ? SetEndOfFile(file) : TRUE), "update resume position");
    printf("{\"protocol\":\"devryan.windows-update-download/1\",\"status\":\"held\"}\n"); fflush(stdout);
    BYTE bytes[65536]; DWORD read, written; size = offset;
    for (;;) {
      if (!ReadFile(GetStdHandle(STD_INPUT_HANDLE), bytes, sizeof(bytes), &read, NULL)) {
        if (GetLastError() == ERROR_BROKEN_PIPE) break; fail("update download stream");
      }
      if (!read) break;
      if (size > maximum - read || read > maximum) { SetLastError(ERROR_FILE_TOO_LARGE); fail("update download response bound"); }
      checked(WriteFile(file, bytes, read, &written, NULL) && written == read, "update owned streaming write"); size += read;
    }
    checked(FlushFileBuffers(file) && FlushFileBuffers(parent), "update download data and namespace durability");
  }
  if (!file) { SetLastError(ERROR_FILE_NOT_FOUND); fail("update download private file"); }
  update_file_token(file, token, &size);
  printf("{\"protocol\":\"devryan.windows-update-file/1\",\"token\":\"%ls\",\"size\":%llu}\n", token, (unsigned long long)size);
  CloseHandle(file); CloseHandle(guard); for (DWORD i = 0; i < count; i++) CloseHandle(parents[i]); return 0;
}

static int hold_update_inputs(wchar_t **argv) {
  acquire_private_namespace_mutex();
  HANDLE files[2], parents[2][256]; DWORD counts[2]; wchar_t tokens[2][160];
  for (DWORD i = 0; i < 2; i++) {
    wchar_t input[32768]; counts[i] = anchor_parents(argv[2 + i * 2], input, parents[i]);
    BOOL own; if (!file_privacy(parents[i][counts[i] - 1], &own)) { SetLastError(ERROR_ACCESS_DENIED); fail("update helper private parent"); }
    files[i] = open_publication_file(input, OPEN_EXISTING, 0); if (!files[i]) fail("update helper expected file");
    ULONGLONG size; update_file_token(files[i], tokens[i], &size);
    if (size > 16 * 1024 * 1024 || wcslen(argv[3 + i * 2]) != 64 || wcsncmp(tokens[i] + 50, argv[3 + i * 2], 64)) {
      SetLastError(ERROR_INVALID_DATA); fail("update helper source integrity");
    }
  }
  DWORD keeperPid; HANDLE keeper = parent_process(&keeperPid), input = GetStdHandle(STD_INPUT_HANDLE);
  if (GetFileType(input) != FILE_TYPE_PIPE) { SetLastError(ERROR_INVALID_HANDLE); fail("update helper lifetime pipe"); }
  release_private_namespace_mutex();
  printf("{\"protocol\":\"devryan.windows-update-inputs/1\",\"launcherToken\":\"%ls\",\"helperToken\":\"%ls\"}\n", tokens[0], tokens[1]); fflush(stdout);
  for (;;) {
    DWORD status = WaitForSingleObject(keeper, 25); if (status == WAIT_OBJECT_0) break;
    if (status != WAIT_TIMEOUT) fail("update helper keeper identity");
    DWORD available;
    if (!PeekNamedPipe(input, NULL, 0, NULL, &available, NULL)) {
      if (GetLastError() == ERROR_BROKEN_PIPE || GetLastError() == ERROR_PIPE_NOT_CONNECTED) break;
      fail("update helper keeper pipe");
    }
    if (available) { SetLastError(ERROR_INVALID_DATA); fail("update helper lifetime protocol"); }
  }
  for (DWORD i = 0; i < 2; i++) { CloseHandle(files[i]); for (DWORD j = 0; j < counts[i]; j++) CloseHandle(parents[i][j]); }
  CloseHandle(keeper); return 0;
}

static int wait_update_owner(wchar_t **argv) {
  wchar_t *end; errno = 0; unsigned long pid = wcstoul(argv[2], &end, 10);
  if (errno || *end || !pid) return 125;
  HANDLE owner = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION | SYNCHRONIZE, FALSE, (DWORD)pid);
  if (!owner) fail("update recovery owner handle");
  FILETIME created, exited, kernel, user; wchar_t identity[40];
  checked(GetProcessTimes(owner, &created, &exited, &kernel, &user), "update recovery owner identity");
  swprintf(identity, 40, L"win32:%08lx%08lx", created.dwHighDateTime, created.dwLowDateTime);
  if (wcscmp(identity, argv[3])) { SetLastError(ERROR_INVALID_DATA); fail("update recovery owner creation time"); }
  DWORD keeperPid; HANDLE keeper = parent_process(&keeperPid);
  printf("{\"protocol\":\"devryan.windows-update-drain/1\",\"status\":\"held\"}\n"); fflush(stdout);
  HANDLE waits[] = { owner, keeper }; DWORD reason = WaitForMultipleObjects(2, waits, FALSE, 120000);
  if (reason != WAIT_OBJECT_0) { SetLastError(ERROR_TIMEOUT); fail("update recovery owner drain"); }
  printf("{\"protocol\":\"devryan.windows-update-drain/1\",\"status\":\"settled\"}\n"); fflush(stdout);
  CloseHandle(owner); CloseHandle(keeper); return 0;
}

typedef struct { HANDLE process; DWORD pid; BOOL sent; } update_close_windows;
static BOOL CALLBACK close_update_window(HWND window, LPARAM argument) {
  update_close_windows *owner = (update_close_windows *)argument;
  DWORD pid = 0; GetWindowThreadProcessId(window, &pid);
  if (pid == owner->pid && WaitForSingleObject(owner->process, 0) == WAIT_TIMEOUT) {
    DWORD_PTR ignored;
    if (SendMessageTimeoutW(window, WM_CLOSE, 0, 0, SMTO_ABORTIFHUNG | SMTO_BLOCK, 1000, &ignored)) owner->sent = TRUE;
  }
  return TRUE;
}
static int terminate_update_process(wchar_t **argv) {
  wchar_t *end; errno = 0; unsigned long pid = wcstoul(argv[2], &end, 10);
  BOOL graceful = !wcscmp(argv[4], L"graceful");
  if (errno || *end || !pid || (!graceful && wcscmp(argv[4], L"terminate"))) return 125;
  HANDLE process = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION | SYNCHRONIZE | (graceful ? 0 : PROCESS_TERMINATE), FALSE, (DWORD)pid);
  if (!process) fail("update termination process handle");
  FILETIME created, exited, kernel, user; wchar_t identity[40];
  checked(GetProcessTimes(process, &created, &exited, &kernel, &user), "update termination process identity");
  swprintf(identity, 40, L"win32:%08lx%08lx", created.dwHighDateTime, created.dwLowDateTime);
  if (wcscmp(identity, argv[3])) { SetLastError(ERROR_INVALID_DATA); fail("update termination process creation time"); }
  DWORD active = WaitForSingleObject(process, 0);
  if (active == WAIT_TIMEOUT) {
    if (graceful) {
      update_close_windows owner = { process, (DWORD)pid, FALSE };
      checked(EnumWindows(close_update_window, (LPARAM)&owner), "update termination window enumeration");
      if (!owner.sent) { SetLastError(ERROR_NOT_FOUND); fail("update termination owned window unavailable"); }
    } else checked(TerminateProcess(process, 125), "update exact process termination");
    active = WaitForSingleObject(process, 30000);
  }
  if (active != WAIT_OBJECT_0) { SetLastError(ERROR_TIMEOUT); fail("update exact process termination unconfirmed"); }
  /* This receipt establishes only this retained root's exit. It cannot stand
   * in for a job-owned descendant termination receipt. */
  printf("{\"protocol\":\"devryan.windows-update-process-exit/1\",\"pid\":%lu,\"startIdentity\":\"%ls\",\"graceful\":%s,\"rootExited\":true}\n", (DWORD)pid, identity, graceful ? "true" : "false");
  CloseHandle(process); return 0;
}

static int inspect_update_version(const wchar_t *argument) {
  wchar_t executable[32768]; HANDLE parents[256]; DWORD count = anchor_parents(argument, executable, parents); BOOL own;
  if (!file_privacy(parents[count - 1], &own)) { SetLastError(ERROR_ACCESS_DENIED); fail("update executable private root"); }
  HANDLE file = CreateFileW(executable, GENERIC_READ | READ_CONTROL, FILE_SHARE_READ, NULL, OPEN_EXISTING, FILE_FLAG_OPEN_REPARSE_POINT, NULL);
  if (file == INVALID_HANDLE_VALUE) fail("update executable held identity");
  BY_HANDLE_FILE_INFORMATION info; checked(GetFileInformationByHandle(file, &info), "update executable identity");
  if ((info.dwFileAttributes & (FILE_ATTRIBUTE_REPARSE_POINT | FILE_ATTRIBUTE_DIRECTORY)) || info.nNumberOfLinks != 1
    || !file_privacy_mode(file, &own, TRUE)) { SetLastError(ERROR_ACCESS_DENIED); fail("update executable private boundary"); }
  DWORD ignored, size = GetFileVersionInfoSizeW(executable, &ignored);
  if (!size || size > 1048576) { SetLastError(ERROR_INVALID_DATA); fail("update executable version bound"); }
  BYTE *bytes = malloc(size); if (!bytes) fail("update executable version allocation");
  VS_FIXEDFILEINFO *version; UINT length;
  checked(GetFileVersionInfoW(executable, 0, size, bytes), "update executable version bytes");
  checked(VerQueryValueW(bytes, L"\\", (void **)&version, &length)
    && length == sizeof(*version) && version->dwSignature == 0xfeef04bd, "update executable version");
  IMAGE_DOS_HEADER dos; DWORD read; LARGE_INTEGER offset;
  checked(ReadFile(file, &dos, sizeof(dos), &read, NULL) && read == sizeof(dos) && dos.e_magic == IMAGE_DOS_SIGNATURE
    && dos.e_lfanew > 0 && dos.e_lfanew < 1048576, "update executable DOS header");
  offset.QuadPart = dos.e_lfanew; DWORD signature; IMAGE_FILE_HEADER header;
  checked(SetFilePointerEx(file, offset, NULL, FILE_BEGIN) && ReadFile(file, &signature, sizeof(signature), &read, NULL)
    && read == sizeof(signature) && signature == IMAGE_NT_SIGNATURE, "update executable PE signature");
  checked(ReadFile(file, &header, sizeof(header), &read, NULL) && read == sizeof(header), "update executable PE architecture");
  const char *arch = header.Machine == IMAGE_FILE_MACHINE_AMD64 ? "x64" : header.Machine == IMAGE_FILE_MACHINE_ARM64 ? "arm64" : "unsupported";
  printf("{\"protocol\":\"devryan.windows-update-version/1\",\"version\":\"%u.%u.%u\",\"arch\":\"%s\"}\n",
    (unsigned int)HIWORD(version->dwProductVersionMS), (unsigned int)LOWORD(version->dwProductVersionMS), (unsigned int)HIWORD(version->dwProductVersionLS), arch);
  free(bytes); CloseHandle(file); for (DWORD i = 0; i < count; i++) CloseHandle(parents[i]); return 0;
}

static void update_registry_string(HKEY key, const wchar_t *name, wchar_t *value, DWORD characters) {
  DWORD type = 0, size = characters * sizeof(wchar_t);
  LONG result = RegQueryValueExW(key, name, NULL, &type, (BYTE *)value, &size);
  if (result != ERROR_SUCCESS || type != REG_SZ || size < sizeof(wchar_t) || size > characters * sizeof(wchar_t)
    || size % sizeof(wchar_t) || value[size / sizeof(wchar_t) - 1] || wcslen(value) + 1 != size / sizeof(wchar_t)) {
    SetLastError(result == ERROR_SUCCESS ? ERROR_INVALID_DATA : (DWORD)result); fail("update fixed registration value");
  }
}
static BOOL update_version_string(const wchar_t *value) {
  DWORD dots = 0; size_t length = wcslen(value);
  if (!length || length > 64 || value[0] == L'.' || value[length - 1] == L'.') return FALSE;
  for (size_t i = 0; i < length; i++) {
    if (value[i] == L'.') { if (i && value[i - 1] == L'.') return FALSE; dots++; }
    else if (value[i] < L'0' || value[i] > L'9') return FALSE;
  }
  return dots == 2;
}
static int restore_update_registration(wchar_t **argv) {
  if (!update_version_string(argv[4]) || !update_version_string(argv[5])) return 125;
  wchar_t target[32768], token[160]; HANDLE parents[256]; DWORD count = anchor_parents(argv[2], target, parents);
  HANDLE parent = parents[count - 1], guard = publication_guard(target, parent, TRUE);
  HANDLE root = hash_update_tree(target, NULL, 0, token);
  if (wcscmp(token, argv[3])) { SetLastError(ERROR_INVALID_DATA); fail("update restored registration tree binding"); }
  /* Match electron-builder's pinned NSIS GUID, per-user installation root,
   * and uninstall identity. Never enumerate/adopt an unrelated registration. */
  HKEY install, uninstall;
  LONG result = RegOpenKeyExW(HKEY_CURRENT_USER, L"Software\\f8140f18-5574-54bc-8df6-bf218619bfba", 0, KEY_QUERY_VALUE | KEY_WOW64_64KEY, &install);
  if (result != ERROR_SUCCESS) { SetLastError((DWORD)result); fail("update per-user install registration"); }
  result = RegOpenKeyExW(HKEY_CURRENT_USER, L"Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\f8140f18-5574-54bc-8df6-bf218619bfba", 0,
    KEY_QUERY_VALUE | KEY_SET_VALUE | KEY_WOW64_64KEY, &uninstall);
  if (result != ERROR_SUCCESS) { SetLastError((DWORD)result); fail("update per-user uninstall registration"); }
  wchar_t location[32768], name[256], version[128], command[32768], expected[32768];
  update_registry_string(install, L"InstallLocation", location, 32768); update_registry_string(uninstall, L"DisplayName", name, 256);
  update_registry_string(uninstall, L"DisplayVersion", version, 128); update_registry_string(uninstall, L"UninstallString", command, 32768);
  int formatted = swprintf(expected, 32768, L"\"%ls\\Uninstall DevRyan.exe\" /currentuser", target);
  if (formatted <= 0 || _wcsicmp(location, target) || wcscmp(name, L"DevRyan") || wcscmp(command, expected)
    || wcscmp(version, argv[4]) && wcscmp(version, argv[5])) { SetLastError(ERROR_INVALID_DATA); fail("update fixed registration binding"); }
  update_registry_string(uninstall, L"QuietUninstallString", command, 32768);
  formatted = swprintf(expected, 32768, L"\"%ls\\Uninstall DevRyan.exe\" /currentuser /S", target);
  if (formatted <= 0 || wcscmp(command, expected)) { SetLastError(ERROR_INVALID_DATA); fail("update fixed quiet registration binding"); }
  result = RegSetValueExW(uninstall, L"DisplayVersion", 0, REG_SZ, (const BYTE *)argv[4], (DWORD)((wcslen(argv[4]) + 1) * sizeof(wchar_t)));
  if (result != ERROR_SUCCESS) { SetLastError((DWORD)result); fail("update restored registration version"); }
  result = RegFlushKey(uninstall);
  if (result != ERROR_SUCCESS) { SetLastError((DWORD)result); fail("update restored registration durability"); }
  update_registry_string(uninstall, L"DisplayVersion", version, 128);
  if (wcscmp(version, argv[4])) { SetLastError(ERROR_INVALID_DATA); fail("update restored registration verification"); }
  printf("{\"protocol\":\"devryan.windows-update-registration/1\",\"version\":\"%ls\",\"registryFlushed\":true}\n", version);
  RegCloseKey(uninstall); RegCloseKey(install); CloseHandle(root); CloseHandle(guard);
  for (DWORD i = 0; i < count; i++) CloseHandle(parents[i]); return 0;
}

static int private_file_transition(wchar_t **argv) {
  BOOL renaming = !wcscmp(argv[1], L"--rename-private-file");
  wchar_t source[32768], destination[32768], token[160]; HANDLE parents[256], aliases[256]; FILE_ID_INFO destinationParent = {0};
  ULONGLONG length = 0;
  if (renaming) {
    DWORD aliasCount = anchor_parents(argv[3], destination, aliases);
    checked(GetFileInformationByHandleEx(aliases[aliasCount - 1], FileIdInfo, &destinationParent, sizeof(destinationParent)), "private file destination parent identity");
    for (DWORD i = 0; i < aliasCount; i++) CloseHandle(aliases[i]);
  } else {
    wchar_t *end; errno = 0; length = _wcstoui64(argv[3], &end, 10);
    if (errno || *end || !*argv[3] || length > 8ULL * 1024 * 1024 * 1024) return 125;
  }
  DWORD count = anchor_parents_access(argv[2], source, parents, GENERIC_WRITE);
  HANDLE parent = parents[count - 1], guard = publication_guard(source, parent, TRUE);
  checked(FlushFileBuffers(parent), "private namespace durability prerequisite");
  FILE_ID_INFO protectedIdentity; BOOL protectedPresent = publication_protected_identity(source, parent, &protectedIdentity);
  HANDLE file = open_publication_file(source, OPEN_EXISTING, renaming ? DELETE : GENERIC_WRITE);
  if (!file) { SetLastError(ERROR_FILE_NOT_FOUND); fail("private file transition absent"); }
  FILE_ID_INFO identity; checked(GetFileInformationByHandleEx(file, FileIdInfo, &identity, sizeof(identity)), "private file transition identity");
  if (protectedPresent && identity_equal(&identity, &protectedIdentity)) { SetLastError(ERROR_INVALID_DATA); fail("mutable file current publication refused"); }
  ULONGLONG size; update_file_token(file, token, &size);
  if (wcscmp(token, argv[4])) { SetLastError(ERROR_INVALID_DATA); fail("private file transition compare and swap"); }
  if (renaming) {
    FILE_ID_INFO actualParent; checked(GetFileInformationByHandleEx(parent, FileIdInfo, &actualParent, sizeof(actualParent)), "private file source parent identity");
    if (!identity_equal(&actualParent, &destinationParent)) { SetLastError(ERROR_NOT_SAME_DEVICE); fail("private file same parent boundary"); }
    const wchar_t *basename = wcsrchr(destination, L'\\') + 1;
    if (!*basename || !_wcsnicmp(basename, L".DevRyan-publication", 20)) { SetLastError(ERROR_INVALID_PARAMETER); fail("private file destination name"); }
    HANDLE existing = open_publication_file(destination, OPEN_EXISTING, 0);
    if (existing) { SetLastError(ERROR_ALREADY_EXISTS); fail("private file destination occupied"); }
    rename_publication_file(file, parent, basename);
  } else {
    if (length > size) { SetLastError(ERROR_INVALID_PARAMETER); fail("private file truncate extension refused"); }
    LARGE_INTEGER offset; offset.QuadPart = (LONGLONG)length;
    checked(SetFilePointerEx(file, offset, NULL, FILE_BEGIN) && SetEndOfFile(file) && FlushFileBuffers(file)
      && FlushFileBuffers(parent), "private file truncate data namespace durability");
    update_file_token(file, token, &size);
    if (size != length) { SetLastError(ERROR_INVALID_DATA); fail("private file truncate verification"); }
  }
  printf("{\"protocol\":\"devryan.windows-update-file/1\",\"token\":\"%ls\",\"size\":%llu}\n", token, (unsigned long long)size);
  CloseHandle(file); CloseHandle(guard); for (DWORD i = 0; i < count; i++) CloseHandle(parents[i]); return 0;
}

int wmain(int argc, wchar_t **argv) {
  if (argc >= 2 && (!wcscmp(argv[1], L"--create-private-directory") || !wcscmp(argv[1], L"--create-private-file")
    || !wcscmp(argv[1], L"--publish-private-file") || !wcscmp(argv[1], L"--publish-private-ledger") || !wcscmp(argv[1], L"--delete-private-ledger") || !wcscmp(argv[1], L"--delete-private-file") || !wcscmp(argv[1], L"--recover-private-publication")
    || !wcscmp(argv[1], L"--prune-private-publications") || !wcscmp(argv[1], L"--inspect-update-tree") || !wcscmp(argv[1], L"--clone-update-tree")
    || !wcscmp(argv[1], L"--rename-update-tree") || !wcscmp(argv[1], L"--remove-update-tree") || !wcscmp(argv[1], L"--copy-private-tree") || !wcscmp(argv[1], L"--inspect-private-copy-tree") || !wcscmp(argv[1], L"--hold-sqlite-output") || !wcscmp(argv[1], L"--hold-native-import")
    || !wcscmp(argv[1], L"--write-update-download") || !wcscmp(argv[1], L"--rename-private-file") || !wcscmp(argv[1], L"--truncate-private-file")
    || !wcscmp(argv[1], L"--restore-update-registration"))) acquire_private_namespace_mutex();
  if (argc == 6 && !wcscmp(argv[1], L"--copy-private-tree")) return copy_private_tree(argv);
  if (argc == 13 && !wcscmp(argv[1], L"--hold-native-import")) return hold_native_import(argv);
  if (argc == 3 && !wcscmp(argv[1], L"--inspect-native-import-child")) return inspect_native_import_child(argv[2]);
  if (argc == 4 && !wcscmp(argv[1], L"--inspect-private-copy-tree")) return inspect_copy_tree(argv);
  if (argc == 4 && !wcscmp(argv[1], L"--hold-sqlite-output")) return hold_sqlite_output(argv);
  if (argc == 5 && (!wcscmp(argv[1], L"--rename-private-file") || !wcscmp(argv[1], L"--truncate-private-file"))) return private_file_transition(argv);
  if (argc == 4 && !wcscmp(argv[1], L"--prune-private-publications")) return prune_publication_history(argv);
  if (argc == 6 && !wcscmp(argv[1], L"--restore-update-registration")) return restore_update_registration(argv);
  if (argc == 5 && !wcscmp(argv[1], L"--terminate-update-process")) return terminate_update_process(argv);
  if (argc == 4 && !wcscmp(argv[1], L"--wait-update-owner")) return wait_update_owner(argv);
  if (argc == 4 && !wcscmp(argv[1], L"--remove-update-tree")) return update_tree_operation(argc, argv);
  if (argc == 6 && !wcscmp(argv[1], L"--hold-update-inputs")) return hold_update_inputs(argv);
  if (argc == 3 && !wcscmp(argv[1], L"--inspect-update-file")) return update_download_file(argc, argv);
  if (argc == 6 && !wcscmp(argv[1], L"--write-update-download")) return update_download_file(argc, argv);
  if (argc == 3 && !wcscmp(argv[1], L"--inspect-update-version")) return inspect_update_version(argv[2]);
  if (argc == 11 && !wcscmp(argv[1], L"--hold-nsis-installer")) return hold_nsis(argc, argv);
  if (argc == 3 && !wcscmp(argv[1], L"--inspect-update-tree")) return update_tree_operation(argc, argv);
  if (argc == 5 && (!wcscmp(argv[1], L"--clone-update-tree") || !wcscmp(argv[1], L"--rename-update-tree"))) return update_tree_operation(argc, argv);
  if (argc >= 5 && !wcscmp(argv[1], L"--diagnose-local-stdio")) return diagnose_local_stdio(argc, argv);
  if (argc == 2 && !wcscmp(argv[1], L"--diagnose-descendant")) return diagnose_descendant(FALSE);
  if (argc == 2 && !wcscmp(argv[1], L"--diagnose-descendant-leaf")) return diagnose_descendant(TRUE);
  if (argc == 2 && !wcscmp(argv[1], L"--inspect-job-boundary")) return inspect_job_boundary();
  if (argc == 3 && !wcscmp(argv[1], L"--inspect-process")) return inspect_process(argv[2]);
  if (argc == 2 && !wcscmp(argv[1], L"--inspect-parent")) {
    DWORD pid; HANDLE parent = parent_process(&pid);
    int result = emit_process_identity(parent, pid); CloseHandle(parent); return result;
  }
  if (argc == 3 && !wcscmp(argv[1], L"--inspect-path")) return inspect_path(argv[2]);
  if (argc == 3 && !wcscmp(argv[1], L"--create-private-directory")) return create_private_directory(argv[2]);
  if (argc == 3 && !wcscmp(argv[1], L"--create-private-file")) return create_private_file(argv[2]);
  if (argc == 3 && !wcscmp(argv[1], L"--read-private-ledger")) return read_private_file(argv[2], 64 * 1024 * 1024);
  if (argc == 5 && !wcscmp(argv[1], L"--publish-private-ledger")) return publish_private_file(argv[2], argv[3], argv[4], FALSE, FALSE, 64 * 1024 * 1024);
  if (argc == 5 && !wcscmp(argv[1], L"--delete-private-ledger")) return publish_private_file(argv[2], argv[3], argv[4], FALSE, TRUE, 64 * 1024 * 1024);
  if (argc == 3 && !wcscmp(argv[1], L"--read-private-file")) return read_private_file(argv[2], 16 * 1024 * 1024);
  if (argc == 5 && !wcscmp(argv[1], L"--publish-private-file")) return publish_private_file(argv[2], argv[3], argv[4], FALSE, FALSE, 16 * 1024 * 1024);
  if (argc == 5 && !wcscmp(argv[1], L"--delete-private-file")) return publish_private_file(argv[2], argv[3], argv[4], FALSE, TRUE, 16 * 1024 * 1024);
  if (argc == 4 && !wcscmp(argv[1], L"--recover-private-publication")) return publish_private_file(argv[2], NULL, argv[3], TRUE, FALSE, 64 * 1024 * 1024);
  if (argc == 3 && !wcscmp(argv[1], L"--inspect-private-publication")) return inspect_publication(argv[2]);
  if (argc == 4 && !wcscmp(argv[1], L"--inspect-private-settlement")) return inspect_private_settlement(argv[2], argv[3]);
  if (argc == 3 && !wcscmp(argv[1], L"--inspect-namespace-durability")) return inspect_namespace_durability(argv[2]);
  if (argc == 3 && !wcscmp(argv[1], L"--owner-lock")) return owner_lock(argv[2], FALSE, FALSE);
  if (argc == 3 && !wcscmp(argv[1], L"--owner-probe")) return owner_lock(argv[2], TRUE, FALSE);
  if (argc == 3 && !wcscmp(argv[1], L"--private-file-lock")) return owner_lock(argv[2], FALSE, TRUE);
  // The host uses a named cancellation event because TerminateProcess would
  // close the job safely but could not write a termination acknowledgement.
  if (argc == 5 && !wcscmp(argv[1], L"--cancel")) return cancel_process(argv[2], argv[3], argv[4]);
  if (argc < 7 || wcscmp(argv[5], L"--")) return 125;
  DWORD uiMask = maximum_ui_limits(os_build());
  const wchar_t *cache = _wgetenv(L"DEVRYAN_EXECUTION_CACHE");
  if (!cache || !*cache) { SetLastError(ERROR_INVALID_PARAMETER); fail("execution cache identity"); }
  wchar_t canonical[32768]; HANDLE scopeParents[4][256], cacheParents[256]; DWORD scopeCounts[4];
  for (DWORD i = 0; i < 4; i++) scopeCounts[i] = anchor_parents(argv[i + 1], canonical, scopeParents[i]);
  HANDLE scope = scopeParents[0][scopeCounts[0] - 1]; BOOL scopeOwner;
  if (!file_privacy(scope, &scopeOwner)) { SetLastError(ERROR_ACCESS_DENIED); fail("private execution parent"); }
  for (DWORD i = 1; i < 4; i++) if (!same_file(scope, scopeParents[i][scopeCounts[i] - 1])) {
    SetLastError(ERROR_ACCESS_DENIED); fail("execution sibling binding");
  }
  DWORD cacheParentCount = anchor_parents(cache, canonical, cacheParents);
  HANDLE cacheRoot = CreateFileW(canonical, FILE_READ_ATTRIBUTES | READ_CONTROL, FILE_SHARE_READ, NULL, OPEN_EXISTING,
    FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT, NULL);
  if (cacheRoot == INVALID_HANDLE_VALUE) fail("cache scope identity");
  for (DWORD i = 0; i < scopeCounts[0]; i++) if (same_file(cacheRoot, scopeParents[0][i])) {
    SetLastError(ERROR_ACCESS_DENIED); fail("cache runtime overlap");
  }
  HANDLE scratchRoot = CreateFileW(argv[2], FILE_READ_ATTRIBUTES, FILE_SHARE_READ, NULL, OPEN_EXISTING,
    FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT, NULL);
  if (scratchRoot == INVALID_HANDLE_VALUE) fail("scratch scope identity");
  BOOL cacheIsScratch = same_file(cacheRoot, scratchRoot); CloseHandle(scratchRoot);
  wchar_t receiptPath[32768]; HANDLE receiptParents[256];
  DWORD receiptParentCount = anchor_parents(argv[4], receiptPath, receiptParents);
  PSECURITY_DESCRIPTOR receiptSecurity = private_security(FALSE);
  SECURITY_ATTRIBUTES receiptAttributes = { sizeof(receiptAttributes), receiptSecurity, FALSE };
  HANDLE receipt = CreateFileW(receiptPath, GENERIC_WRITE, 0, &receiptAttributes, CREATE_NEW,
    FILE_FLAG_OPEN_REPARSE_POINT | FILE_FLAG_WRITE_THROUGH, NULL);
  if (receipt == INVALID_HANDLE_VALUE) fail("exclusive receipt");
  DWORD parentPid; HANDLE parent = parent_process(&parentPid);
  HANDLE token, restricted;
  checked(OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY | TOKEN_DUPLICATE | TOKEN_ASSIGN_PRIMARY | TOKEN_ADJUST_DEFAULT, &token), "host token");
  DWORD length = 0; GetTokenInformation(token, TokenUser, NULL, 0, &length);
  TOKEN_USER *user = calloc(1, length);
  if (!user) fail("user allocation");
  checked(GetTokenInformation(token, TokenUser, user, length, &length), "user identity");
  LUID luid; checked(AllocateLocallyUniqueId(&luid), "scope identity");
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
  if (!cacheIsScratch) roots[rootCount++] = grant_tree(cache, security, TRUE);
  PSECURITY_DESCRIPTOR readonlySecurity = execution_security(userText, sidText, FALSE);
  wchar_t *runtime = stage_execution_runtime(argv[6], argv[1], readonlySecurity);
  LocalFree(readonlySecurity);
  BOOL present, defaulted; PACL dacl;
  PSECURITY_DESCRIPTOR objectSecurity = execution_object_security(userText, sidText);
  checked(GetSecurityDescriptorDacl(objectSecurity, &present, &dacl, &defaulted) && present, "process DACL");
  TOKEN_DEFAULT_DACL defaultDacl = { dacl };
  checked(SetTokenInformation(restricted, TokenDefaultDacl, &defaultDacl, sizeof(defaultDacl)), "child process security");
  wchar_t eventBase[192], eventName[192];
  DWORD eventLength = GetEnvironmentVariableW(L"DEVRYAN_EXECUTION_CANCEL_EVENT", eventBase, 192);
  if (!eventLength || eventLength >= 192) fail("cancel identity");
  FILETIME supervisorCreated = {0}, supervisorExited = {0}, supervisorKernel = {0}, supervisorUser = {0};
  checked(GetProcessTimes(GetCurrentProcess(), &supervisorCreated, &supervisorExited, &supervisorKernel, &supervisorUser), "cancel creation identity");
  cancel_event_name(eventBase, GetCurrentProcessId(), supervisorCreated, eventName);
  HANDLE cancel = CreateEventW(&receiptAttributes, TRUE, FALSE, eventName);
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
  if (reason != WAIT_OBJECT_0 && reason != WAIT_OBJECT_0 + 1 && reason != WAIT_OBJECT_0 + 2) fail("owned process wait");
  BOOL cancelled = reason != WAIT_OBJECT_0;
  if (!cancelled) checked(GetExitCodeProcess(process.hProcess, &code), "command result");
  checked(TerminateJobObject(job, cancelled ? 130 : code), "stop descendants");
  ULONGLONG settlementDeadline = GetTickCount64() + 5000;
  for (;;) {
    JOBOBJECT_BASIC_ACCOUNTING_INFORMATION state;
    checked(QueryInformationJobObject(job, JobObjectBasicAccountingInformation, &state, sizeof(state), NULL), "termination acknowledgement");
    if (!state.ActiveProcesses) break;
    if (GetTickCount64() >= settlementDeadline) { SetLastError(ERROR_TIMEOUT); fail("descendant settlement bound"); }
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
  for (DWORD i = 0; i < receiptParentCount; i++) CloseHandle(receiptParents[i]);
  LocalFree(receiptSecurity);
  for (DWORD i = 0; i < rootCount; i++) CloseHandle(roots[i]);
  CloseHandle(cacheRoot);
  for (DWORD i = 0; i < cacheParentCount; i++) CloseHandle(cacheParents[i]);
  for (DWORD i = 0; i < 4; i++) for (DWORD j = 0; j < scopeCounts[i]; j++) CloseHandle(scopeParents[i][j]);
  CloseHandle(cancel); CloseHandle(parent); CloseDesktop(desktop); CloseHandle(restricted); CloseHandle(token);
  DeleteProcThreadAttributeList(startup.lpAttributeList); free(startup.lpAttributeList); free(command); free(user);
  CloseHandle(policy); free(runtime);
  for (DWORD i = 0; i < capabilityCount; i++) LocalFree(capabilities[i].Sid);
  free(capabilities);
  LocalFree(objectSecurity); LocalFree(security); LocalFree(sidText); LocalFree(userText); LocalFree(integrity); FreeSid(sid);
  return (int)code;
}
