//! The Rust port of `session-failure.ts`, with the classifiers it imports ported alongside:
//! `@/lib/executionFailure`, `@/lib/messages/providerAuthError`,
//! `@/lib/messages/providerTokenExpired` and `@devryan/shared-runtime/lib/free-tier-rejection.js`.
//! Their regular expressions are matched by hand: `\b` is the ASCII word boundary of a JS regex
//! without the `u` flag, and `/free tier can only be used/i` folds ASCII letters only.

#![forbid(unsafe_code)]

use serde_json::{Value, json};

use crate::js;

// recorded-literal: the next three texts and the table are constants of the imported `@/lib` modules.
const PROVIDER_AUTH_FAILURE_MESSAGE: &str = "Authentication failed for this provider. Please re-authenticate and retry."; // recorded-literal: constant of an imported @/lib module
const PROVIDER_TOKEN_EXPIRED_MESSAGE: &str =
    "This provider's sign-in has expired and could not be refreshed automatically. Reconnect it in Settings → Providers, then retry."; // recorded-literal: constant of @/lib/messages/providerTokenExpired
const RECOVERY_MESSAGE: &str = "Automatic recovery could not verify this task's execution. Review the task and its recovery options before continuing."; // recorded-literal: constant of an imported @/lib module

/// `explanations` of `@/lib/executionFailure`, in its key order.
#[rustfmt::skip]
const EXPLANATIONS: [(&str, &str); 16] = [
    ("local_execution_timeout", "The workspace was not ready before the startup deadline. Retry the subtask."), // recorded-literal: table of @/lib/executionFailure
    ("execution_preparation_stalled", "Workspace preparation stopped making progress. Retry the subtask."), // recorded-literal: table of @/lib/executionFailure
    ("workspace_changing", "Workspace files kept changing during preparation. Pause the writer and retry the subtask."), // recorded-literal: table of @/lib/executionFailure
    ("execution_artifacts_unavailable", "The verified execution runtime is missing or incompatible. Repair or update DevRyan, then restart the server."), // recorded-literal: table of @/lib/executionFailure
    ("execution_owner_termination_unconfirmed", "The previous execution host has not confirmed shutdown. Wait for recovery before retrying."), // recorded-literal: table of @/lib/executionFailure
    ("execution_owner_lost", "The execution host restarted while preparing this work. Retry the subtask."), // recorded-literal: table of @/lib/executionFailure
    ("execution_owner_unavailable", "The execution host is unavailable. Reconnect and retry."), // recorded-literal: table of @/lib/executionFailure
    ("payload_too_large", "This request exceeds the execution input limit. Reduce attached context or start a new task."), // recorded-literal: table of @/lib/executionFailure
    ("skill_source_mismatch", "The selected skill changed during preparation. Retry to load its current version."), // recorded-literal: table of @/lib/executionFailure
    ("native_skill_unreviewed", "The skill name or ID was not recognized. Retry using an exact available skill name."), // recorded-literal: table of @/lib/executionFailure
    ("storage_unavailable", "There is not enough available storage to prepare or save this work. Free space and retry."), // recorded-literal: table of @/lib/executionFailure
    ("mutation_runtime_missing", "The paired execution runtime is missing. Repair or update the installation before retrying."), // recorded-literal: table of @/lib/executionFailure
    ("mutation_runtime_unsupported", "This runtime cannot provide the required execution protection. Use a supported runtime."), // recorded-literal: table of @/lib/executionFailure
    ("session_retention_in_progress", "Session cleanup is in progress. Retry after it finishes."), // recorded-literal: table of @/lib/executionFailure
    ("mutation_history_captured", "This conversation's changes are owned by the DevRyan companion, which is unavailable. Restore it to Revert or Redo."), // recorded-literal: table of @/lib/executionFailure
    ("mutation_recovery_pending", "An interrupted Revert in this project is waiting for the DevRyan companion to finish recovery. Restore it before reverting."), // recorded-literal: table of @/lib/executionFailure
];

