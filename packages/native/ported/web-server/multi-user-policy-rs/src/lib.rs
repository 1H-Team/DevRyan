//! JS bindings for `policy.js`: generated from the signatures in `port.rs` by rust-anything.
//! Regenerate with `rust-anything refresh` after changing them.

use napi_derive::napi;

pub mod js;
pub mod port;
pub mod wire;

#[allow(unused_imports)]
use serde_json::Value;

fn panic_message(payload: &(dyn std::any::Any + Send)) -> String {
    payload
        .downcast_ref::<&str>()
        .map(|s| (*s).to_string())
        .or_else(|| payload.downcast_ref::<String>().cloned())
        .unwrap_or_else(|| "unknown panic".into())
}

#[allow(dead_code)]
fn run<T>(f: impl FnOnce() -> Result<T, String>) -> napi::Result<T> {
    match std::panic::catch_unwind(std::panic::AssertUnwindSafe(f)) {
        Ok(result) => result.map_err(napi::Error::from_reason),
        Err(payload) => Err(napi::Error::from_reason(format!("Rust panic: {}", panic_message(&*payload)))),
    }
}

/// `settingsPermissionsFromLegacyPages`.
#[napi(js_name = "settingsPermissionsFromLegacyPages")]
pub fn settings_permissions_from_legacy_pages(pages: String, arg1: String) -> napi::Result<String> {
    run(move || {
        let pages = crate::js::from_json(&pages)?;
        let arg1 = crate::js::from_json(&arg1)?;
        let out = port::settings_permissions_from_legacy_pages(pages, arg1)?;
        crate::js::to_json(&out)
    })
}

/// `buildUserPolicyResetRow`.
#[napi(js_name = "buildUserPolicyResetRow")]
pub fn build_user_policy_reset_row(user_id: String) -> napi::Result<String> {
    run(move || {
        let user_id = crate::js::from_json(&user_id)?;
        let out = port::build_user_policy_reset_row(user_id)?;
        crate::js::to_json(&out)
    })
}

/// `validateFeatureOverridesPayload`.
#[napi(js_name = "validateFeatureOverridesPayload")]
pub fn validate_feature_overrides_payload(value: String) -> napi::Result<String> {
    run(move || {
        let value = crate::js::from_json(&value)?;
        let out = port::validate_feature_overrides_payload(value)?;
        crate::js::to_json(&out)
    })
}

/// `validateSettingsPermissionsPayload`.
#[napi(js_name = "validateSettingsPermissionsPayload")]
pub fn validate_settings_permissions_payload(value: String, arg1: String) -> napi::Result<String> {
    run(move || {
        let value = crate::js::from_json(&value)?;
        let arg1 = crate::js::from_json(&arg1)?;
        let out = port::validate_settings_permissions_payload(value, arg1)?;
        crate::js::to_json(&out)
    })
}

/// `normalizeRolePolicy`.
#[napi(js_name = "normalizeRolePolicy")]
pub fn normalize_role_policy(role: String, row: String, user_policy: String) -> napi::Result<String> {
    run(move || {
        let role = crate::js::from_json(&role)?;
        let row = crate::js::from_json(&row)?;
        let user_policy = crate::js::from_json(&user_policy)?;
        let out = port::normalize_role_policy(role, row, user_policy)?;
        crate::js::to_json(&out)
    })
}

/// `canReadSettingsPage`.
#[napi(js_name = "canReadSettingsPage")]
pub fn can_read_settings_page(principal: String, raw_slug: String) -> napi::Result<String> {
    run(move || {
        let principal = crate::js::from_json(&principal)?;
        let raw_slug = crate::js::from_json(&raw_slug)?;
        let out = port::can_read_settings_page(principal, raw_slug)?;
        crate::js::to_json(&out)
    })
}

/// `canEditSettingsPage`.
#[napi(js_name = "canEditSettingsPage")]
pub fn can_edit_settings_page(principal: String, raw_slug: String) -> napi::Result<String> {
    run(move || {
        let principal = crate::js::from_json(&principal)?;
        let raw_slug = crate::js::from_json(&raw_slug)?;
        let out = port::can_edit_settings_page(principal, raw_slug)?;
        crate::js::to_json(&out)
    })
}

