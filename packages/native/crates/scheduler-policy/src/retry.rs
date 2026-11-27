//! `provider-retry-policy.js` (with `shared-runtime/lib/upstream-stall.js`
//! and `provider-capabilities.js` `supportsManagedReadOnlyProvider`): the
//! classifiers and the formatter of failure text.

use devryan_js_layer::js::{self, JsStr, Value};

use crate::error::JsResult;
use crate::jsv::{as_str, get, is_record, is_str, is_typeof_object, nullish_or, to_string, truthy};
use crate::regex::pattern;
use crate::text::{concat, lower_for_ascii, starts_with, trim, units};

pub const PROVIDER_USAGE_LIMIT_FAILURE_KIND: &str = "provider_usage_limit";
pub const PROVIDER_AUTHENTICATION_FAILURE_KIND: &str = "provider_authentication";
pub const PROVIDER_PROMPT_REJECTED_FAILURE_KIND: &str = "provider_prompt_rejected";
pub const MODEL_UNAVAILABLE_FAILURE_KIND: &str = "model_unavailable";
pub const DEADLINE_EXCEEDED_FAILURE_KIND: &str = "deadline_exceeded";
pub const PROVIDER_TRANSPORT_FAILURE_KIND: &str = "provider_transport";
pub const PROVIDER_CONFIGURATION_FAILURE_KIND: &str = "provider_configuration";
pub const MANAGED_TASK_TIMEOUT_REASON_PREFIX: &str = "Managed task timed out at ";
pub const PROVIDER_TRANSPORT_FAILURE_KINDS: [&str; 5] = [
    "request_timeout",
    "response_header_timeout",
    "stream_idle_timeout",
    "connection_failure",
    "provider_queue_timeout",
];

pattern!(
    local_authorization_failure,
    r"\bnative_(?:web_[a-z_]+|managed_task_[a-z_]+|permit_[a-z_]+|session_access_revoked)\b",
    false
);
pattern!(
    authentication_failure,
    r"\b(?:authentication[_ ]?error|authentication (?:failed|failure|expired|invalid)|authorization(?:error| failed| failure)|unauthorized|forbidden|invalid (?:api key|credentials?|access token|authentication)|missing api key|expired (?:access |refresh )?token|(?:oauth |access |refresh )?token (?:has |is )?expired|not logged in|http[ :]+40[13]|an active opencode go subscription is required)\b",
    true
);
pattern!(abort_error_name, r"^(?:MessageAbortedError|AbortError)$", false);
pattern!(aborted_word, r"\babort(?:ed)?\b", true);
pattern!(
    capability_failure,
    r"^(?:Runtime capability unavailable:|admission\.prompt: the native permission action for tool [a-zA-Z0-9_.:-]+ is unavailable$)",
    false
);
pattern!(
    provider_configuration,
    r"\bmodel requires global regions?\b|\bselect global in your workspace'?s privacy settings\b",
    false
);
pattern!(
    non_transport_failure,
    r"\b(?:abort(?:ed)?|cancel(?:led|ed)?|authentication|authorization|unauthorized|forbidden|invalid api key|missing api key|oauth|access token|refresh token|credential|modelnotfound(?:error)?|model (?:is )?not found|unknown model|invalid model|no such model|certificate|self signed|unable to verify|x509)\b",
    true
);
pattern!(non_transport_failure_name, r"(?:abort|cancel|auth|oauth|modelnotfound|certificate)", true);
pattern!(
    response_header_timeout,
    r"(?:\bund_err_headers_timeout\b|\bheaders? timeout(?: error)?\b|\bresponse headers? (?:timed out|timeout)\b|\btimed out (?:while )?waiting for (?:the )?response headers?\b)",
    true
);
pattern!(
    stream_idle_timeout,
    r"(?:\bund_err_body_timeout\b|\bchunk timeout(?: error)?\b|\bstream idle timeout\b|\bupstream idle timeout exceeded\b|\bsse (?:read )?timed out\b|\btimed out (?:while )?waiting for (?:the )?(?:next )?(?:stream|chunk|response data)\b|\bno (?:stream )?data (?:was )?received\b)",
    true
);
pattern!(
    request_timeout,
    r"^(?:(?:unknown\s*error|unknownerror)\s*:\s*)?(?:(?:the )?(?:operation|request) (?:has )?timed out|request timeout(?:error)?|timeout(?:error)?)\.?$",
    true
);
pattern!(
    connection_failure,
    r"(?:^terminated$|\beconn(?:aborted|refused|reset)\b|\behostunreach\b|\benet(?:down|unreach)\b|\benotfound\b|\bepipe\b|\betimedout\b|\bund_err_(?:connect_timeout|socket)\b|\bstreaming response failed\b|\bupstream request failed\b|\bpremature(?:ly)? close(?:d)?\b|\bsocket hang up\b|\bconnection (?:closed|dropped|failed|lost|refused|reset|terminated)\b|\bnetwork (?:connection )?(?:error|failure)\b|\bfetch failed\b)",
    true
);
pattern!(
    provider_queue_failure,
    r"(?:\btimed out in queue\b|\bservice (?:is )?temporarily unavailable\b|\bthe model did not respond\b|\bmodel is overloaded\b|\bserver is overloaded\b|\bcapacity exceeded\b|\bno capacity available\b)",
    true
);
pattern!(
    model_unavailable,
    r"\b(?:providermodelnotfound(?:error)?|modelnotfound(?:error)?|model (?:is )?not found|model (?:is )?unavailable|model does not exist|unknown model|invalid model|no such model)\b",
    true
);
pattern!(upstream_stall_message, r"^Upstream stalled: no data for [1-9][0-9]{0,12}ms$", false);
pattern!(
    upstream_stall_text,
    r"^upstream_timeout: Upstream stalled: no data for [1-9][0-9]{0,12}ms$",
    false
);

