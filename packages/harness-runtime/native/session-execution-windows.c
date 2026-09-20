/* DevRyan Windows execution supervisor. Uses only Windows SDK facilities.
 * A write-restricted token and untrusted integrity level restrict mutations to
 * the private trees. A private desktop and job contain the entire process tree.
 * The command receives only its three pipe handles, never the job or receipt.
 */
#define UNICODE
#define _UNICODE
#define _WIN32_WINNT 0x0A00
#include <windows.h>
#include <aclapi.h>
#include <sddl.h>
#include <wincrypt.h>
#include <tlhelp32.h>
#include <stdio.h>
#include <stdlib.h>
#include <wchar.h>

static void fail(const char *operation) {
  fprintf(stderr, "%s failed (%lu)\n", operation, GetLastError());
  ExitProcess(125);
}
static void checked(BOOL ok, const char *operation) { if (!ok) fail(operation); }
static wchar_t *joined(const wchar_t *left, const wchar_t *right) {
  size_t n = wcslen(left) + wcslen(right) + 2;
  wchar_t *value = calloc(n, sizeof(wchar_t));
  if (!value) fail("allocation");
  swprintf(value, n, L"%s\\%s", left, right); return value;
}

/* Never follow a reparse point while granting access. A hard link in the view
 * would share the source security descriptor, so reject multiply linked files
 * before changing any label or DACL. Views are copied, not hard linked. */