/// `canUseBrowser`.
#[napi(js_name = "canUseBrowser")]
pub fn can_use_browser(principal: String) -> napi::Result<String> {
    run(move || {
        let principal = crate::js::from_json(&principal)?;
        let out = port::can_use_browser(principal)?;
        crate::js::to_json(&out)
    })
}

/// `settingsPageForRequest`.
#[napi(js_name = "settingsPageForRequest")]
pub fn settings_page_for_request(request_path: String, method: String) -> napi::Result<String> {
    run(move || {
        let request_path = crate::js::from_json(&request_path)?;
        let method = crate::js::from_json(&method)?;
        let out = port::settings_page_for_request(request_path, method)?;
        crate::js::to_json(&out)
    })
}

/// `buildEffectiveSettings`.
#[napi(js_name = "buildEffectiveSettings")]
pub fn build_effective_settings(arg0: String) -> napi::Result<String> {
    run(move || {
        let arg0 = crate::js::from_json(&arg0)?;
        let out = port::build_effective_settings(arg0)?;
        crate::js::to_json(&out)
    })
}

/// `validateSettingsChanges`.
#[napi(js_name = "validateSettingsChanges")]
pub fn validate_settings_changes(arg0: String) -> napi::Result<String> {
    run(move || {
        let arg0 = crate::js::from_json(&arg0)?;
        let out = port::validate_settings_changes(arg0)?;
        crate::js::to_json(&out)
    })
}

/// `publicPrincipal`.
#[napi(js_name = "publicPrincipal")]
pub fn public_principal(principal: String) -> napi::Result<String> {
    run(move || {
        let principal = crate::js::from_json(&principal)?;
        let out = port::public_principal(principal)?;
        crate::js::to_json(&out)
    })
}

// ---- the binary wire ------------------------------------------------------------------------

type WireBuffers = (
    napi::bindgen_prelude::Uint8Array,
    napi::bindgen_prelude::Uint8Array,
    napi::bindgen_prelude::Uint32Array,
);

thread_local! {
    static WIRE: std::cell::RefCell<Option<WireBuffers>> = const { std::cell::RefCell::new(None) };
    static PENDING: std::cell::RefCell<Vec<u8>> = const { std::cell::RefCell::new(Vec::new()) };
    static SCRATCH: std::cell::RefCell<Vec<u8>> = const { std::cell::RefCell::new(Vec::new()) };
}

/// Registers the argument, result and argument-length buffers `index.cjs` uses.
#[napi(js_name = "rustAnythingWireInit")]
pub fn rust_anything_wire_init(input: napi::bindgen_prelude::Uint8Array, output: napi::bindgen_prelude::Uint8Array, len: napi::bindgen_prelude::Uint32Array) {
    WIRE.with(|w| *w.borrow_mut() = Some((input, output, len)));
}

/// Copies a result that did not fit into the (now larger) result buffer.
#[napi(js_name = "rustAnythingWireFlush")]
pub fn rust_anything_wire_flush() -> f64 {
    let bytes = PENDING.with(|p| std::mem::take(&mut *p.borrow_mut()));
    WIRE.with(|w| {
        let mut w = w.borrow_mut();
        let Some((_, output, _)) = w.as_mut() else {
            return -1.0;
        };
        // SAFETY: the call is synchronous; JS does not touch `output` until it returns.
        let out = unsafe { output.as_mut() };
        let n = bytes.len().min(out.len());
        out[..n].copy_from_slice(&bytes[..n]);
        n as f64
    })
}