/// The provider classes in the order the original tests them: code, `data.v2Type` values,
/// `data.providerCode` values, message (each class has its own extra test in the loop).
type Rule = (&'static str, &'static [&'static str], &'static [&'static str], &'static str);
#[rustfmt::skip]
const PROVIDER_RULES: [Rule; 7] = [ // recorded-literal: constant of an imported @/lib module
    ("provider_request_unsupported", &["provider.unsupported-operation"], &["subscription_sharing_user_not_eligible", "subscription_sharing_unsupported_capability", "subscription_sharing_route_not_supported", "unsupported_parameter", "unsupported_value", "unsupported_capability", "model_not_found"], "The selected provider connection does not support this request. Check the model and options, or choose another connection, then retry."),
    ("provider_free_limit", &["provider.free-limit"], &[], "The model's free tier is used up or does not allow this request. Choose a paid model or another provider connection, then retry."), // recorded-literal: spelled with an escaped quote in the source
    ("provider_auth_failed", &["provider.auth"], &["invalid_api_key", "invalid_authentication", "authentication_error", "subscription_sharing_invalid_user", "chatpass_v2_scope_not_authorized", "chatpass_v2_invalid_authorization_context"], PROVIDER_AUTH_FAILURE_MESSAGE), // recorded-literal: spelled with an escaped quote in the source
    ("provider_quota_exceeded", &["provider.quota"], &["subscription_sharing_usage_limit_exceeded", "insufficient_quota", "quota_exceeded", "usage_limit_exceeded"], "The selected provider account has reached its usage limit. Check its usage or choose another account, then retry."),
    ("provider_rate_limited", &["provider.rate-limit"], &["rate_limit_exceeded", "too_many_requests"], "The provider is limiting requests. Wait briefly, then retry."),
    ("provider_transport_failed", &["provider.transport", "provider.timeout"], &["subscription_sharing_usage_unavailable", "subscription_sharing_user_unavailable"], "The provider connection was interrupted before the response finished. Retry the request."),
    ("output_limit", &["output-limit"], &[], "The response kept reaching the model's output limit. Ask for a shorter answer or continue in smaller steps."), // recorded-literal: spelled with an escaped quote in the source
];

fn word_char(c: Option<char>) -> bool {
    c.is_some_and(|c| c.is_ascii_alphanumeric() || c == '_')
}

/// `/\bword\b/` (or without the leading `\b`) for a word made of word characters.
fn has_word(text: &str, word: &str, leading: bool) -> bool {
    text.match_indices(word)
        .any(|(at, _)| (!leading || !word_char(text[..at].chars().next_back())) && !word_char(text[at + word.len()..].chars().next()))
}

/// `/Failed to read [^\n]+ stream/`.
fn failed_to_read_stream(text: &str) -> bool {
    text.match_indices("Failed to read ").any(|(at, m)| {
        let line = text[at + m.len()..].split('\n').next().unwrap_or("");
        line.match_indices(" stream").any(|(i, _)| i > 0)
    })
}

/// JS `String(value)` for a template literal.
fn js_string(value: Option<&Value>) -> String {
    match value {
        None | Some(Value::Null) => String::new(),
        Some(v) if js::is_undefined(v) => String::new(),
        Some(Value::String(s)) => s.clone(),
        Some(Value::Bool(flag)) => flag.to_string(),
        Some(Value::Array(items)) => items.iter().map(|v| js_string(Some(v))).collect::<Vec<_>>().join(","),
        Some(v) => match (js::as_number(v), js::string_units(v)) {
            (Some(n), _) => js::number_to_string(n),
            (None, Some(units)) => String::from_utf16_lossy(&units),
            _ => "[object Object]".to_string(),
        },
    }
}

/// `value.toLowerCase().trim()` (JS `trim` strips U+FEFF, keeps U+0085).
fn detail(value: &str) -> String {
    let lower = value.to_lowercase();
    lower
        .trim_matches(|c: char| (c.is_whitespace() && c != '\u{85}') || c == '\u{feff}')
        .to_string()
}

fn likely_token_expired(value: &str) -> bool {
    let d = detail(value);
    [
        "token is expired",
        "token has expired",
        "authentication token is expired",
        "could not be refreshed",
        "session expired",
    ]
    .iter()
    .any(|needle| d.contains(needle))
}

fn likely_auth_failure(value: &str) -> bool {
    let d = detail(value);
    if d.is_empty() {
        return false;
    }
    let has = |needle: &str| d.contains(needle);
    if [
        "token refresh failed",
        "provider_authentication",
        "unauthorized",
        "invalid token",
        "expired token",
    ]
    .iter()
    .any(|n| has(n))
    {
        return true;
    }
    if has("oauth") && (has("failed") || has("invalid") || has("expired")) {
        return true;
    }
    has_word(&d, "401", true) && (has("auth") || has("token") || has("unauthorized"))
}

fn field<'a>(value: Option<&'a Value>, key: &str) -> Option<&'a Value> {
    value.and_then(|v| v.get(key)).filter(|v| !js::is_undefined(v))
}

fn is(value: Option<&Value>, expected: &str) -> bool {
    value.and_then(Value::as_str) == Some(expected)
}

fn failure(code: &str, message: &str) -> Value {
    json!({ "code": code, "message": message })
}

fn cancellation(error: Option<&Value>) -> bool {
    let name = field(error, "name");
    is(name, "AbortError") || is(name, "MessageAbortedError") || is(field(error, "code"), "session_cancelled")
}