static void grant_tree(const wchar_t *name, PSECURITY_DESCRIPTOR security) {
  HANDLE file = CreateFileW(name, READ_CONTROL | WRITE_DAC | WRITE_OWNER | FILE_READ_ATTRIBUTES,
    FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE, NULL, OPEN_EXISTING,
    FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT, NULL);
  if (file == INVALID_HANDLE_VALUE) fail("private tree handle");
  BY_HANDLE_FILE_INFORMATION info;
  checked(GetFileInformationByHandle(file, &info), "private tree attributes");
  if (info.dwFileAttributes & FILE_ATTRIBUTE_REPARSE_POINT) { CloseHandle(file); return; }
  if (!(info.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY) && info.nNumberOfLinks > 1) {
    SetLastError(ERROR_ACCESS_DENIED); fail("private tree hard link");
  }
  BOOL present, defaulted; PACL dacl, sacl;
  checked(GetSecurityDescriptorDacl(security, &present, &dacl, &defaulted) && present, "private DACL");
  checked(GetSecurityDescriptorSacl(security, &present, &sacl, &defaulted) && present, "private integrity");
  DWORD error = SetSecurityInfo(file, SE_FILE_OBJECT,
    DACL_SECURITY_INFORMATION | PROTECTED_DACL_SECURITY_INFORMATION | LABEL_SECURITY_INFORMATION,
    NULL, NULL, dacl, sacl);
  CloseHandle(file);
  if (error != ERROR_SUCCESS) { SetLastError(error); fail("private tree security"); }
  if (!(info.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY)) return;
  wchar_t *pattern = joined(name, L"*"); WIN32_FIND_DATAW found;
  HANDLE search = FindFirstFileW(pattern, &found); free(pattern);
  if (search == INVALID_HANDLE_VALUE) {
    if (GetLastError() == ERROR_FILE_NOT_FOUND) return;
    fail("private tree enumeration");
  }
  do {
    if (!wcscmp(found.cFileName, L".") || !wcscmp(found.cFileName, L"..")) continue;
    wchar_t *child = joined(name, found.cFileName); grant_tree(child, security); free(child);
  } while (FindNextFileW(search, &found));
  if (GetLastError() != ERROR_NO_MORE_FILES) fail("private tree enumeration");
  FindClose(search);
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

static PSID cache_sid(const wchar_t *directory) {
  HCRYPTPROV provider; HCRYPTHASH hash; BYTE digest[32]; DWORD size = sizeof(digest);
  checked(CryptAcquireContextW(&provider, NULL, NULL, PROV_RSA_AES, CRYPT_VERIFYCONTEXT), "cache identity provider");
  checked(CryptCreateHash(provider, CALG_SHA_256, 0, 0, &hash), "cache identity hash");
  checked(CryptHashData(hash, (const BYTE *)directory, (DWORD)(wcslen(directory) * sizeof(wchar_t)), 0), "cache identity input");
  checked(CryptGetHashParam(hash, HP_HASHVAL, digest, &size, 0), "cache identity output");
  CryptDestroyHash(hash); CryptReleaseContext(provider, 0);
  DWORD parts[4]; memcpy(parts, digest, sizeof(parts));
  SID_IDENTIFIER_AUTHORITY authority = SECURITY_NT_AUTHORITY; PSID sid;
  checked(AllocateAndInitializeSid(&authority, 5, SECURITY_SERVICE_ID_BASE_RID, parts[0], parts[1], parts[2], parts[3],
    0, 0, 0, &sid), "cache SID");
  return sid;
}

int wmain(int argc, wchar_t **argv) {
  // The host uses a named cancellation event because TerminateProcess would
  // close the job safely but could not write a termination acknowledgement.
  if (argc == 3 && !wcscmp(argv[1], L"--cancel")) {
    HANDLE event = OpenEventW(EVENT_MODIFY_STATE, FALSE, argv[2]);
    if (!event) fail("cancel event"); checked(SetEvent(event), "cancel signal"); CloseHandle(event); return 0;
  }
  if (argc < 7 || wcscmp(argv[5], L"--")) return 125;
  HANDLE receipt = CreateFileW(argv[4], GENERIC_WRITE, 0, NULL, CREATE_NEW, FILE_ATTRIBUTE_NORMAL, NULL);
  if (receipt == INVALID_HANDLE_VALUE) fail("exclusive receipt");
  HANDLE parent = OpenProcess(SYNCHRONIZE | PROCESS_QUERY_LIMITED_INFORMATION, FALSE, parent_id());
  if (!parent) fail("owner handle");
  HANDLE token, restricted;
  checked(OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY | TOKEN_DUPLICATE | TOKEN_ASSIGN_PRIMARY, &token), "host token");
  DWORD length = 0; GetTokenInformation(token, TokenUser, NULL, 0, &length);
  TOKEN_USER *user = calloc(1, length);
  if (!user) fail("user allocation");
  checked(GetTokenInformation(token, TokenUser, user, length, &length), "user identity");
  LUID luid; checked(AllocateLocallyUniqueId(&luid), "scope identity");
  SID_IDENTIFIER_AUTHORITY authority = SECURITY_NT_AUTHORITY; PSID sid;
  checked(AllocateAndInitializeSid(&authority, 3, SECURITY_LOGON_IDS_RID, (DWORD)luid.HighPart, luid.LowPart,
    0, 0, 0, 0, 0, &sid), "scope SID");
  const wchar_t *cache = _wgetenv(L"DEVRYAN_EXECUTION_CACHE");
  PSID cacheSid = cache_sid(cache ? cache : argv[2]);
  SID_AND_ATTRIBUTES scopes[] = { { sid, 0 }, { cacheSid, 0 } };
  checked(CreateRestrictedToken(token, DISABLE_MAX_PRIVILEGE | WRITE_RESTRICTED | LUA_TOKEN,
    0, NULL, 0, NULL, 2, scopes, &restricted), "restricted token");
  PSID integrity; checked(ConvertStringSidToSidW(L"S-1-16-0", &integrity), "integrity SID");
  TOKEN_MANDATORY_LABEL label = { { integrity, SE_GROUP_INTEGRITY } };
  checked(SetTokenInformation(restricted, TokenIntegrityLevel, &label, sizeof(label) + GetLengthSid(integrity)), "untrusted integrity");
  LPWSTR sidText, userText;
  checked(ConvertSidToStringSidW(sid, &sidText), "scope string");
  checked(ConvertSidToStringSidW(user->User.Sid, &userText), "owner string");
  wchar_t descriptor[1024];
  swprintf(descriptor, 1024, L"D:P(A;OICI;GA;;;%s)(A;OICI;GA;;;%s)S:(ML;OICI;NW;;;S-1-16-0)", sidText, userText);
  PSECURITY_DESCRIPTOR security;
  checked(ConvertStringSecurityDescriptorToSecurityDescriptorW(descriptor, SDDL_REVISION_1, &security, NULL), "scope security");
  grant_tree(argv[1], security); grant_tree(argv[2], security);
  if (cache && wcscmp(cache, argv[2])) {
    LPWSTR cacheText; PSECURITY_DESCRIPTOR cacheSecurity;
    checked(ConvertSidToStringSidW(cacheSid, &cacheText), "cache SID string");
    swprintf(descriptor, 1024, L"D:P(A;OICI;GA;;;%s)(A;OICI;GA;;;%s)S:(ML;OICI;NW;;;S-1-16-0)", cacheText, userText);
    checked(ConvertStringSecurityDescriptorToSecurityDescriptorW(descriptor, SDDL_REVISION_1, &cacheSecurity, NULL), "cache security");
    grant_tree(cache, cacheSecurity); LocalFree(cacheSecurity); LocalFree(cacheText);
  }
  BOOL present, defaulted; PACL dacl;
  checked(GetSecurityDescriptorDacl(security, &present, &dacl, &defaulted) && present, "process DACL");
  TOKEN_DEFAULT_DACL defaultDacl = { dacl };
  checked(SetTokenInformation(restricted, TokenDefaultDacl, &defaultDacl, sizeof(defaultDacl)), "child process security");
  wchar_t eventName[192];
  DWORD eventLength = GetEnvironmentVariableW(L"DEVRYAN_EXECUTION_CANCEL_EVENT", eventName, 192);
  if (!eventLength || eventLength >= 192) fail("cancel identity");
  HANDLE cancel = CreateEventW(NULL, TRUE, FALSE, eventName);
  if (!cancel || GetLastError() == ERROR_ALREADY_EXISTS) fail("exclusive cancel event");
  wchar_t desktopName[96]; swprintf(desktopName, 96, L"DevRyan-%lu-%lu", (DWORD)luid.HighPart, luid.LowPart);
  SECURITY_ATTRIBUTES desktopSecurity = { sizeof(desktopSecurity), security, FALSE };
  HDESK desktop = CreateDesktopW(desktopName, NULL, NULL, 0, GENERIC_ALL, &desktopSecurity);
  if (!desktop) fail("private desktop");
  HANDLE job = CreateJobObjectW(NULL, NULL);
  if (!job) fail("process job");
  JOBOBJECT_EXTENDED_LIMIT_INFORMATION limits = {0};
  limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE | JOB_OBJECT_LIMIT_DIE_ON_UNHANDLED_EXCEPTION;
  checked(SetInformationJobObject(job, JobObjectExtendedLimitInformation, &limits, sizeof(limits)), "job ownership");
  JOBOBJECT_BASIC_UI_RESTRICTIONS ui = { JOB_OBJECT_UILIMIT_ALL };
  checked(SetInformationJobObject(job, JobObjectBasicUIRestrictions, &ui, sizeof(ui)), "job UI boundary");
  STARTUPINFOEXW startup = {0}; startup.StartupInfo.cb = sizeof(startup); startup.StartupInfo.lpDesktop = desktopName;
  startup.StartupInfo.dwFlags = STARTF_USESTDHANDLES;
  HANDLE handles[3]; DWORD kinds[] = { STD_INPUT_HANDLE, STD_OUTPUT_HANDLE, STD_ERROR_HANDLE };
  for (unsigned int i = 0; i < 3; i++) {
    checked(DuplicateHandle(GetCurrentProcess(), GetStdHandle(kinds[i]), GetCurrentProcess(), &handles[i], 0, TRUE, DUPLICATE_SAME_ACCESS), "pipe handle");
  }
  startup.StartupInfo.hStdInput = handles[0]; startup.StartupInfo.hStdOutput = handles[1]; startup.StartupInfo.hStdError = handles[2];
  SIZE_T bytes = 0; InitializeProcThreadAttributeList(NULL, 1, 0, &bytes);
  startup.lpAttributeList = malloc(bytes); if (!startup.lpAttributeList) fail("handle list allocation");
  checked(InitializeProcThreadAttributeList(startup.lpAttributeList, 1, 0, &bytes), "handle list");
  checked(UpdateProcThreadAttribute(startup.lpAttributeList, 0, PROC_THREAD_ATTRIBUTE_HANDLE_LIST,
    handles, sizeof(handles), NULL, NULL), "inherited handle boundary");
  wchar_t cwd[32768]; DWORD cwdLength = GetEnvironmentVariableW(L"DEVRYAN_EXECUTION_CWD", cwd, 32768);
  if (!cwdLength || cwdLength >= 32768) wcscpy(cwd, argv[1]);
  wchar_t *command = command_line(argc, argv, 6); PROCESS_INFORMATION process = {0};
  checked(CreateProcessAsUserW(restricted, NULL, command, NULL, NULL, TRUE,
    CREATE_SUSPENDED | CREATE_NO_WINDOW | EXTENDED_STARTUPINFO_PRESENT, NULL, cwd, &startup.StartupInfo, &process), "confined command");
  if (!AssignProcessToJobObject(job, process.hProcess)) {
    DWORD error = GetLastError(); TerminateProcess(process.hProcess, 125); SetLastError(error); fail("command ownership");
  }
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
  char result[160]; int count = snprintf(result, sizeof(result), "{\"terminated\":true,\"confined\":true,\"cancelled\":%s,\"exitCode\":%lu}\n", cancelled ? "true" : "false", code);
  DWORD written; checked(WriteFile(receipt, result, count, &written, NULL) && written == (DWORD)count && FlushFileBuffers(receipt), "durable receipt");
  CloseHandle(receipt); CloseHandle(job); CloseHandle(process.hThread); CloseHandle(process.hProcess);
  CloseHandle(cancel); CloseHandle(parent); CloseDesktop(desktop); CloseHandle(restricted); CloseHandle(token);
  DeleteProcThreadAttributeList(startup.lpAttributeList); free(startup.lpAttributeList); free(command); free(user);
  LocalFree(security); LocalFree(sidText); LocalFree(userText); LocalFree(integrity); FreeSid(sid); FreeSid(cacheSid);
  return (int)code;
}