const UPSTREAM_STALL_ENVELOPE_MAX_LENGTH: usize = 4096;

/// `isProviderAuthenticationFailure(value)`.
pub fn is_provider_authentication_failure(value: &Value) -> bool {
    as_str(value).is_some_and(|text| is_authentication_text(text.units()))
}

fn is_authentication_text(text: &[u16]) -> bool {
    !local_authorization_failure().test(text)
        && !starts_with(text, "Provider internal failure: ")
        && !starts_with(text, "Runtime capability unavailable: ")
        && authentication_failure().test(text)
}

/// `formatManagedTaskFailureReason(error)`. An `Error` instance is passed as
/// a plain object holding its `name`, `message` and other read properties.
pub fn format_managed_task_failure_reason(error: &Value) -> JsResult<JsStr> {
    if let Value::String(text) = error {
        return Ok(JsStr::from_units(trim(text.units()).to_vec()));
    }
    if !truthy(error) || !is_typeof_object(error) {
        return to_string(nullish_or(error, &Value::String(JsStr::new())));
    }
    let empty = Value::Object(Default::default());
    let data_value = get(error, "data");
    let data = if truthy(data_value) && is_typeof_object(data_value) {
        data_value
    } else {
        &empty
    };
    let message: Vec<u16> = [get(data, "message"), get(error, "message"), get(error, "name")]
        .into_iter()
        .find_map(|value| as_str(value).filter(|text| !trim(text.units()).is_empty()))
        .map_or_else(|| units("Managed child session failed"), |text| trim(text.units()).to_vec());
    let kind = nullish_or(get(data, "v2Type"), get(error, "v2Type"));
    let name = nullish_or(get(error, "errorName"), get(error, "name"));
    let typed = truthy(kind);
    let aborted = is_str(kind, "aborted") || (!typed && abort_error_name().test(to_string(nullish_or(name, &Value::String(JsStr::new())))?.units()));
    if aborted {
        return Ok(if aborted_word().test(&message) {
            JsStr::from_units(message)
        } else {
            concat(&[&units("Aborted: "), &message])
        });
    }
    if !typed {
        let code = to_string(nullish_or(get(error, "code"), &Value::String(JsStr::new())))?;
        if local_authorization_failure().test(concat(&[code.units(), &units(" "), &message]).units()) {
            return Ok(JsStr::from_units(message));
        }
    }
    let status = nullish_or(get(data, "statusCode"), get(error, "statusCode"));
    let auth_status = matches!(status, Value::Number(number) if *number == 401.0 || *number == 403.0);
    if is_str(kind, "provider.auth") || (!typed && is_str(name, "ProviderAuthError")) || (!typed && auth_status) {
        return Ok(if is_authentication_text(&message) {
            JsStr::from_units(message)
        } else {
            concat(&[&units("Provider authentication failed: "), &message])
        });
    }
    if is_str(kind, "provider.internal") {
        return Ok(concat(&[&units("Provider internal failure: "), &message]));
    }
    if is_str(get(error, "code"), "capability_unavailable") || is_str(get(data, "code"), "capability_unavailable") {
        return Ok(concat(&[&units("Runtime capability unavailable: "), &message]));
    }
    Ok(JsStr::from_units(message))
}

