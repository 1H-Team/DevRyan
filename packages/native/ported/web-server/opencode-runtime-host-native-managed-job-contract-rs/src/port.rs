//! The Rust port of `opencode/runtime-host/native-managed-job-contract.js`.

#![forbid(unsafe_code)]

use serde_json::{Map, Value};

use crate::js;

fn plain(value: &Value) -> Option<&Map<String, Value>> {
    value.as_object().filter(|o| !(o.len() == 1 && o.keys().all(|k| k.starts_with('$'))))
}

fn field(value: &Value, key: &str) -> Value {
    plain(value).and_then(|o| o.get(key)).cloned().unwrap_or_else(js::undefined)
}

fn opt(value: &Value, key: &str) -> Value {
    if value.is_null() || js::is_undefined(value) {
        js::undefined()
    } else {
        field(value, key)
    }
}

/// Port of `hasNativeManagedSubagentJobs` (`opencode/runtime-host/native-managed-job-contract.js:3`).
pub fn has_native_managed_subagent_jobs(manifest: Value) -> Result<Value, String> {
    let has = match opt(&manifest, "compiledContracts") {
        Value::Array(items) => items.iter().any(|v| v.as_str() == Some("devryan.managed-subagent-jobs/1")),
        _ => false,
    };
    Ok(Value::Bool(has))
}
