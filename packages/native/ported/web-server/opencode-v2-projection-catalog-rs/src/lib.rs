//! JS bindings for `catalog.js`: generated from the signatures in `port.rs` by rust-anything.
//! Regenerate with `rust-anything refresh` after changing them.

use napi_derive::napi;

pub mod js;
pub mod port;
pub mod wire;

#[allow(unused_imports)]
use serde_json::Value;
pub mod utf16;

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

/// `redactCredentials`.
#[napi(js_name = "redactCredentials")]
pub fn redact_credentials(value: String) -> napi::Result<String> {
    run(move || {
        let value = crate::js::from_json(&value)?;
        let out = port::redact_credentials(value)?;
        crate::js::to_json(&out)
    })
}

/// `toV1ProviderPackage`.
#[napi(js_name = "toV1ProviderPackage")]
pub fn to_v1_provider_package(pkg: String) -> napi::Result<String> {
    run(move || {
        let pkg = crate::js::from_json(&pkg)?;
        let out = port::to_v1_provider_package(pkg)?;
        crate::js::to_json(&out)
    })
}

/// `toV1PermissionRuleset`.
#[napi(js_name = "toV1PermissionRuleset")]
pub fn to_v1_permission_ruleset(rules: String) -> napi::Result<String> {
    run(move || {
        let rules = crate::js::from_json(&rules)?;
        let out = port::to_v1_permission_ruleset(rules)?;
        crate::js::to_json(&out)
    })
}

/// `toV1Agent`.
#[napi(js_name = "toV1Agent")]
pub fn to_v1_agent(agent: String) -> napi::Result<String> {
    run(move || {
        let agent = crate::js::from_json(&agent)?;
        let out = port::to_v1_agent(agent)?;
        crate::js::to_json(&out)
    })
}

/// `toV1Agents`.
#[napi(js_name = "toV1Agents")]
pub fn to_v1_agents(agents: String) -> napi::Result<String> {
    run(move || {
        let agents = crate::js::from_json(&agents)?;
        let out = port::to_v1_agents(agents)?;
        crate::js::to_json(&out)
    })
}

/// `toV1Model`.
#[napi(js_name = "toV1Model")]
pub fn to_v1_model(model: String, provider: String) -> napi::Result<String> {
    run(move || {
        let model = crate::js::from_json(&model)?;
        let provider = crate::js::from_json(&provider)?;
        let out = port::to_v1_model(model, provider)?;
        crate::js::to_json(&out)
    })
}

/// `toV1Provider`.
#[napi(js_name = "toV1Provider")]
pub fn to_v1_provider(provider: String, models: String, options: String) -> napi::Result<String> {
    run(move || {
        let provider = crate::js::from_json(&provider)?;
        let models = crate::js::from_json(&models)?;
        let options = crate::js::from_json(&options)?;
        let out = port::to_v1_provider(provider, models, options)?;
        crate::js::to_json(&out)
    })
}

/// `toV1ConfigProviders`.
#[napi(js_name = "toV1ConfigProviders")]
pub fn to_v1_config_providers(arg0: String) -> napi::Result<String> {
    run(move || {
        let arg0 = crate::js::from_json(&arg0)?;
        let out = port::to_v1_config_providers(arg0)?;
        crate::js::to_json(&out)
    })
}

/// `toV1ProviderList`.
#[napi(js_name = "toV1ProviderList")]
pub fn to_v1_provider_list(arg0: String) -> napi::Result<String> {
    run(move || {
        let arg0 = crate::js::from_json(&arg0)?;
        let out = port::to_v1_provider_list(arg0)?;
        crate::js::to_json(&out)
    })
}

/// `toV1Commands`.
#[napi(js_name = "toV1Commands")]
pub fn to_v1_commands(commands: String, options: String) -> napi::Result<String> {
    run(move || {
        let commands = crate::js::from_json(&commands)?;
        let options = crate::js::from_json(&options)?;
        let out = port::to_v1_commands(commands, options)?;
        crate::js::to_json(&out)
    })
}