/// Reads the argument bytes (`wLen[0]` of them), runs `f`, and writes its result; a negative
/// return is the size of a result that did not fit, kept for `rustAnythingWireFlush`.
fn wire_io(f: impl FnOnce(&mut wire::Reader, &mut wire::Writer) -> Result<(), String>) -> napi::Result<f64> {
    WIRE.with(|cell| {
        let mut guard = cell.borrow_mut();
        let Some((input, output, len)) = guard.as_mut() else {
            return Err(napi::Error::from_reason("rust-anything: the wire buffers are not registered"));
        };
        let len = (len.first().copied().unwrap_or(0) as usize).min(input.len());
        let mut w = wire::Writer(SCRATCH.with(|s| std::mem::take(&mut *s.borrow_mut())));
        w.0.clear();
        let result = run(|| f(&mut wire::Reader::new(&input[..len]), &mut w));
        let keep = |w: wire::Writer| SCRATCH.with(|s| *s.borrow_mut() = w.0);
        match result {
            // A result of another shape than the TS type: JS runs the call through JSON.
            Err(e) if e.reason.starts_with(wire::MISMATCH) => {
                keep(w);
                return Ok(f64::NAN);
            }
            Err(e) => {
                keep(w);
                let mut m = wire::Writer::default();
                m.string16(&e.reason);
                // SAFETY: the call is synchronous; JS does not touch `output` until it returns.
                let out = unsafe { output.as_mut() };
                if m.0.len() > out.len() {
                    return Err(e);
                }
                out[..m.0.len()].copy_from_slice(&m.0);
                return Ok(f64::INFINITY);
            }
            Ok(()) => {}
        }
        // SAFETY: the call is synchronous; JS does not touch `output` until it returns.
        let out = unsafe { output.as_mut() };
        let n = w.0.len();
        if n > out.len() {
            PENDING.with(|p| *p.borrow_mut() = w.0);
            return Ok(-(n as f64));
        }
        out[..n].copy_from_slice(&w.0);
        keep(w);
        Ok(n as f64)
    })
}

static S_SETTINGS_PERMISSIONS_FROM_LEGACY_PAGES_0: wire::Schema = wire::Schema::Dyn;
static S_SETTINGS_PERMISSIONS_FROM_LEGACY_PAGES_1: wire::Schema = wire::Schema::Dyn;
static S_SETTINGS_PERMISSIONS_FROM_LEGACY_PAGES_OUT: wire::Schema = wire::Schema::Dyn;

/// `settingsPermissionsFromLegacyPages` over the binary wire.
#[napi(js_name = "settingsPermissionsFromLegacyPagesWire")]
pub fn settings_permissions_from_legacy_pages_wire() -> napi::Result<f64> {
    wire_io(|r, w| {
        let pages: Value = wire::read_value(r, &S_SETTINGS_PERMISSIONS_FROM_LEGACY_PAGES_0)?;
        let arg1: Value = wire::read_value(r, &S_SETTINGS_PERMISSIONS_FROM_LEGACY_PAGES_1)?;
        let out = &port::settings_permissions_from_legacy_pages(pages, arg1)?;
        wire::write_value(w, out, &S_SETTINGS_PERMISSIONS_FROM_LEGACY_PAGES_OUT)?;
        Ok(())
    })
}

static S_BUILD_USER_POLICY_RESET_ROW_0: wire::Schema = wire::Schema::Dyn;
static S_BUILD_USER_POLICY_RESET_ROW_OUT: wire::Schema = wire::Schema::Dyn;

/// `buildUserPolicyResetRow` over the binary wire.
#[napi(js_name = "buildUserPolicyResetRowWire")]
pub fn build_user_policy_reset_row_wire() -> napi::Result<f64> {
    wire_io(|r, w| {
        let user_id: Value = wire::read_value(r, &S_BUILD_USER_POLICY_RESET_ROW_0)?;
        let out = &port::build_user_policy_reset_row(user_id)?;
        wire::write_value(w, out, &S_BUILD_USER_POLICY_RESET_ROW_OUT)?;
        Ok(())
    })
}

static S_VALIDATE_FEATURE_OVERRIDES_PAYLOAD_0: wire::Schema = wire::Schema::Dyn;
static S_VALIDATE_FEATURE_OVERRIDES_PAYLOAD_OUT: wire::Schema = wire::Schema::Dyn;

/// `validateFeatureOverridesPayload` over the binary wire.
#[napi(js_name = "validateFeatureOverridesPayloadWire")]
pub fn validate_feature_overrides_payload_wire() -> napi::Result<f64> {
    wire_io(|r, w| {
        let value: Value = wire::read_value(r, &S_VALIDATE_FEATURE_OVERRIDES_PAYLOAD_0)?;
        let out = &port::validate_feature_overrides_payload(value)?;
        wire::write_value(w, out, &S_VALIDATE_FEATURE_OVERRIDES_PAYLOAD_OUT)?;
        Ok(())
    })
}