/// `isManagedTaskCapabilityFailure(value)`.
pub fn is_managed_task_capability_failure(value: &Value) -> bool {
    as_str(value).is_some_and(|text| capability_failure().test(text.units()))
}

fn is_configuration_text(text: &[u16]) -> bool {
    if text.len() > 16 * 1024 {
        return false;
    }
    // .replace(/[‘’ʼ]/g, "'").replace(/\s+/g, ' ').toLowerCase()
    let mut collapsed = Vec::with_capacity(text.len());
    let mut in_space = false;
    for unit in text {
        let unit = if matches!(*unit, 0x2018 | 0x2019 | 0x02bc) { u16::from(b'\'') } else { *unit };
        if crate::text::is_js_whitespace(unit) {
            if !in_space {
                collapsed.push(u16::from(b' '));
            }
            in_space = true;
        } else {
            collapsed.push(unit);
            in_space = false;
        }
    }
    provider_configuration().test(&lower_for_ascii(&collapsed))
}

/// `isProviderConfigurationFailure(value)`.
pub fn is_provider_configuration_failure(value: &Value) -> bool {
    as_str(value).is_some_and(|text| is_configuration_text(text.units()))
}

/// `normalizeTransportFailureText(value)`.
fn normalize_transport_failure_text(value: &Value) -> Vec<u16> {
    let Some(text) = as_str(value) else {
        return Vec::new();
    };
    let normalized = trim(text.units());
    if normalized.len() >= 2 && normalized[0] == u16::from(b'"') && normalized[normalized.len() - 1] == u16::from(b'"') {
        // A text that starts with a quote parses to a string or not at all.
        if let Ok(parsed) = js::parse(normalized)
            && let Value::String(parsed) = &parsed
        {
            return trim(parsed.units()).to_vec();
        }
    }
    normalized.to_vec()
}

/// `isUpstreamStallText(value)`.
fn is_upstream_stall_text(text: &[u16]) -> bool {
    upstream_stall_text().test(text)
}

/// `isUpstreamStallEnvelope(value)`.
fn is_upstream_stall_envelope(text: &[u16]) -> JsResult<bool> {
    if text.len() > UPSTREAM_STALL_ENVELOPE_MAX_LENGTH {
        return Ok(false);
    }
    match js::parse(text) {
        Ok(envelope) => Ok(is_record(&envelope)
            && is_str(get(&envelope, "type"), "upstream_timeout")
            && as_str(get(&envelope, "message")).is_some_and(|message| upstream_stall_message().test(message.units()))),
        Err(error) if error.kind == js::ParseErrorKind::TooDeep => crate::error::unsupported("JSON.parse nesting deeper than the JSON layer's bound"),
        Err(_) => Ok(false),
    }
}