/// `toV1Skills`.
#[napi(js_name = "toV1Skills")]
pub fn to_v1_skills(skills: String) -> napi::Result<String> {
    run(move || {
        let skills = crate::js::from_json(&skills)?;
        let out = port::to_v1_skills(skills)?;
        crate::js::to_json(&out)
    })
}

/// `toV1McpStatus`.
#[napi(js_name = "toV1McpStatus")]
pub fn to_v1_mcp_status(servers: String) -> napi::Result<String> {
    run(move || {
        let servers = crate::js::from_json(&servers)?;
        let out = port::to_v1_mcp_status(servers)?;
        crate::js::to_json(&out)
    })
}

/// `mergeV2ConfigEntries`.
#[napi(js_name = "mergeV2ConfigEntries")]
pub fn merge_v2_config_entries(entries: String) -> napi::Result<String> {
    run(move || {
        let entries = crate::js::from_json(&entries)?;
        let out = port::merge_v2_config_entries(entries)?;
        crate::js::to_json(&out)
    })
}

/// `configDirectories`.
#[napi(js_name = "configDirectories")]
pub fn config_directories(entries: String) -> napi::Result<String> {
    run(move || {
        let entries = crate::js::from_json(&entries)?;
        let out = port::config_directories(entries)?;
        crate::js::to_json(&out)
    })
}

/// `toV1ModelSelection`.
#[napi(js_name = "toV1ModelSelection")]
pub fn to_v1_model_selection(selection: String) -> napi::Result<String> {
    run(move || {
        let selection = crate::js::from_json(&selection)?;
        let out = port::to_v1_model_selection(selection)?;
        crate::js::to_json(&out)
    })
}

/// `toV1Config`.
#[napi(js_name = "toV1Config")]
pub fn to_v1_config(entries: String) -> napi::Result<String> {
    run(move || {
        let entries = crate::js::from_json(&entries)?;
        let out = port::to_v1_config(entries)?;
        crate::js::to_json(&out)
    })
}

/// `toV1Path`.
#[napi(js_name = "toV1Path")]
pub fn to_v1_path(location: String, paths: String) -> napi::Result<String> {
    run(move || {
        let location = crate::js::from_json(&location)?;
        let paths = crate::js::from_json(&paths)?;
        let out = port::to_v1_path(location, paths)?;
        crate::js::to_json(&out)
    })
}

/// `toV1Project`.
#[napi(js_name = "toV1Project")]
pub fn to_v1_project(project: String) -> napi::Result<String> {
    run(move || {
        let project = crate::js::from_json(&project)?;
        let out = port::to_v1_project(project)?;
        crate::js::to_json(&out)
    })
}

/// `toV1Projects`.
#[napi(js_name = "toV1Projects")]
pub fn to_v1_projects(projects: String) -> napi::Result<String> {
    run(move || {
        let projects = crate::js::from_json(&projects)?;
        let out = port::to_v1_projects(projects)?;
        crate::js::to_json(&out)
    })
}

/// `toV1CurrentProject`.
#[napi(js_name = "toV1CurrentProject")]
pub fn to_v1_current_project(location: String, projects: String) -> napi::Result<String> {
    run(move || {
        let location = crate::js::from_json(&location)?;
        let projects = crate::js::from_json(&projects)?;
        let out = port::to_v1_current_project(location, projects)?;
        crate::js::to_json(&out)
    })
}

