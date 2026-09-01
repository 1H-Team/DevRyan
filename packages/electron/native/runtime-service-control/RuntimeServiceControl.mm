#include <Foundation/Foundation.h>
#include <ServiceManagement/ServiceManagement.h>
#include <node_api.h>

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

napi_value Initialize(napi_env env, napi_value exports) {
  napi_property_descriptor properties[] = {
    {"status", nullptr, Status, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"register", nullptr, Register, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"unregister", nullptr, Unregister, nullptr, nullptr, nullptr, napi_default, nullptr},
  };
  napi_define_properties(env, exports, sizeof(properties) / sizeof(properties[0]), properties);
  return exports;
}

}  // namespace

NAPI_MODULE(NODE_GYP_MODULE_NAME, Initialize)