/// `classifyProviderTransportFailure(name, detail)`.
pub fn classify_provider_transport_failure(name: &Value, detail: &Value) -> JsResult<Option<&'static str>> {
    let normalized_name = normalize_transport_failure_text(name);
    let normalized_detail = normalize_transport_failure_text(detail);
    let combined: Vec<u16> = match (normalized_name.is_empty(), normalized_detail.is_empty()) {
        (false, false) => concat(&[&normalized_name, &units(": "), &normalized_detail]).into_units(),
        (false, true) => normalized_name.clone(),
        (true, false) => normalized_detail.clone(),
        (true, true) => Vec::new(),
    };
    if is_authentication_text(&combined) || is_configuration_text(&normalized_detail) || capability_failure().test(&normalized_detail) {
        return Ok(None);
    }
    let compact_name: Vec<u16> = normalized_name
        .iter()
        .copied()
        .filter(|unit| u8::try_from(*unit).is_ok_and(|byte| byte.is_ascii_alphanumeric()))
        .collect();
    if !combined.is_empty() && provider_queue_failure().test(&combined) {
        return Ok(Some("provider_queue_timeout"));
    }
    if combined.is_empty()
        || retry_failure_kind(&combined) == Some(PROVIDER_USAGE_LIMIT_FAILURE_KIND)
        || non_transport_failure_name().test(&compact_name)
        || non_transport_failure().test(&combined)
    {
        return Ok(None);
    }
    if response_header_timeout().test(&combined) {
        return Ok(Some("response_header_timeout"));
    }
    if is_upstream_stall_text(&normalized_detail) || is_upstream_stall_envelope(&normalized_detail)? || stream_idle_timeout().test(&combined) {
        return Ok(Some("stream_idle_timeout"));
    }
    if request_timeout().test(&normalized_detail) || request_timeout().test(&normalized_name) {
        return Ok(Some("request_timeout"));
    }
    if connection_failure().test(&combined) {
        return Ok(Some("connection_failure"));
    }
    Ok(None)
}

/// `normalizeProviderRetryMessage(value)` for a string.
fn normalize_retry_message(text: &[u16]) -> Vec<u16> {
    let lowered = lower_for_ascii(text);
    let mut out = Vec::with_capacity(lowered.len());
    let mut in_run = false;
    for unit in lowered {
        if matches!(unit, 0x61..=0x7a | 0x30..=0x39) {
            out.push(unit);
            in_run = false;
        } else {
            if !in_run {
                out.push(u16::from(b' '));
            }
            in_run = true;
        }
    }
    trim(&out).to_vec()
}

fn retry_failure_kind(text: &[u16]) -> Option<&'static str> {
    let message = normalize_retry_message(text);
    if message.is_empty() || is_authentication_text(text) {
        return None;
    }
    let has = |needle: &str| crate::text::contains(&message, &units(needle));
    if has("invalid prompt") && has("prompt") && has("flagged") && (has("usage policy") || has("policy violation") || has("violating policy")) {
        return Some(PROVIDER_PROMPT_REJECTED_FAILURE_KIND);
    }
    let limited = [
        "personal team blocked spending limit",
        "out of usage",
        "usage exceeded",
        "usage limit",
        "hit your limit",
        "session limit",
        "rate limit",
        "rate limited",
        "quota limit",
        "quota exceeded",
        "quota has been exceeded",
        "insufficient quota",
    ]
    .iter()
    .any(|needle| has(needle));
    limited.then_some(PROVIDER_USAGE_LIMIT_FAILURE_KIND)
}

/// `classifyProviderRetryFailure(value)`.
pub fn classify_provider_retry_failure(value: &Value) -> Option<&'static str> {
    as_str(value).and_then(|text| retry_failure_kind(text.units()))
}