static S_VALIDATE_SETTINGS_PERMISSIONS_PAYLOAD_0: wire::Schema = wire::Schema::Dyn;
static S_VALIDATE_SETTINGS_PERMISSIONS_PAYLOAD_1: wire::Schema = wire::Schema::Dyn;
static S_VALIDATE_SETTINGS_PERMISSIONS_PAYLOAD_OUT: wire::Schema = wire::Schema::Dyn;

/// `validateSettingsPermissionsPayload` over the binary wire.
#[napi(js_name = "validateSettingsPermissionsPayloadWire")]
pub fn validate_settings_permissions_payload_wire() -> napi::Result<f64> {
    wire_io(|r, w| {
        let value: Value = wire::read_value(r, &S_VALIDATE_SETTINGS_PERMISSIONS_PAYLOAD_0)?;
        let arg1: Value = wire::read_value(r, &S_VALIDATE_SETTINGS_PERMISSIONS_PAYLOAD_1)?;
        let out = &port::validate_settings_permissions_payload(value, arg1)?;
        wire::write_value(w, out, &S_VALIDATE_SETTINGS_PERMISSIONS_PAYLOAD_OUT)?;
        Ok(())
    })
}

static S_NORMALIZE_ROLE_POLICY_0: wire::Schema = wire::Schema::Dyn;
static S_NORMALIZE_ROLE_POLICY_1: wire::Schema = wire::Schema::Dyn;
static S_NORMALIZE_ROLE_POLICY_2: wire::Schema = wire::Schema::Dyn;
static S_NORMALIZE_ROLE_POLICY_OUT: wire::Schema = wire::Schema::Dyn;

/// `normalizeRolePolicy` over the binary wire.
#[napi(js_name = "normalizeRolePolicyWire")]
pub fn normalize_role_policy_wire() -> napi::Result<f64> {
    wire_io(|r, w| {
        let role: Value = wire::read_value(r, &S_NORMALIZE_ROLE_POLICY_0)?;
        let row: Value = wire::read_value(r, &S_NORMALIZE_ROLE_POLICY_1)?;
        let user_policy: Value = wire::read_value(r, &S_NORMALIZE_ROLE_POLICY_2)?;
        let out = &port::normalize_role_policy(role, row, user_policy)?;
        wire::write_value(w, out, &S_NORMALIZE_ROLE_POLICY_OUT)?;
        Ok(())
    })
}

static S_CAN_READ_SETTINGS_PAGE_0: wire::Schema = wire::Schema::Dyn;
static S_CAN_READ_SETTINGS_PAGE_1: wire::Schema = wire::Schema::Dyn;
static S_CAN_READ_SETTINGS_PAGE_OUT: wire::Schema = wire::Schema::Dyn;

/// `canReadSettingsPage` over the binary wire.
#[napi(js_name = "canReadSettingsPageWire")]
pub fn can_read_settings_page_wire() -> napi::Result<f64> {
    wire_io(|r, w| {
        let principal: Value = wire::read_value(r, &S_CAN_READ_SETTINGS_PAGE_0)?;
        let raw_slug: Value = wire::read_value(r, &S_CAN_READ_SETTINGS_PAGE_1)?;
        let out = &port::can_read_settings_page(principal, raw_slug)?;
        wire::write_value(w, out, &S_CAN_READ_SETTINGS_PAGE_OUT)?;
        Ok(())
    })
}

static S_CAN_EDIT_SETTINGS_PAGE_0: wire::Schema = wire::Schema::Dyn;
static S_CAN_EDIT_SETTINGS_PAGE_1: wire::Schema = wire::Schema::Dyn;
static S_CAN_EDIT_SETTINGS_PAGE_OUT: wire::Schema = wire::Schema::Dyn;

/// `canEditSettingsPage` over the binary wire.
#[napi(js_name = "canEditSettingsPageWire")]
pub fn can_edit_settings_page_wire() -> napi::Result<f64> {
    wire_io(|r, w| {
        let principal: Value = wire::read_value(r, &S_CAN_EDIT_SETTINGS_PAGE_0)?;
        let raw_slug: Value = wire::read_value(r, &S_CAN_EDIT_SETTINGS_PAGE_1)?;
        let out = &port::can_edit_settings_page(principal, raw_slug)?;
        wire::write_value(w, out, &S_CAN_EDIT_SETTINGS_PAGE_OUT)?;
        Ok(())
    })
}