/// Port of `isSessionCancellation` (`session-failure.ts:15`).
pub fn is_session_cancellation(error: Option<Value>) -> Result<bool, String> {
    Ok(cancellation(error.as_ref()))
}

/// Port of `describeSessionFailure` (`session-failure.ts:20`).
pub fn describe_session_failure(error: Option<Value>) -> Result<Value, String> {
    let error = error.as_ref();
    if cancellation(error) {
        return Ok(failure("session_cancelled", "Request cancelled."));
    }
    let data = field(error, "data");
    let text = format!(
        "{} {} {}",
        js_string(field(error, "code")),
        js_string(field(error, "message")),
        js_string(field(data, "message"))
    );
    let recovery = ["native_slim_retry_primary_fenced", "execution_recovery_unavailable"]; // recorded-literal: regex of @/lib/executionFailure
    if recovery.iter().any(|w| has_word(&text, w, true)) {
        return Ok(failure("execution_recovery_unavailable", RECOVERY_MESSAGE));
    }
    if let Some((code, message)) = EXPLANATIONS.iter().find(|(code, _)| has_word(&text, code, true)) {
        let message = if text.contains("cleanup unconfirmed") {
            format!("Execution could not start and cleanup is still unconfirmed. Wait for recovery before retrying. ({code})")
        } else {
            format!("{message} ({code})")
        };
        return Ok(failure("local_execution_failed", &message));
    }
    if ["local_execution_", "mutation_runtime_", "capture_timeout"].iter().any(|n| text.contains(n)) {
        return Ok(failure(
            "local_execution_failed",
            "Local tool execution could not start or finish. Review failed tools before sending another prompt.",
        ));
    }
    let code = field(error, "code");
    if is(code, "provider_credentials_changed") || has_word(&text, "native_credential_changed", true) {
        return Ok(failure(
            "provider_credentials_changed",
            "The provider account changed while this request was being prepared. Check the selected account in Providers, then retry.",
        ));
    }
    if is(code, "provider_token_expired") || likely_token_expired(&text) {
        return Ok(failure("provider_token_expired", PROVIDER_TOKEN_EXPIRED_MESSAGE));
    }
    let provider_code = field(data, "providerCode").and_then(Value::as_str).unwrap_or("");
    let provider_type = field(data, "v2Type").and_then(Value::as_str).unwrap_or("\u{0}");
    let name = field(error, "name");
    let status = field(data, "statusCode").filter(|v| v.is_number()).and_then(js::as_number);
    for (rule, types, codes, message) in PROVIDER_RULES {
        let extra = match rule {
            "provider_free_limit" => text.to_ascii_lowercase().contains("free tier can only be used"),
            "provider_auth_failed" => is(name, "ProviderAuthError") || status == Some(401.0) || status == Some(403.0) || likely_auth_failure(&text),
            "provider_transport_failed" => {
                ["chatgpt_siwc_stream_failed", "chatgpt_siwc_stream_incomplete"] // recorded-literal: the regex `chatgpt_siwc_stream_(?:failed|incomplete)`
                    .iter()
                    .any(|w| has_word(&text, w, false))
                    || failed_to_read_stream(&text)
            }
            "output_limit" => is(name, "MessageOutputLengthError"),
            _ => false,
        };
        if is(code, rule) || types.contains(&provider_type) || codes.contains(&provider_code) || extra {
            return Ok(failure(rule, message));
        }
    }
    let timed = format!("{} {text}", js_string(field(error, "name")));
    if ["TimeoutError", "timed out", "session_timeout"].iter().any(|n| timed.contains(n)) {
        return Ok(failure(
            "session_timeout",
            "The request timed out. Review failed tools before continuing; their effects may be unknown.",
        ));
    }
    Ok(failure(
        "session_failed",
        "The request failed. Review the conversation and failed tools before continuing.",
    ))
}

/// Port of `sessionFailureRetryAt` (`session-failure.ts:86`).
pub fn session_failure_retry_at(error: Option<Value>, at: f64) -> Result<Option<f64>, String> {
    let described = describe_session_failure(error.clone())?;
    if !matches!(
        described["code"].as_str(),
        Some("provider_rate_limited" | "provider_quota_exceeded" | "provider_free_limit")
    ) {
        return Ok(None);
    }
    let number = |v: Option<&Value>| v.filter(|v| v.is_number() || v.get("$num").is_some()).and_then(js::as_number);
    if let Some(retry_at) = number(field(error.as_ref(), "retryAt")).filter(|n| n.is_finite() && *n > 0.0) {
        return Ok(Some(retry_at));
    }
    let after = number(field(field(error.as_ref(), "data"), "retryAfterMs"));
    Ok(after.filter(|a| a.is_finite() && *a >= 0.0 && at.is_finite()).map(|a| at + a))
}