/// `toV1VcsInfo`.
#[napi(js_name = "toV1VcsInfo")]
pub fn to_v1_vcs_info(vcs: String) -> napi::Result<String> {
    run(move || {
        let vcs = crate::js::from_json(&vcs)?;
        let out = port::to_v1_vcs_info(vcs)?;
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

static S_REDACT_CREDENTIALS_0: wire::Schema = wire::Schema::Dyn;
static S_REDACT_CREDENTIALS_OUT: wire::Schema = wire::Schema::Dyn;

/// `redactCredentials` over the binary wire.
#[napi(js_name = "redactCredentialsWire")]
pub fn redact_credentials_wire() -> napi::Result<f64> {
    wire_io(|r, w| {
        let value: Value = wire::read_value(r, &S_REDACT_CREDENTIALS_0)?;
        let out = &port::redact_credentials(value)?;
        wire::write_value(w, out, &S_REDACT_CREDENTIALS_OUT)?;
        Ok(())
    })
}

static S_TO_V1_PROVIDER_PACKAGE_0: wire::Schema = wire::Schema::Dyn;
static S_TO_V1_PROVIDER_PACKAGE_OUT: wire::Schema = wire::Schema::Dyn;

/// `toV1ProviderPackage` over the binary wire.
#[napi(js_name = "toV1ProviderPackageWire")]
pub fn to_v1_provider_package_wire() -> napi::Result<f64> {
    wire_io(|r, w| {
        let pkg: Value = wire::read_value(r, &S_TO_V1_PROVIDER_PACKAGE_0)?;
        let out = &port::to_v1_provider_package(pkg)?;
        wire::write_value(w, out, &S_TO_V1_PROVIDER_PACKAGE_OUT)?;
        Ok(())
    })
}

static S_TO_V1_PERMISSION_RULESET_0: wire::Schema = wire::Schema::Dyn;
static S_TO_V1_PERMISSION_RULESET_OUT: wire::Schema = wire::Schema::Dyn;

/// `toV1PermissionRuleset` over the binary wire.
#[napi(js_name = "toV1PermissionRulesetWire")]
pub fn to_v1_permission_ruleset_wire() -> napi::Result<f64> {
    wire_io(|r, w| {
        let rules: Value = wire::read_value(r, &S_TO_V1_PERMISSION_RULESET_0)?;
        let out = &port::to_v1_permission_ruleset(rules)?;
        wire::write_value(w, out, &S_TO_V1_PERMISSION_RULESET_OUT)?;
        Ok(())
    })
}

static S_TO_V1_AGENT_0: wire::Schema = wire::Schema::Dyn;
static S_TO_V1_AGENT_OUT: wire::Schema = wire::Schema::Dyn;

/// `toV1Agent` over the binary wire.
#[napi(js_name = "toV1AgentWire")]
pub fn to_v1_agent_wire() -> napi::Result<f64> {
    wire_io(|r, w| {
        let agent: Value = wire::read_value(r, &S_TO_V1_AGENT_0)?;
        let out = &port::to_v1_agent(agent)?;
        wire::write_value(w, out, &S_TO_V1_AGENT_OUT)?;
        Ok(())
    })
}

static S_TO_V1_AGENTS_0: wire::Schema = wire::Schema::Dyn;
static S_TO_V1_AGENTS_OUT: wire::Schema = wire::Schema::Dyn;

/// `toV1Agents` over the binary wire.
#[napi(js_name = "toV1AgentsWire")]
pub fn to_v1_agents_wire() -> napi::Result<f64> {
    wire_io(|r, w| {
        let agents: Value = wire::read_value(r, &S_TO_V1_AGENTS_0)?;
        let out = &port::to_v1_agents(agents)?;
        wire::write_value(w, out, &S_TO_V1_AGENTS_OUT)?;
        Ok(())
    })
}

static S_TO_V1_MODEL_0: wire::Schema = wire::Schema::Dyn;
static S_TO_V1_MODEL_1: wire::Schema = wire::Schema::Dyn;
static S_TO_V1_MODEL_OUT: wire::Schema = wire::Schema::Dyn;

/// `toV1Model` over the binary wire.
#[napi(js_name = "toV1ModelWire")]
pub fn to_v1_model_wire() -> napi::Result<f64> {
    wire_io(|r, w| {
        let model: Value = wire::read_value(r, &S_TO_V1_MODEL_0)?;
        let provider: Value = wire::read_value(r, &S_TO_V1_MODEL_1)?;
        let out = &port::to_v1_model(model, provider)?;
        wire::write_value(w, out, &S_TO_V1_MODEL_OUT)?;
        Ok(())
    })
}

static S_TO_V1_PROVIDER_0: wire::Schema = wire::Schema::Dyn;
static S_TO_V1_PROVIDER_1: wire::Schema = wire::Schema::Dyn;
static S_TO_V1_PROVIDER_2: wire::Schema = wire::Schema::Dyn;
static S_TO_V1_PROVIDER_OUT: wire::Schema = wire::Schema::Dyn;

/// `toV1Provider` over the binary wire.
#[napi(js_name = "toV1ProviderWire")]
pub fn to_v1_provider_wire() -> napi::Result<f64> {
    wire_io(|r, w| {
        let provider: Value = wire::read_value(r, &S_TO_V1_PROVIDER_0)?;
        let models: Value = wire::read_value(r, &S_TO_V1_PROVIDER_1)?;
        let options: Value = wire::read_value(r, &S_TO_V1_PROVIDER_2)?;
        let out = &port::to_v1_provider(provider, models, options)?;
        wire::write_value(w, out, &S_TO_V1_PROVIDER_OUT)?;
        Ok(())
    })
}

static S_TO_V1_CONFIG_PROVIDERS_0: wire::Schema = wire::Schema::Dyn;
static S_TO_V1_CONFIG_PROVIDERS_OUT: wire::Schema = wire::Schema::Dyn;

/// `toV1ConfigProviders` over the binary wire.
#[napi(js_name = "toV1ConfigProvidersWire")]
pub fn to_v1_config_providers_wire() -> napi::Result<f64> {
    wire_io(|r, w| {
        let arg0: Value = wire::read_value(r, &S_TO_V1_CONFIG_PROVIDERS_0)?;
        let out = &port::to_v1_config_providers(arg0)?;
        wire::write_value(w, out, &S_TO_V1_CONFIG_PROVIDERS_OUT)?;
        Ok(())
    })
}

static S_TO_V1_PROVIDER_LIST_0: wire::Schema = wire::Schema::Dyn;
static S_TO_V1_PROVIDER_LIST_OUT: wire::Schema = wire::Schema::Dyn;

/// `toV1ProviderList` over the binary wire.
#[napi(js_name = "toV1ProviderListWire")]
pub fn to_v1_provider_list_wire() -> napi::Result<f64> {
    wire_io(|r, w| {
        let arg0: Value = wire::read_value(r, &S_TO_V1_PROVIDER_LIST_0)?;
        let out = &port::to_v1_provider_list(arg0)?;
        wire::write_value(w, out, &S_TO_V1_PROVIDER_LIST_OUT)?;
        Ok(())
    })
}

static S_TO_V1_COMMANDS_0: wire::Schema = wire::Schema::Dyn;
static S_TO_V1_COMMANDS_1: wire::Schema = wire::Schema::Dyn;
static S_TO_V1_COMMANDS_OUT: wire::Schema = wire::Schema::Dyn;

/// `toV1Commands` over the binary wire.
#[napi(js_name = "toV1CommandsWire")]
pub fn to_v1_commands_wire() -> napi::Result<f64> {
    wire_io(|r, w| {
        let commands: Value = wire::read_value(r, &S_TO_V1_COMMANDS_0)?;
        let options: Value = wire::read_value(r, &S_TO_V1_COMMANDS_1)?;
        let out = &port::to_v1_commands(commands, options)?;
        wire::write_value(w, out, &S_TO_V1_COMMANDS_OUT)?;
        Ok(())
    })
}

static S_TO_V1_SKILLS_0: wire::Schema = wire::Schema::Dyn;
static S_TO_V1_SKILLS_OUT: wire::Schema = wire::Schema::Dyn;

/// `toV1Skills` over the binary wire.
#[napi(js_name = "toV1SkillsWire")]
pub fn to_v1_skills_wire() -> napi::Result<f64> {
    wire_io(|r, w| {
        let skills: Value = wire::read_value(r, &S_TO_V1_SKILLS_0)?;
        let out = &port::to_v1_skills(skills)?;
        wire::write_value(w, out, &S_TO_V1_SKILLS_OUT)?;
        Ok(())
    })
}

static S_TO_V1_MCP_STATUS_0: wire::Schema = wire::Schema::Dyn;
static S_TO_V1_MCP_STATUS_OUT: wire::Schema = wire::Schema::Dyn;

/// `toV1McpStatus` over the binary wire.
#[napi(js_name = "toV1McpStatusWire")]
pub fn to_v1_mcp_status_wire() -> napi::Result<f64> {
    wire_io(|r, w| {
        let servers: Value = wire::read_value(r, &S_TO_V1_MCP_STATUS_0)?;
        let out = &port::to_v1_mcp_status(servers)?;
        wire::write_value(w, out, &S_TO_V1_MCP_STATUS_OUT)?;
        Ok(())
    })
}

static S_MERGE_V2_CONFIG_ENTRIES_0: wire::Schema = wire::Schema::Dyn;
static S_MERGE_V2_CONFIG_ENTRIES_OUT: wire::Schema = wire::Schema::Dyn;

/// `mergeV2ConfigEntries` over the binary wire.
#[napi(js_name = "mergeV2ConfigEntriesWire")]
pub fn merge_v2_config_entries_wire() -> napi::Result<f64> {
    wire_io(|r, w| {
        let entries: Value = wire::read_value(r, &S_MERGE_V2_CONFIG_ENTRIES_0)?;
        let out = &port::merge_v2_config_entries(entries)?;
        wire::write_value(w, out, &S_MERGE_V2_CONFIG_ENTRIES_OUT)?;
        Ok(())
    })
}

static S_CONFIG_DIRECTORIES_0: wire::Schema = wire::Schema::Dyn;
static S_CONFIG_DIRECTORIES_OUT: wire::Schema = wire::Schema::Dyn;

/// `configDirectories` over the binary wire.
#[napi(js_name = "configDirectoriesWire")]
pub fn config_directories_wire() -> napi::Result<f64> {
    wire_io(|r, w| {
        let entries: Value = wire::read_value(r, &S_CONFIG_DIRECTORIES_0)?;
        let out = &port::config_directories(entries)?;
        wire::write_value(w, out, &S_CONFIG_DIRECTORIES_OUT)?;
        Ok(())
    })
}

static S_TO_V1_MODEL_SELECTION_0: wire::Schema = wire::Schema::Dyn;
static S_TO_V1_MODEL_SELECTION_OUT: wire::Schema = wire::Schema::Dyn;

/// `toV1ModelSelection` over the binary wire.
#[napi(js_name = "toV1ModelSelectionWire")]
pub fn to_v1_model_selection_wire() -> napi::Result<f64> {
    wire_io(|r, w| {
        let selection: Value = wire::read_value(r, &S_TO_V1_MODEL_SELECTION_0)?;
        let out = &port::to_v1_model_selection(selection)?;
        wire::write_value(w, out, &S_TO_V1_MODEL_SELECTION_OUT)?;
        Ok(())
    })
}

static S_TO_V1_CONFIG_0: wire::Schema = wire::Schema::Dyn;
static S_TO_V1_CONFIG_OUT: wire::Schema = wire::Schema::Dyn;

/// `toV1Config` over the binary wire.
#[napi(js_name = "toV1ConfigWire")]
pub fn to_v1_config_wire() -> napi::Result<f64> {
    wire_io(|r, w| {
        let entries: Value = wire::read_value(r, &S_TO_V1_CONFIG_0)?;
        let out = &port::to_v1_config(entries)?;
        wire::write_value(w, out, &S_TO_V1_CONFIG_OUT)?;
        Ok(())
    })
}

static S_TO_V1_PATH_0: wire::Schema = wire::Schema::Dyn;
static S_TO_V1_PATH_1: wire::Schema = wire::Schema::Dyn;
static S_TO_V1_PATH_OUT: wire::Schema = wire::Schema::Dyn;

/// `toV1Path` over the binary wire.
#[napi(js_name = "toV1PathWire")]
pub fn to_v1_path_wire() -> napi::Result<f64> {
    wire_io(|r, w| {
        let location: Value = wire::read_value(r, &S_TO_V1_PATH_0)?;
        let paths: Value = wire::read_value(r, &S_TO_V1_PATH_1)?;
        let out = &port::to_v1_path(location, paths)?;
        wire::write_value(w, out, &S_TO_V1_PATH_OUT)?;
        Ok(())
    })
}

static S_TO_V1_PROJECT_0: wire::Schema = wire::Schema::Dyn;
static S_TO_V1_PROJECT_OUT: wire::Schema = wire::Schema::Dyn;

/// `toV1Project` over the binary wire.
#[napi(js_name = "toV1ProjectWire")]
pub fn to_v1_project_wire() -> napi::Result<f64> {
    wire_io(|r, w| {
        let project: Value = wire::read_value(r, &S_TO_V1_PROJECT_0)?;
        let out = &port::to_v1_project(project)?;
        wire::write_value(w, out, &S_TO_V1_PROJECT_OUT)?;
        Ok(())
    })
}

static S_TO_V1_PROJECTS_0: wire::Schema = wire::Schema::Dyn;
static S_TO_V1_PROJECTS_OUT: wire::Schema = wire::Schema::Dyn;

/// `toV1Projects` over the binary wire.
#[napi(js_name = "toV1ProjectsWire")]
pub fn to_v1_projects_wire() -> napi::Result<f64> {
    wire_io(|r, w| {
        let projects: Value = wire::read_value(r, &S_TO_V1_PROJECTS_0)?;
        let out = &port::to_v1_projects(projects)?;
        wire::write_value(w, out, &S_TO_V1_PROJECTS_OUT)?;
        Ok(())
    })
}

static S_TO_V1_CURRENT_PROJECT_0: wire::Schema = wire::Schema::Dyn;
static S_TO_V1_CURRENT_PROJECT_1: wire::Schema = wire::Schema::Dyn;
static S_TO_V1_CURRENT_PROJECT_OUT: wire::Schema = wire::Schema::Dyn;

/// `toV1CurrentProject` over the binary wire.
#[napi(js_name = "toV1CurrentProjectWire")]
pub fn to_v1_current_project_wire() -> napi::Result<f64> {
    wire_io(|r, w| {
        let location: Value = wire::read_value(r, &S_TO_V1_CURRENT_PROJECT_0)?;
        let projects: Value = wire::read_value(r, &S_TO_V1_CURRENT_PROJECT_1)?;
        let out = &port::to_v1_current_project(location, projects)?;
        wire::write_value(w, out, &S_TO_V1_CURRENT_PROJECT_OUT)?;
        Ok(())
    })
}

static S_TO_V1_VCS_INFO_0: wire::Schema = wire::Schema::Dyn;
static S_TO_V1_VCS_INFO_OUT: wire::Schema = wire::Schema::Dyn;

/// `toV1VcsInfo` over the binary wire.
#[napi(js_name = "toV1VcsInfoWire")]
pub fn to_v1_vcs_info_wire() -> napi::Result<f64> {
    wire_io(|r, w| {
        let vcs: Value = wire::read_value(r, &S_TO_V1_VCS_INFO_0)?;
        let out = &port::to_v1_vcs_info(vcs)?;
        wire::write_value(w, out, &S_TO_V1_VCS_INFO_OUT)?;
        Ok(())
    })
}