static S_CAN_USE_BROWSER_0: wire::Schema = wire::Schema::Dyn;
static S_CAN_USE_BROWSER_OUT: wire::Schema = wire::Schema::Dyn;

/// `canUseBrowser` over the binary wire.
#[napi(js_name = "canUseBrowserWire")]
pub fn can_use_browser_wire() -> napi::Result<f64> {
    wire_io(|r, w| {
        let principal: Value = wire::read_value(r, &S_CAN_USE_BROWSER_0)?;
        let out = &port::can_use_browser(principal)?;
        wire::write_value(w, out, &S_CAN_USE_BROWSER_OUT)?;
        Ok(())
    })
}

static S_SETTINGS_PAGE_FOR_REQUEST_0: wire::Schema = wire::Schema::Dyn;
static S_SETTINGS_PAGE_FOR_REQUEST_1: wire::Schema = wire::Schema::Dyn;
static S_SETTINGS_PAGE_FOR_REQUEST_OUT: wire::Schema = wire::Schema::Dyn;

/// `settingsPageForRequest` over the binary wire.
#[napi(js_name = "settingsPageForRequestWire")]
pub fn settings_page_for_request_wire() -> napi::Result<f64> {
    wire_io(|r, w| {
        let request_path: Value = wire::read_value(r, &S_SETTINGS_PAGE_FOR_REQUEST_0)?;
        let method: Value = wire::read_value(r, &S_SETTINGS_PAGE_FOR_REQUEST_1)?;
        let out = &port::settings_page_for_request(request_path, method)?;
        wire::write_value(w, out, &S_SETTINGS_PAGE_FOR_REQUEST_OUT)?;
        Ok(())
    })
}

static S_BUILD_EFFECTIVE_SETTINGS_0: wire::Schema = wire::Schema::Dyn;
static S_BUILD_EFFECTIVE_SETTINGS_OUT: wire::Schema = wire::Schema::Dyn;

/// `buildEffectiveSettings` over the binary wire.
#[napi(js_name = "buildEffectiveSettingsWire")]
pub fn build_effective_settings_wire() -> napi::Result<f64> {
    wire_io(|r, w| {
        let arg0: Value = wire::read_value(r, &S_BUILD_EFFECTIVE_SETTINGS_0)?;
        let out = &port::build_effective_settings(arg0)?;
        wire::write_value(w, out, &S_BUILD_EFFECTIVE_SETTINGS_OUT)?;
        Ok(())
    })
}

static S_VALIDATE_SETTINGS_CHANGES_0: wire::Schema = wire::Schema::Dyn;
static S_VALIDATE_SETTINGS_CHANGES_OUT: wire::Schema = wire::Schema::Dyn;

/// `validateSettingsChanges` over the binary wire.
#[napi(js_name = "validateSettingsChangesWire")]
pub fn validate_settings_changes_wire() -> napi::Result<f64> {
    wire_io(|r, w| {
        let arg0: Value = wire::read_value(r, &S_VALIDATE_SETTINGS_CHANGES_0)?;
        let out = &port::validate_settings_changes(arg0)?;
        wire::write_value(w, out, &S_VALIDATE_SETTINGS_CHANGES_OUT)?;
        Ok(())
    })
}

static S_PUBLIC_PRINCIPAL_0: wire::Schema = wire::Schema::Dyn;
static S_PUBLIC_PRINCIPAL_OUT: wire::Schema = wire::Schema::Dyn;

/// `publicPrincipal` over the binary wire.
#[napi(js_name = "publicPrincipalWire")]
pub fn public_principal_wire() -> napi::Result<f64> {
    wire_io(|r, w| {
        let principal: Value = wire::read_value(r, &S_PUBLIC_PRINCIPAL_0)?;
        let out = &port::public_principal(principal)?;
        wire::write_value(w, out, &S_PUBLIC_PRINCIPAL_OUT)?;
        Ok(())
    })
}