/// `classifyProviderRetryStatus(value)`.
pub fn classify_provider_retry_status(value: &Value) -> Option<&'static str> {
    let reason = get(get(value, "action"), "reason");
    if let Some(reason) = as_str(reason)
        && lower_for_ascii(trim(reason.units())) == units("free_tier_limit")
    {
        return Some(PROVIDER_USAGE_LIMIT_FAILURE_KIND);
    }
    classify_provider_retry_failure(get(value, "message"))
}

/// `isDefiniteProviderUsageLimit(value)`.
pub fn is_definite_provider_usage_limit(value: &Value) -> bool {
    classify_provider_retry_failure(value) == Some(PROVIDER_USAGE_LIMIT_FAILURE_KIND)
}

/// `isProviderPromptRejected(value)`.
pub fn is_provider_prompt_rejected(value: &Value) -> bool {
    classify_provider_retry_failure(value) == Some(PROVIDER_PROMPT_REJECTED_FAILURE_KIND)
}

/// `isManagedTaskDeadlineExceeded(value)`.
pub fn is_managed_task_deadline_exceeded(value: &Value) -> bool {
    as_str(value).is_some_and(|text| starts_with(text.units(), MANAGED_TASK_TIMEOUT_REASON_PREFIX))
}

/// `isManagedTaskModelUnavailable(value)`.
pub fn is_managed_task_model_unavailable(value: &Value) -> bool {
    as_str(value).is_some_and(|text| model_unavailable().test(text.units()))
}

/// `classifyManagedTaskFailure(value)`.
pub fn classify_managed_task_failure(value: &Value) -> JsResult<Option<&'static str>> {
    if is_provider_authentication_failure(value) {
        return Ok(Some(PROVIDER_AUTHENTICATION_FAILURE_KIND));
    }
    if is_managed_task_capability_failure(value) {
        return Ok(Some("runtime_capability"));
    }
    if is_provider_configuration_failure(value) {
        return Ok(Some(PROVIDER_CONFIGURATION_FAILURE_KIND));
    }
    if let Some(kind) = classify_provider_retry_failure(value) {
        return Ok(Some(kind));
    }
    if is_managed_task_model_unavailable(value) {
        return Ok(Some(MODEL_UNAVAILABLE_FAILURE_KIND));
    }
    if is_managed_task_deadline_exceeded(value) {
        return Ok(Some(DEADLINE_EXCEEDED_FAILURE_KIND));
    }
    Ok(classify_provider_transport_failure(&Value::Null, value)?.map(|_| PROVIDER_TRANSPORT_FAILURE_KIND))
}

/// `provider-capabilities.js` `supportsManagedReadOnlyProvider(providerId, { cursorReadOnly })`.
pub fn supports_managed_read_only_provider(provider_id: &Value, cursor_read_only: &Value) -> bool {
    let normalized = as_str(provider_id).map(|text| lower_for_ascii(trim(text.units()))).unwrap_or_default();
    !normalized.is_empty() && (normalized != units("cursor-acp") || matches!(cursor_read_only, Value::Bool(true)))
}

#[cfg(test)]
mod tests {
    #[test]
    fn every_pattern_compiles() {
        for regex in [
            super::local_authorization_failure(),
            super::authentication_failure(),
            super::abort_error_name(),
            super::aborted_word(),
            super::capability_failure(),
            super::provider_configuration(),
            super::non_transport_failure(),
            super::non_transport_failure_name(),
            super::response_header_timeout(),
            super::stream_idle_timeout(),
            super::request_timeout(),
            super::connection_failure(),
            super::provider_queue_failure(),
            super::model_unavailable(),
            super::upstream_stall_message(),
            super::upstream_stall_text(),
        ] {
            let _ = regex.test(&[]);
        }
    }
}
