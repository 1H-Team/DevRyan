#include <Foundation/Foundation.h>
#include <ServiceManagement/ServiceManagement.h>
#include <node_api.h>
#include <cerrno>
#include <cstdio>
#include <string>
#include <vector>

namespace {

constexpr const char* kPlistName = "dev.openchamber.desktop.runtime-service.plist";

const char* StateName(SMAppServiceStatus status) {
  switch (status) {
    case SMAppServiceStatusNotRegistered:
      return "not_registered";
    case SMAppServiceStatusEnabled:
      return "enabled";
    case SMAppServiceStatusRequiresApproval:
      return "requires_approval";
    case SMAppServiceStatusNotFound:
      return "not_found";
  }
  return "unknown";
}

void SetString(napi_env env, napi_value object, const char* key, const char* value) {
  napi_value field;
  napi_create_string_utf8(env, value, NAPI_AUTO_LENGTH, &field);
  napi_set_named_property(env, object, key, field);
}

void SetBoolean(napi_env env, napi_value object, const char* key, bool value) {
  napi_value field;
  napi_get_boolean(env, value, &field);
  napi_set_named_property(env, object, key, field);
}

napi_value Result(napi_env env, bool ok, SMAppServiceStatus status, const char* code) {
  napi_value result;
  napi_create_object(env, &result);
  SetBoolean(env, result, "ok", ok);
  SetString(env, result, "state", StateName(status));
  if (code == nullptr) {
    napi_value null_value;
    napi_get_null(env, &null_value);
    napi_set_named_property(env, result, "code", null_value);
  } else {
    SetString(env, result, "code", code);
  }
  return result;
}

SMAppService* RuntimeService() API_AVAILABLE(macos(13.0)) {
  return [SMAppService agentServiceWithPlistName:
      [NSString stringWithUTF8String:kPlistName]];
}

napi_value Status(napi_env env, napi_callback_info info) {
  (void)info;
  if (@available(macOS 13.0, *)) {
    SMAppService* service = RuntimeService();
    return Result(env, true, service.status, nullptr);
  }
  return Result(env, false, SMAppServiceStatusNotRegistered, "smappservice_unavailable");
}

napi_value Register(napi_env env, napi_callback_info info) {
  (void)info;
  if (@available(macOS 13.0, *)) {
    SMAppService* service = RuntimeService();
    NSError* error = nil;
    const bool registered = [service registerAndReturnError:&error];
    const SMAppServiceStatus status = service.status;
    if (registered || status == SMAppServiceStatusEnabled
        || status == SMAppServiceStatusRequiresApproval) {
      return Result(env, true, status, nullptr);
    }
    return Result(env, false, status, "smappservice_registration_failed");
  }
  return Result(env, false, SMAppServiceStatusNotRegistered, "smappservice_unavailable");
}

napi_value Unregister(napi_env env, napi_callback_info info) {
  (void)info;
  if (@available(macOS 13.0, *)) {
    SMAppService* service = RuntimeService();
    NSError* error = nil;
    const bool unregistered = [service unregisterAndReturnError:&error];
    const SMAppServiceStatus status = service.status;
    if (unregistered || status == SMAppServiceStatusNotRegistered) {
      return Result(env, true, status, nullptr);
    }
    return Result(env, false, status, "smappservice_unregistration_failed");
  }
  return Result(env, false, SMAppServiceStatusNotRegistered, "smappservice_unavailable");
}

// Node's rename replaces an existing directory. Installer publication and
// rollback must leave a concurrently created application untouched.
napi_value RenameApplication(napi_env env, napi_callback_info info) {
  size_t count = 2;
  napi_value args[2];
  void* swap = nullptr;
  napi_get_cb_info(env, info, &count, args, nullptr, &swap);
  std::string paths[2];
  if (count != 2) {
    napi_throw_type_error(env, "update_rename_arguments_invalid", "Two absolute paths are required");
    return nullptr;
  }
  for (size_t index = 0; index < 2; ++index) {
    size_t length = 0;
    if (napi_get_value_string_utf8(env, args[index], nullptr, 0, &length) != napi_ok
        || length == 0 || length > 4096) {
      napi_throw_type_error(env, "update_rename_arguments_invalid", "Invalid path");
      return nullptr;
    }
    std::vector<char> value(length + 1);
    napi_get_value_string_utf8(env, args[index], value.data(), value.size(), &length);
    paths[index].assign(value.data(), length);
    if (paths[index][0] != '/' || paths[index].find('\0') != std::string::npos) {
      napi_throw_type_error(env, "update_rename_arguments_invalid", "Invalid path");
      return nullptr;
    }
  }
  if (renamex_np(paths[0].c_str(), paths[1].c_str(), swap ? RENAME_SWAP : RENAME_EXCL) != 0) {
    napi_throw_error(env, errno == EEXIST ? "update_target_exists" : "update_rename_failed", "Exclusive application rename failed");
    return nullptr;
  }
  napi_value result;
  napi_get_undefined(env, &result);
  return result;
}

napi_value Initialize(napi_env env, napi_value exports) {
  napi_property_descriptor properties[] = {
    {"status", nullptr, Status, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"register", nullptr, Register, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"unregister", nullptr, Unregister, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"renameExclusive", nullptr, RenameApplication, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"swapApplications", nullptr, RenameApplication, nullptr, nullptr, nullptr, napi_default, reinterpret_cast<void*>(1)},
  };
  napi_define_properties(env, exports, sizeof(properties) / sizeof(properties[0]), properties);
  return exports;
}

}  // namespace

NAPI_MODULE(NODE_GYP_MODULE_NAME, Initialize)
