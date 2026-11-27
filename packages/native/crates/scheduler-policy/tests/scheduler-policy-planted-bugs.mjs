#!/usr/bin/env node
// Planted bugs: each entry changes one thing in the crate's Rust, and the
// tracked vectors must catch it (cargo test --test policy_vectors fails). The
// run copies the crate and the JavaScript layer it builds on into a private
// scratch folder under the OS temp dir (removed on success, failure and
// interruption; --keep-artifacts keeps it), plants one bug at a time and runs
// the vectors there with the pinned toolchain (cargo on PATH).
//
//   node scheduler-policy-planted-bugs.mjs [--only <id>,...] [--shard <i>/<n>] [--keep-artifacts]
//
// `--shard i/n` runs every n-th bug from the i-th (0-based), so n runs in
// parallel cover the list once.
//
// Exit code 1 when a planted bug survives or a planting site no longer exists.
import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRunRoot, scratchParent } from '../../../../../scripts/qa/run-root.mjs';

const REPOSITORY_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..', '..');

/** One bug each: [id, file under src, exact text, replacement, the ported function it breaks]. */
export const PLANTED_BUGS = Object.freeze([
  // provider-retry-policy.js
  ['auth-alternative', 'retry.rs', 'unauthorized|forbidden|invalid (?:api key|credentials?', 'unauthorised|forbidden|invalid (?:api key|credentials?', 'isProviderAuthenticationFailure'],
  ['auth-internal-prefix', 'retry.rs', '&& !starts_with(text, "Provider internal failure: ")\n', '', 'isProviderAuthenticationFailure'],
  ['auth-local-guard', 'retry.rs', '    !local_authorization_failure().test(text)\n        && ', '    ', 'isProviderAuthenticationFailure'],
  ['auth-http-status', 'retry.rs', 'http[ :]+40[13]', 'http[ :]40[13]', 'isProviderAuthenticationFailure'],
  ['format-aborted-prefix', 'retry.rs', 'units("Aborted: ")', 'units("Abort: ")', 'formatManagedTaskFailureReason'],
  ['format-default-message', 'retry.rs', 'units("Managed child session failed")', 'units("Managed child failed")', 'formatManagedTaskFailureReason'],
  ['format-status-403', 'retry.rs', '*number == 401.0 || *number == 403.0', '*number == 401.0', 'formatManagedTaskFailureReason'],
  ['format-data-first', 'retry.rs', '[get(data, "message"), get(error, "message"), get(error, "name")]', '[get(error, "message"), get(data, "message"), get(error, "name")]', 'formatManagedTaskFailureReason'],
  ['format-local-code', 'retry.rs', 'concat(&[code.units(), &units(" "), &message])', 'concat(&[&message])', 'formatManagedTaskFailureReason'],
  ['capability-class', 'retry.rs', 'tool [a-zA-Z0-9_.:-]+ is unavailable$', 'tool [a-zA-Z0-9_.-]+ is unavailable$', 'isManagedTaskCapabilityFailure'],
  ['capability-prefix-colon', 'retry.rs', '^(?:Runtime capability unavailable:|', '^(?:Runtime capability unavailable|', 'isManagedTaskCapabilityFailure'],
  ['capability-anchor', 'retry.rs', 'is unavailable$)",\n', 'is unavailable)",\n', 'isManagedTaskCapabilityFailure'],
  ['configuration-length', 'retry.rs', 'if text.len() > 16 * 1024 {', 'if text.len() >= 16 * 1024 {', 'isProviderConfigurationFailure'],
  ['configuration-quote', 'retry.rs', 'matches!(*unit, 0x2018 | 0x2019 | 0x02bc)', 'matches!(*unit, 0x2018 | 0x2019)', 'isProviderConfigurationFailure'],
  ['configuration-spaces', 'retry.rs', '            if !in_space {\n                collapsed.push(u16::from(b\' \'));\n            }', '            collapsed.push(u16::from(b\' \'));', 'isProviderConfigurationFailure'],
  ['configuration-plural', 'retry.rs', 'global regions?\\b|', 'global regions\\b|', 'isProviderConfigurationFailure'],
  ['transport-queue-first', 'retry.rs', 'if !combined.is_empty() && provider_queue_failure().test(&combined) {', 'if !combined.is_empty() && provider_queue_failure().test(&combined) && !non_transport_failure().test(&combined) {', 'classifyProviderTransportFailure'],
  ['transport-quoted-json', 'retry.rs', '        if let Ok(parsed) = js::parse(normalized)', '        if let Ok(parsed) = js::parse(&[])', 'classifyProviderTransportFailure'],
  ['transport-header-kind', 'retry.rs', '        return Ok(Some("response_header_timeout"));', '        return Ok(Some("stream_idle_timeout"));', 'classifyProviderTransportFailure'],
  ['transport-compact-name', 'retry.rs', '.filter(|unit| u8::try_from(*unit).is_ok_and(|byte| byte.is_ascii_alphanumeric()))\n        .collect();\n    if !combined', '.filter(|unit| u8::try_from(*unit).is_ok_and(|byte| byte.is_ascii_alphanumeric() || byte == b\'_\'))\n        .collect();\n    if !combined', 'classifyProviderTransportFailure'],
  ['transport-name-timeout', 'retry.rs', ' || request_timeout().test(&normalized_name)', '', 'classifyProviderTransportFailure'],
  ['transport-stall-envelope', 'retry.rs', '&& is_str(get(&envelope, "type"), "upstream_timeout")', '&& is_str(get(&envelope, "type"), "upstream_stall")', 'classifyProviderTransportFailure'],
  ['retry-quota-phrase', 'retry.rs', '        "quota has been exceeded",\n', '', 'classifyProviderRetryFailure'],
  ['retry-digits', 'retry.rs', 'if matches!(unit, 0x61..=0x7a | 0x30..=0x39) {', 'if matches!(unit, 0x61..=0x7a) {', 'classifyProviderRetryFailure'],
  ['retry-auth-guard', 'retry.rs', 'if message.is_empty() || is_authentication_text(text) {', 'if message.is_empty() {', 'classifyProviderRetryFailure'],
  ['retry-prompt-policy', 'retry.rs', '|| has("violating policy"))', ')', 'classifyProviderRetryFailure'],
  ['status-reason', 'retry.rs', '== units("free_tier_limit")', '== units("free_tier")', 'classifyProviderRetryStatus'],
  ['status-trim', 'retry.rs', 'lower_for_ascii(trim(reason.units())) == units', 'lower_for_ascii(reason.units()) == units', 'classifyProviderRetryStatus'],
  ['status-lower', 'retry.rs', '&& lower_for_ascii(trim(reason.units()))', '&& trim(reason.units()).to_vec()', 'classifyProviderRetryStatus'],
  ['usage-kind', 'retry.rs', 'classify_provider_retry_failure(value) == Some(PROVIDER_USAGE_LIMIT_FAILURE_KIND)', 'classify_provider_retry_failure(value).is_some()', 'isDefiniteProviderUsageLimit'],
  ['usage-status', 'retry.rs', 'pub fn is_definite_provider_usage_limit(value: &Value) -> bool {\n    classify_provider_retry_failure(value)', 'pub fn is_definite_provider_usage_limit(value: &Value) -> bool {\n    classify_provider_retry_status(value)', 'isDefiniteProviderUsageLimit'],
  ['usage-other-kind', 'retry.rs', 'pub fn is_definite_provider_usage_limit(value: &Value) -> bool {\n    classify_provider_retry_failure(value) == Some(PROVIDER_USAGE_LIMIT_FAILURE_KIND)', 'pub fn is_definite_provider_usage_limit(value: &Value) -> bool {\n    classify_provider_retry_failure(value) != Some(PROVIDER_PROMPT_REJECTED_FAILURE_KIND)', 'isDefiniteProviderUsageLimit'],
  ['prompt-any-kind', 'retry.rs', 'pub fn is_provider_prompt_rejected(value: &Value) -> bool {\n    classify_provider_retry_failure(value) == Some(PROVIDER_PROMPT_REJECTED_FAILURE_KIND)', 'pub fn is_provider_prompt_rejected(value: &Value) -> bool {\n    classify_provider_retry_failure(value).is_some()', 'isProviderPromptRejected'],
  ['prompt-status', 'retry.rs', 'pub fn is_provider_prompt_rejected(value: &Value) -> bool {\n    classify_provider_retry_failure(value)', 'pub fn is_provider_prompt_rejected(value: &Value) -> bool {\n    classify_provider_retry_status(value)', 'isProviderPromptRejected'],
  ['deadline-contains', 'retry.rs', 'as_str(value).is_some_and(|text| starts_with(text.units(), MANAGED_TASK_TIMEOUT_REASON_PREFIX))', 'as_str(value).is_some_and(|text| crate::text::contains(text.units(), &units(MANAGED_TASK_TIMEOUT_REASON_PREFIX)))', 'isManagedTaskDeadlineExceeded'],
  ['deadline-trim', 'retry.rs', 'as_str(value).is_some_and(|text| starts_with(text.units(), MANAGED_TASK_TIMEOUT_REASON_PREFIX))', 'as_str(value).is_some_and(|text| starts_with(trim(text.units()), MANAGED_TASK_TIMEOUT_REASON_PREFIX))', 'isManagedTaskDeadlineExceeded'],
  ['model-case', 'retry.rs', 'unknown model|invalid model|no such model)\\b",\n    true', 'unknown model|invalid model|no such model)\\b",\n    false', 'isManagedTaskModelUnavailable'],
  ['prompt-kind', 'retry.rs', 'classify_provider_retry_failure(value) == Some(PROVIDER_PROMPT_REJECTED_FAILURE_KIND)', 'classify_provider_retry_failure(value) == Some(PROVIDER_USAGE_LIMIT_FAILURE_KIND)', 'isProviderPromptRejected'],
  ['deadline-prefix', 'retry.rs', 'pub const MANAGED_TASK_TIMEOUT_REASON_PREFIX: &str = "Managed task timed out at ";', 'pub const MANAGED_TASK_TIMEOUT_REASON_PREFIX: &str = "Managed task timed out";', 'isManagedTaskDeadlineExceeded'],
  ['model-alternative', 'retry.rs', '|invalid model|no such model)\\b",\n    true\n);\npattern!(upstream', '|invalid model)\\b",\n    true\n);\npattern!(upstream', 'isManagedTaskModelUnavailable'],
  ['model-provider-error', 'retry.rs', 'r"\\b(?:providermodelnotfound(?:error)?|', 'r"\\b(?:providermodelnotfound|', 'isManagedTaskModelUnavailable'],
  ['managed-order', 'retry.rs', '    if is_managed_task_capability_failure(value) {\n        return Ok(Some("runtime_capability"));\n    }\n    if is_provider_configuration_failure(value) {\n        return Ok(Some(PROVIDER_CONFIGURATION_FAILURE_KIND));\n    }',
    '    if is_provider_configuration_failure(value) {\n        return Ok(Some(PROVIDER_CONFIGURATION_FAILURE_KIND));\n    }\n    if is_managed_task_capability_failure(value) {\n        return Ok(Some("runtime_capability"));\n    }', 'classifyManagedTaskFailure'],
  ['managed-deadline-before-model', 'retry.rs', '    if is_managed_task_model_unavailable(value) {\n        return Ok(Some(MODEL_UNAVAILABLE_FAILURE_KIND));\n    }\n    if is_managed_task_deadline_exceeded(value) {\n        return Ok(Some(DEADLINE_EXCEEDED_FAILURE_KIND));\n    }',
    '    if is_managed_task_deadline_exceeded(value) {\n        return Ok(Some(DEADLINE_EXCEEDED_FAILURE_KIND));\n    }\n    if is_managed_task_model_unavailable(value) {\n        return Ok(Some(MODEL_UNAVAILABLE_FAILURE_KIND));\n    }', 'classifyManagedTaskFailure'],
  ['managed-transport-kind', 'retry.rs', '.map(|_| PROVIDER_TRANSPORT_FAILURE_KIND))', '.map(|kind| kind))', 'classifyManagedTaskFailure'],
  ['readonly-trim', 'retry.rs', 'lower_for_ascii(trim(text.units()))).unwrap_or_default();', 'lower_for_ascii(text.units())).unwrap_or_default();', 'supportsManagedReadOnlyProvider'],
  ['readonly-cursor', 'retry.rs', 'normalized != units("cursor-acp")', 'normalized != units("cursor")', 'supportsManagedReadOnlyProvider'],
  ['readonly-flag', 'retry.rs', 'matches!(cursor_read_only, Value::Bool(true))', 'crate::jsv::truthy(cursor_read_only)', 'supportsManagedReadOnlyProvider'],
  // The regular expression engine and the text helpers every module uses.
  ['regex-word-underscore', 'regex.rs', 'matches!(unit, 0x30..=0x39 | 0x41..=0x5a | 0x61..=0x7a | 0x5f)', 'matches!(unit, 0x30..=0x39 | 0x41..=0x5a | 0x61..=0x7a)', 'the regular expressions'],
  ['regex-literal-case', 'regex.rs', '                        && (*expected ^ 0x20) == unit),', '                        && *expected == unit),', 'the regular expressions'],
  ['regex-repeat-min', 'regex.rs', '                    if run < *min as usize {', '                    if run <= *min as usize && *min > 0 {', 'the regular expressions'],
  ['regex-end-anchor', 'regex.rs', '            Node::End => at == text.len() && next(at, captures),', '            Node::End => next(at, captures),', 'the regular expressions'],
  ['regex-group-twice', 'regex.rs', '        if max.is_none_or(|max| count < max) {', '        if max.is_none_or(|max| count <= max) {', 'the regular expressions'],
  ['whitespace-line-separator', 'text.rs', '0x2028 | 0x2029 | 0x202f', '0x2029 | 0x202f', 'the regular expressions'],
  ['text-trim-bom', 'text.rs', '0x3000 | 0xfeff', '0x3000', 'truncateManagedText'],
  ['text-lone-surrogate-bytes', 'text.rs', '            _ => 3,\n        };', '            0xd800..=0xdfff => 2,\n            _ => 3,\n        };', 'validateManagedTaskRecord'],
  ['text-lower-a', 'text.rs', '            0x41..=0x5a => out.push(unit + 0x20),', '            0x42..=0x5a => out.push(unit + 0x20),', 'classifyProviderRetryFailure'],
  ['text-lower-kelvin', 'text.rs', '            0x212a => out.push(0x6b),\n', '', 'isProviderConfigurationFailure'],
  // contract.js
  ['truncate-bom', 'contract.rs', '    if cut.starts_with(&[0xef, 0xbb, 0xbf]) {', '    if cut.starts_with(&[0xef, 0xbb, 0xbf, 0xff]) {', 'truncateManagedText'],
  ['truncate-common-prefix', 'contract.rs', '        if next > common || bytes > max {', '        if bytes > max {', 'truncateManagedText'],
  ['truncate-fits', 'contract.rs', '    if encoded.len() as u64 <= max {', '    if (encoded.len() as u64) < max {', 'truncateManagedText'],
  ['truncate-range', 'contract.rs', '    if !is_safe_integer(max_bytes) || as_number(max_bytes).is_some_and(|max| max < 0.0) {', '    if !crate::jsv::is_finite(max_bytes) || as_number(max_bytes).is_some_and(|max| max < 0.0) {', 'truncateManagedText'],
  ['truncate-type-first', 'contract.rs', '    let Value::String(text) = value else {\n        return Ok(JsStr::new());\n    };\n    if !is_safe_integer(max_bytes)', '    if matches!(max_bytes, Value::Null) {\n        return range_error("maxBytes must be a non-negative safe integer");\n    }\n    let Value::String(text) = value else {\n        return Ok(JsStr::new());\n    };\n    if !is_safe_integer(max_bytes)', 'truncateManagedText'],
  ['record-idempotency-cap', 'contract.rs', '"idempotencyKey", None, false, Some(1024)', '"idempotencyKey", None, false, Some(1025)', 'validateManagedTaskRecord'],
  ['record-read-only', 'contract.rs', '    if !matches!(field("readOnly"), Value::Bool(_)) {', '    if matches!(field("readOnly"), Value::String(_)) {', 'validateManagedTaskRecord'],
  ['record-order', 'contract.rs', '    assert_string(field("taskId"), "taskId", Some(MANAGED_TASK_ID_PREFIX), false, None)?;\n    assert_string(field("idempotencyKey")', '    assert_string(field("rootSessionId"), "rootSessionId", None, false, None)?;\n    assert_string(field("taskId"), "taskId", Some(MANAGED_TASK_ID_PREFIX), false, None)?;\n    assert_string(field("idempotencyKey")', 'validateManagedTaskRecord'],
  ['record-stop-lease', 'contract.rs', '            || !strict_equal(get(stop, "leaseToken"), field("leaseToken"))?)', '            )', 'validateManagedTaskRecord'],
  ['record-waiting-status', 'contract.rs', '    if !is_str(field("status"), "queued") && !matches!(field("waitingReason"), Value::Null) {', '    if is_str(field("status"), "running") && !matches!(field("waitingReason"), Value::Null) {', 'validateManagedTaskRecord'],
  ['record-json-path', 'contract.rs', 'path.extend(format!("[{index}]").encode_utf16());', 'path.extend(format!(".{index}").encode_utf16());', 'validateManagedTaskRecord'],
  ['record-objective-default', 'contract.rs', 'assert_nullable_string(nullish_or(field("dispatchObjectiveId"), &NULL), "dispatchObjectiveId", None, None)?;', 'assert_nullable_string(field("dispatchObjectiveId"), "dispatchObjectiveId", None, None)?;', 'validateManagedTaskRecord'],
  ['record-waiting-limit', 'contract.rs', '(!is_safe_integer(limit) || as_number(limit).is_some_and(|limit| limit < 1.0))', '(!is_safe_integer(limit) || as_number(limit).is_some_and(|limit| limit < 0.0))', 'validateManagedTaskRecord'],
  ['record-status-message', 'contract.rs', 'format!("status must be one of {}", MANAGED_TASK_STATUSES.join(", "))', 'format!("status must be one of {}", MANAGED_TASK_STATUSES.join(","))', 'validateManagedTaskRecord'],
  ['create-read-only', 'contract.rs', 'task.set("readOnly", nullish_or(get(input, "readOnly"), &Value::Bool(false)).clone());', 'task.set("readOnly", get(input, "readOnly").clone());', 'createManagedTaskRecord'],
  ['create-preview', 'contract.rs', '    task.set("recoverablePreview", Value::string(""));', '    task.set("recoverablePreview", Value::string(" "));', 'createManagedTaskRecord'],
  ['create-spread-last', 'contract.rs', '    let mut task = spread(input);\n    task.set("owner", Value::string(MANAGED_TASK_OWNER));', '    let mut task = JsObject::new();\n    task.set("owner", Value::string(MANAGED_TASK_OWNER));\n    for (key, item) in spread(input).iter() {\n        if task.get(&key).is_none() {\n            task.insert(key, item.clone());\n        }\n    }', 'createManagedTaskRecord'],
  ['create-transport', 'contract.rs', '    task.set("transportRecovery", or_null("transportRecovery"));', '    task.set("transportRecovery", Value::Null);', 'createManagedTaskRecord'],
  ['event-grouped', 'contract.rs', 'out.set("dispatchGrouped", Value::Bool(!matches!(get(task, "dispatchGroupId"), Value::Null)));', 'out.set("dispatchGrouped", Value::Bool(matches!(get(task, "dispatchGroupId"), Value::Null)));', 'toManagedTaskEvent'],
  ['event-stopped', 'contract.rs', '        out.set("stoppedRecoveryAvailable", Value::Bool(true));', '        out.set("stoppedRecoveryAvailable", Value::Bool(false));', 'toManagedTaskEvent'],
  ['event-manual-pending', 'contract.rs', 'let required = !has_pending_operator_stop(task) && matches!', 'let required = matches!', 'toManagedTaskEvent'],
  ['event-envelope-owner', 'contract.rs', '!is_str(get(envelope, "owner"), MANAGED_TASK_OWNER) || !strict_equal', '!strict_equal', 'toManagedTaskEvent'],
  ['event-empty-checks', 'contract.rs', '        if get(task, name).as_array().is_some_and(|items| !items.is_empty()) {', '        if get(task, name).as_array().is_some() {', 'toManagedTaskEvent'],
  ['removal-type', 'contract.rs', 'Value::string("devryan:managed-task-removed")', 'Value::string("devryan:managed-task-remove")', 'toManagedTaskRemovalEvent'],
  ['removal-sequence', 'contract.rs', '        ("sequence", get(task, "sequence").clone()),\n    ]);', '    ]);', 'toManagedTaskRemovalEvent'],
  ['removal-validate', 'contract.rs', 'pub fn to_managed_task_removal_event(task: &Value) -> JsResult<Value> {\n    validate_managed_task_record(task)?;', 'pub fn to_managed_task_removal_event(task: &Value) -> JsResult<Value> {', 'toManagedTaskRemovalEvent'],
  ['manual-attempt', 'contract.rs', '.is_some_and(|attempt| attempt >= 2.0))))', '.is_some_and(|attempt| attempt > 2.0))))', 'requiresManualModelRecovery'],
  ['manual-transport', 'contract.rs', '            || truthy(get(task, "transportRecovery"))\n            || (is_str', '            || (is_str', 'requiresManualModelRecovery'],
  ['manual-prompt-rejected', 'contract.rs', '        && !is_provider_prompt_rejected(reason)\n', '', 'requiresManualModelRecovery'],
  ['stopped-uncertain', 'contract.rs', 'is_str(get(get(task, "operatorStop"), "state"), "uncertain")', 'is_str(get(get(task, "operatorStop"), "state"), "pending")', 'isStoppedRecoveryAvailable'],
  ['stopped-action', 'contract.rs', 'truthy(get(envelope, "resumable")) && matches!(get(envelope, "action"), Value::Null))', 'truthy(get(envelope, "resumable")))', 'isStoppedRecoveryAvailable'],
  ['stopped-interrupted', 'contract.rs', '&& is_one_of(status, &["failed", "interrupted"]));', '&& is_one_of(status, &["failed"]));', 'isStoppedRecoveryAvailable'],
  ['pending-undefined', 'contract.rs', 'truthy(stop) && (matches!(get(stop, "state"), Value::Undefined) || is_str', 'truthy(stop) && (matches!(get(stop, "state"), Value::Null) || is_str', 'hasPendingOperatorStop'],
  ['pending-state', 'contract.rs', '|| is_str(get(stop, "state"), "pending"))', '|| is_str(get(stop, "state"), "accepted"))', 'hasPendingOperatorStop'],
  ['pending-truthy', 'contract.rs', '    truthy(stop) && (matches!', '    !matches!(stop, Value::Undefined) && (matches!', 'hasPendingOperatorStop'],
  ['retry-attempt', 'contract.rs', '.is_some_and(|attempt| attempt < 2.0)', '.is_some_and(|attempt| attempt < 3.0)', 'isManagedTaskAgentRetryAvailable'],
  ['retry-group', 'contract.rs', '        && !matches!(get(task, "dispatchGroupId"), Value::Null)\n        && !has_accepted_user_stop(task)', '        && !has_accepted_user_stop(task)', 'isManagedTaskAgentRetryAvailable'],
  ['retry-usage', 'contract.rs', '        && failure_kind != Some(PROVIDER_USAGE_LIMIT_FAILURE_KIND)\n', '', 'isManagedTaskAgentRetryAvailable'],
  ['accepted-intent', 'contract.rs', 'is_str(get(task, "terminationIntent"), "user_stopped") ||', 'is_str(get(task, "terminationIntent"), "user_stop") ||', 'hasAcceptedUserStop'],
  ['accepted-state', 'contract.rs', '|| is_str(get(get(task, "operatorStop"), "state"), "accepted")\n}', '|| is_str(get(get(task, "operatorStop"), "state"), "uncertain")\n}', 'hasAcceptedUserStop'],
  ['accepted-and', 'contract.rs', 'is_str(get(task, "terminationIntent"), "user_stopped") || is_str', 'is_str(get(task, "terminationIntent"), "user_stopped") && is_str', 'hasAcceptedUserStop'],
  ['terminal-list', 'primitives.rs', 'MANAGED_TASK_TERMINAL_STATUSES: [&str; 4] = ["completed", "failed", "aborted", "interrupted"];', 'MANAGED_TASK_TERMINAL_STATUSES: [&str; 3] = ["completed", "failed", "aborted"];', 'isTerminalManagedTaskStatus'],
  ['terminal-live', 'contract.rs', 'is_one_of(status, &MANAGED_TASK_TERMINAL_STATUSES)', 'is_one_of(status, &MANAGED_TASK_STATUSES)', 'isTerminalManagedTaskStatus'],
  ['terminal-statuses', 'primitives.rs', 'MANAGED_TASK_STATUSES: [&str; 7] = ["queued", "starting", "running", "completed", "failed", "aborted", "interrupted"];', 'MANAGED_TASK_STATUSES: [&str; 8] = ["queued", "starting", "running", "completed", "failed", "aborted", "interrupted", "done"];', 'isTerminalManagedTaskStatus'],
  // result-envelope.js
  ['resume-attempts-default', 'envelope.rs', 'let attempt_count = nullish_or(field("attemptCount"), &zero);', 'let attempt_count = field("attemptCount");', 'validateManagedTaskAutoResume'],
  ['resume-trigger-kept', 'envelope.rs', '    if !matches!(field("trigger"), Value::Undefined) {\n        out.set("trigger"', '    {\n        out.set("trigger"', 'validateManagedTaskAutoResume'],
  ['resume-variant-default', 'envelope.rs', 'let variant = nullish_or(get(raw_target, "variant"), &NULL);', 'let variant = get(raw_target, "variant");', 'validateManagedTaskAutoResume'],
  ['resume-enum-message', 'envelope.rs', 'type_error(format!("{field} must be one of {}", allowed.join(", ")))', 'type_error(format!("{field} must be one of {}", allowed.join("|")))', 'validateManagedTaskAutoResume'],
  ['resume-error-empty', 'envelope.rs', '"autoResume.lastError.message", None, true, None', '"autoResume.lastError.message", None, false, None', 'validateManagedTaskAutoResume'],
  ['envelope-prefix', 'envelope.rs', '"envelopeId", Some("dvr_result_")', '"envelopeId", Some("dvr_result")', 'validateManagedTaskResultEnvelope'],
  ['envelope-observed-sequence', 'envelope.rs', '.is_some_and(|(observed, sequence)| observed > sequence)', '.is_some_and(|(observed, sequence)| observed >= sequence)', 'validateManagedTaskResultEnvelope'],
  ['envelope-cleanup-code', 'envelope.rs', 'if is_str(get(value, "state"), "failed") != !matches!(get(value, "code"), Value::Undefined) {', 'if is_str(get(value, "state"), "done") && !matches!(get(value, "code"), Value::Undefined) {', 'validateManagedTaskResultEnvelope'],
  ['envelope-identity-action', 'envelope.rs', 'acknowledgement_identity().test(identity.units())) || matches!(field("action"), Value::Null))', 'acknowledgement_identity().test(identity.units())))', 'validateManagedTaskResultEnvelope'],
  ['envelope-terminal', 'envelope.rs', '    if !is_terminal_managed_task_status(field("status")) {\n        return type_error("result status must be terminal");', '    if is_str(field("status"), "queued") {\n        return type_error("result status must be terminal");', 'validateManagedTaskResultEnvelope'],
  ['create-envelope-id', 'envelope.rs', 'concat(&[&units("dvr_result_"), suffix, &units("_"), to_string(sequence)?.units()])', 'concat(&[&units("dvr_result_"), suffix, &units("-"), to_string(sequence)?.units()])', 'createManagedTaskResultEnvelope'],
  ['create-resumable-child', 'envelope.rs', 'Value::Bool(truthy(get(options, "resumable")) && truthy(get(task, "childSessionId")))', 'Value::Bool(truthy(get(options, "resumable")))', 'createManagedTaskResultEnvelope'],
  ['create-reset-negative', 'envelope.rs', '        if non_negative_finite(provider_reset_at) {', '        if is_finite(provider_reset_at) {', 'createManagedTaskResultEnvelope'],
  ['create-refs-copy', 'envelope.rs', '        .map(|reference| Value::Object(spread(reference)))\n', '        .cloned()\n', 'createManagedTaskResultEnvelope'],
  ['match-message', 'envelope.rs', 'units(&format!("result envelope {field} does not match task "))', 'units(&format!("result envelope {field} differs from task "))', 'assertManagedTaskResultEnvelopeMatchesTask'],
  ['match-refs-message', 'envelope.rs', 'units("result envelope canonicalRefs do not match task ")', 'units("result envelope canonicalRefs does not match task ")', 'assertManagedTaskResultEnvelopeMatchesTask'],
  ['match-validate-task', 'envelope.rs', 'pub fn assert_managed_task_result_envelope_matches_task(task: &Value, envelope: &Value) -> JsResult<()> {\n    validate_managed_task_record(task)?;', 'pub fn assert_managed_task_result_envelope_matches_task(task: &Value, envelope: &Value) -> JsResult<()> {', 'assertManagedTaskResultEnvelopeMatchesTask'],
  // codec-primitives.js, scheduler.js exports
  ['task-id-empty', 'primitives.rs', 'r"^dvr_task_[A-Za-z0-9_-]+$"', 'r"^dvr_task_[A-Za-z0-9_-]*$"', 'isManagedTaskId'],
  ['task-id-dash', 'primitives.rs', 'r"^dvr_task_[A-Za-z0-9_-]+$"', 'r"^dvr_task_[A-Za-z0-9_]+$"', 'isManagedTaskId'],
  ['task-id-anchor', 'primitives.rs', 'r"^dvr_task_[A-Za-z0-9_-]+$"', 'r"^dvr_task_[A-Za-z0-9_-]+"', 'isManagedTaskId'],
  ['mismatch-same-value', 'primitives.rs', '        if !same_value(read(task, field)?, read(envelope, field)?)? {', '        if !crate::jsv::strict_equal(read(task, field)?, read(envelope, field)?)? {', 'findManagedResultPayloadMismatch'],
  ['mismatch-own-fields', 'primitives.rs', 'if require_own_fields && (!has_own_or_throw(task, field)? || !has_own_or_throw(envelope, field)?) {', 'if require_own_fields && !has_own_or_throw(task, field)? {', 'findManagedResultPayloadMismatch'],
  ['mismatch-refs-arrays', 'primitives.rs', 'if require_own_fields && (task_refs.as_array().is_none() || envelope_refs.as_array().is_none()) {', 'if false && (task_refs.as_array().is_none() || envelope_refs.as_array().is_none()) {', 'findManagedResultPayloadMismatch'],
  ['collation-byte-order', 'primitives.rs', '        0x5f => Some(0),\n        0x30..=0x39 => Some(unit - 0x30 + 1),', '        0x5f => Some(10),\n        0x30..=0x39 => Some(unit - 0x30),', 'compareManagedTaskQueueOrder'],
  ['queue-created-first', 'primitives.rs', '    let sequence = difference(read(left, "sequence")?, read(right, "sequence")?)?;', '    let sequence = difference(read(left, "createdAt")?, read(right, "createdAt")?)?;', 'compareManagedTaskQueueOrder'],
  ['queue-nan-falls-through', 'primitives.rs', '    if truthy(&Value::Number(created)) {', '    if created != 0.0 {', 'compareManagedTaskQueueOrder'],
  ['queue-alphabet', 'primitives.rs', '        0x61..=0x7a => Some(unit - 0x61 + 11),', '        0x41..=0x7a => Some(unit - 0x41 + 11),', 'compareManagedTaskQueueOrder'],
  ['active-state-list', 'primitives.rs', 'pub const AUTO_RESUME_ACTIVE_STATES: [&str; 3] = ["planning", "scheduled", "attempting"];', 'pub const AUTO_RESUME_ACTIVE_STATES: [&str; 3] = ["planning", "scheduled", "superseded"];', 'isAutoResumeActiveState'],
  ['active-state-all', 'primitives.rs', 'as_str(state).is_some_and(|state| AUTO_RESUME_ACTIVE_STATES.iter().any(|active| state == *active))', 'as_str(state).is_some_and(|state| AUTO_RESUME_STATES.iter().any(|active| state == *active))', 'isAutoResumeActiveState'],
  ['active-state-two', 'primitives.rs', 'AUTO_RESUME_ACTIVE_STATES.iter().any(|active| state == *active)', 'AUTO_RESUME_ACTIVE_STATES[..2].iter().any(|active| state == *active)', 'isAutoResumeActiveState'],
  ['duplicate-window', 'primitives.rs', 'pub const DUPLICATE_DISPATCH_WINDOW_MS: f64 = 10.0 * 60.0 * 1_000.0;', 'pub const DUPLICATE_DISPATCH_WINDOW_MS: f64 = 10.0 * 60.0 * 100.0;', 'DUPLICATE_DISPATCH_WINDOW_MS'],
  ['random-id-uuid', 'primitives.rs', 'globalThis.crypto?.randomUUID?.()', 'globalThis.crypto?.randomUUID()', 'scheduler random IDs'],
  ['random-id-source', 'primitives.rs', "  return `${prefix}${random.replaceAll('-', '')}`;", "  return `${prefix}${random}`;", 'scheduler random IDs'],
  ['payload-fields', 'primitives.rs', '    "executionKind",\n    "recoverablePreview",\n];', '    "recoverablePreview",\n    "recoverablePreview",\n];', 'findManagedResultPayloadMismatch'],
  // required-checks.js, check-correction.js
  ['checks-count', 'checks.rs', 'let Some(checks) = value.as_array().filter(|checks| checks.len() <= 8) else {', 'let Some(checks) = value.as_array().filter(|checks| checks.len() <= 9) else {', 'validateRequiredChecks'],
  ['checks-paths', 'checks.rs', 'paths.is_empty() || paths.len() > 32 ||', 'paths.is_empty() || paths.len() > 33 ||', 'validateRequiredChecks'],
  ['checks-environment-string', 'checks.rs', '!environment_name().test(to_string(environment)?.units())', '!as_str(environment).is_some_and(|text| environment_name().test(text.units()))', 'validateRequiredChecks'],
  ['checks-size-class', 'checks.rs', '        return range_error("requiredChecks exceeds 32 KiB");', '        return type_error("requiredChecks exceeds 32 KiB");', 'validateRequiredChecks'],
  ['checks-relative-absolute', 'checks.rs', '!text.units().contains(&0) && !absolute_path().test(text.units()) && !has_parent_segment(text.units()))\n}', '!text.units().contains(&0) && !has_parent_segment(text.units()))\n}', 'validateRequiredChecks'],
  ['checks-parent-segment', 'checks.rs', 'fn has_parent_segment(text: &[u16]) -> bool {\n    split_slashes(text).iter().any(|piece| *piece == units("..").as_slice())', 'fn has_parent_segment(text: &[u16]) -> bool {\n    split_slashes(text).iter().any(|piece| *piece == units("...").as_slice())', 'validateRequiredChecks'],
  ['receipts-passed-exit', 'checks.rs', '(as_number(exit_code) != Some(0.0) || !hash(content_hash))', '!hash(content_hash)', 'validateRequiredCheckReceipts'],
  ['receipts-skipped-evidence', 'checks.rs', '        if is_str(status, "skipped") && !truthy(unavailable) {', '        if is_str(status, "blocked") && !truthy(unavailable) {', 'validateRequiredCheckReceipts'],
  ['receipts-waiver-source', 'checks.rs', '!is_str(get(waiver, "source"), "authenticated-user")', '!is_str(get(waiver, "source"), "authenticated")', 'validateRequiredCheckReceipts'],
  ['receipts-duplicate', 'checks.rs', '        if seen.contains(name)\n', '        if false\n', 'validateRequiredCheckReceipts'],
  ['receipts-count', 'checks.rs', 'receipts.as_array().filter(|receipts| receipts.len() <= checks.len())', 'receipts.as_array().filter(|receipts| receipts.len() <= checks.len() + 1)', 'validateRequiredCheckReceipts'],
  ['visual-fresh', 'checks.rs', '        && (matches!(freshness, Value::Undefined) || is_str(freshness, "fresh"))', '        && (matches!(freshness, Value::Undefined) || !is_str(freshness, "stale"))', 'visualCheckPassed'],
  ['visual-assertion-count', 'checks.rs', '        && observed.len() == required.len()\n', '', 'visualCheckPassed'],
  ['visual-assertion-passed', 'checks.rs', 'as_str(get(entry, "name")) == as_str(name) && is_str(get(entry, "status"), "passed"))', 'as_str(get(entry, "name")) == as_str(name))', 'visualCheckPassed'],
  ['correction-verified', 'checks.rs', '!is_str(get(identity, "verifiedBy"), "host-policy")', '!is_str(get(identity, "verifiedBy"), "host")', 'validateCheckCorrection'],
  ['correction-nested-path', 'checks.rs', '                let mut nested = function_path.clone();\n                nested.push(u16::from(b\'/\'));', '                let nested = function_path.clone();', 'validateCheckCorrection'],
  ['correction-workers', 'checks.rs', '(?: --maxWorkers=[1-9]\\d{0,2})?$"', '(?: --maxWorkers=\\d{1,3})?$"', 'validateCheckCorrection'],
  ['correction-previous-receipt', 'checks.rs', '    if !matches!(previous_receipt, Value::Undefined) {\n        validate_required_check_receipts', '    if matches!(previous_receipt, Value::Null) {\n        validate_required_check_receipts', 'validateCheckCorrection'],
  ['history-count', 'checks.rs', 'let Some(entries) = history.as_array().filter(|entries| entries.len() <= 128) else {', 'let Some(entries) = history.as_array().filter(|entries| entries.len() <= 129) else {', 'validateCheckCorrectionHistory'],
  ['history-entry-code', 'checks.rs', '        if !is_record(entry) {\n            return fail(CORRECTION_INVALID);', '        if !is_record(entry) {\n            return fail(CORRECTION_LIMIT);', 'validateCheckCorrectionHistory'],
  ['history-previous-check', 'checks.rs', '    let previous = rest.remove(&JsStr::from("previousCheck")).unwrap_or(Value::Undefined);', '    let previous = rest.get(&JsStr::from("previousCheck")).cloned().unwrap_or(Value::Undefined);', 'validateCheckCorrectionHistory'],
  ['apply-receipts-filter', 'checks.rs', '        .filter(|receipt| as_str(get(receipt, "name")) != previous_name)\n        .cloned()\n', '        .cloned()\n', 'applyCheckCorrection'],
  ['apply-command', 'checks.rs', '                copy.set("command", get(correction, "command").clone());', '', 'applyCheckCorrection'],
  ['apply-stale-command', 'checks.rs', '    if as_str(get(previous_check, "command")) != as_str(get(correction, "previousCommand")) {\n        return fail(CORRECTION_STALE);\n    }', '', 'applyCheckCorrection'],
  ['apply-stale-receipt', 'checks.rs', 'stringify(nullish_or(get(correction, "previousReceipt"), &Value::Null))? != stringify(previous_receipt.unwrap_or(&Value::Null))?', 'false', 'applyCheckCorrection'],
  ['correction-transition-catch', 'checks.rs', '        Err(Failure::Throw(_)) => Ok(false),', '        Err(Failure::Throw(_)) => Ok(true),', 'isCheckCorrectionTransition'],
  ['correction-transition-slice', 'checks.rs', 'json_equal(&Value::Array(history_items[..history_items.len() - 1].to_vec()), prior)?', 'json_equal(&Value::Array(history_items.to_vec()), prior)?', 'isCheckCorrectionTransition'],
  ['correction-transition-checks', 'checks.rs', 'Ok(json_equal(get(&applied, "checks"), get(next, "requiredChecks"))?\n', 'Ok(true\n', 'isCheckCorrectionTransition'],
  // task-prerequisites.js, approved-plan.js, designer-step-budget.js, native-job-segments.js, transport-recovery.js
  ['prerequisites-count', 'leaves.rs', 'let Some(references) = value.as_array().filter(|items| items.len() <= 8) else {', 'let Some(references) = value.as_array().filter(|items| items.len() <= 9) else {', 'validateTaskPrerequisites'],
  ['prerequisites-keys', 'leaves.rs', '|| joined != units("checkName,contentHash,paths,taskId")', '|| keys(reference).len() != 4', 'validateTaskPrerequisites'],
  ['prerequisites-duplicate', 'leaves.rs', '            return type_error("Duplicate task prerequisite");', '            return Ok(());', 'validateTaskPrerequisites'],
  ['prerequisites-size', 'leaves.rs', '        return range_error("Task prerequisites exceed 32 KiB");', '        return type_error("Task prerequisites exceed 32 KiB");', 'validateTaskPrerequisites'],
  ['plan-bytes', 'leaves.rs', 'as_str(value).is_some_and(|text| !trim(text.units()).is_empty() && utf8_len(text.units()) <= limit)', 'as_str(value).is_some_and(|text| !trim(text.units()).is_empty() && text.len() as u64 <= limit)', 'validateApprovedPlanRef'],
  ['plan-paths-count', 'leaves.rs', '            paths.len() > 32\n', '            paths.len() > 33\n', 'validateApprovedPlanRef'],
  ['plan-absolute', 'leaves.rs', 'pattern!(plan_absolute_path, r"^(?:[\\\\/]|[a-zA-Z]:)", false);', 'pattern!(plan_absolute_path, r"^(?:\\/|[a-zA-Z]:)", false);', 'validateApprovedPlanRef'],
  ['plan-version-digest', 'leaves.rs', '        || !matches_str(get(value, "version"), plan_digest())\n', '', 'validateApprovedPlanRef'],
  ['budget-warning', 'leaves.rs', 'const DESIGNER_PRIMARY_STEP_WARNING: usize = 180;', 'const DESIGNER_PRIMARY_STEP_WARNING: usize = 179;', 'validatePrimaryStepBudget'],
  ['budget-emergency', 'leaves.rs', 'const DESIGNER_PRIMARY_STEP_EMERGENCY: usize = 260;', 'const DESIGNER_PRIMARY_STEP_EMERGENCY: usize = 261;', 'validatePrimaryStepBudget'],
  ['budget-null-user', 'leaves.rs', '                                || (matches!(user_message, Value::Null) && !assistant.is_empty())\n', '', 'validatePrimaryStepBudget'],
  ['budget-parent-prompt', 'leaves.rs', '                                        || !has_prompt(get(parent, "userMessageID"))\n', '', 'validatePrimaryStepBudget'],
  ['backend-cursor', 'leaves.rs', 'const BACKENDS: [&str; 3] = ["legacy-session", "native-job", "cursor"];', 'const BACKENDS: [&str; 3] = ["legacy-session", "native-job", "native"];', 'validateManagedExecutionBackend'],
  ['backend-undefined', 'leaves.rs', '    if !matches!(value, Value::Undefined) && !is_one_of(value, &BACKENDS) {', '    if !is_one_of(value, &BACKENDS) {', 'validateManagedExecutionBackend'],
  ['backend-message', 'leaves.rs', 'type_error("Invalid managed execution backend")', 'type_error("Invalid execution backend")', 'validateManagedExecutionBackend'],
  ['segments-same-message', 'leaves.rs', '            || as_str(get(segment, "messageID")) == as_str(get(segment, "notificationID"))\n', '', 'validateManagedNativeJobSegments'],
  ['segments-identity-key', 'leaves.rs', 'concat(&[&units(key), &units(":"), as_str(get(segment, key)).expect("a checked id").units()])', 'concat(&[as_str(get(segment, key)).expect("a checked id").units()])', 'validateManagedNativeJobSegments'],
  ['segments-backend', 'leaves.rs', 'value.as_array().filter(|_| is_str(backend, "native-job"))', 'value.as_array()', 'validateManagedNativeJobSegments'],
  ['receipt-transition-done', 'leaves.rs', '|| (is_str(completion, "pending") && is_str(next_completion, "done"))', '', 'isManagedNativeJobReceiptTransition'],
  ['receipt-transition-state', 'leaves.rs', '        if !strict_equal(get(segment, "state"), read(later, "state")?)? {\n            return Ok(false);\n        }', '', 'isManagedNativeJobReceiptTransition'],
  ['receipt-transition-length', 'leaves.rs', '    if before.len() != after.len() {\n        return Ok(false);\n    }', '    if after.is_empty() {\n        return Ok(false);\n    }', 'isManagedNativeJobReceiptTransition'],
  ['transport-backup-zero', 'leaves.rs', 'matches!(backup, Value::Number(number) if *number == 0.0 || *number == 1.0)', 'matches!(backup, Value::Number(number) if (*number == 0.0 && number.is_sign_positive()) || *number == 1.0)', 'validateManagedTransportRecovery'],
  ['transport-unknown-message', 'leaves.rs', 'units("Unknown transportRecovery field: ")', 'units("Unknown transportRecovery field ")', 'validateManagedTransportRecovery'],
  ['transport-submitted-order', 'leaves.rs', '.is_some_and(|(submitted, reserved)| submitted < reserved)', '.is_some_and(|(submitted, reserved)| submitted <= reserved)', 'validateManagedTransportRecovery'],
  ['transport-event-null', 'leaves.rs', '(field == "failedUserMessageId" || field == "eventId")', '(field == "failedUserMessageId")', 'validateManagedTransportRecovery'],
  ['backup-phase', 'leaves.rs', 'if !is_str(get(recovery, "phase"), "exhausted")', 'if !is_str(get(recovery, "phase"), "submitted")', 'isManagedTransportBackupEligible'],
  ['backup-attempts', 'leaves.rs', '|| as_number(get(recovery, "backupAttempts")) != Some(0.0)\n', '', 'isManagedTransportBackupEligible'],
  ['backup-configuration', 'leaves.rs', 'Ok(is_provider_configuration_failure(reason) || classify_provider_transport_failure', 'Ok(classify_provider_transport_failure', 'isManagedTransportBackupEligible'],
  ['disposition-aborted', 'leaves.rs', 'is_one_of(get(task, "status"), &["failed", "aborted", "interrupted"])', 'is_one_of(get(task, "status"), &["failed", "interrupted"])', 'requiresManagedNativeInputDisposition'],
  ['disposition-backend', 'leaves.rs', 'Ok(is_str(read(task, "executionBackend")?, "native-job")', 'Ok(!is_str(read(task, "executionBackend")?, "cursor")', 'requiresManagedNativeInputDisposition'],
  ['disposition-length', 'leaves.rs', '        && length_above_zero(get(task, "nativeJobSegments"))?)\n}\n\nconst TRANSPORT_PHASES', '        && !matches!(get(task, "nativeJobSegments"), Value::Undefined))\n}\n\nconst TRANSPORT_PHASES', 'requiresManagedNativeInputDisposition'],
  // codec.js
  ['decode-version', 'codec.rs', 'as_number(get(value, "version")) != Some(1.0)', 'as_number(get(value, "version")).is_none()', 'decodeLedgerSnapshot'],
  ['decode-idempotency-separator', 'codec.rs', 'let key = concat(&[root.units(), &[0], as_str', 'let key = concat(&[as_str', 'decodeLedgerSnapshot'],
  ['decode-require-envelopes', 'codec.rs', '    if options.require_result_envelopes && envelopes.as_array().is_none() {', '    if envelopes.as_array().is_none() {', 'decodeLedgerSnapshot'],
  ['decode-orphan-first', 'codec.rs', '        if envelope_task_ids.contains(&task_id) {\n            return Err(fail("duplicate_result_envelope", detail()));\n        }', '        if envelope_task_ids.contains(&task_id) && !tasks_by_id.contains_key(&task_id) {\n            return Err(fail("duplicate_result_envelope", detail()));\n        }', 'decodeLedgerSnapshot'],
  ['decode-objective-length', 'codec.rs', 'text.is_empty() || text.len() > 4096', 'text.is_empty() || text.len() > 4097', 'decodeLedgerSnapshot'],
  ['decode-detail-envelope', 'codec.rs', '                ("envelopeId", get(&envelope, "envelopeId").clone()),\n', '', 'decodeLedgerSnapshot'],
  ['decode-objective-receipts', 'codec.rs', '        validate_required_check_receipts(get(record, "requiredCheckReceipts"), get(record, "requiredChecks"))?;\n', '', 'decodeLedgerSnapshot'],
  ['encode-newline', 'codec.rs', '    bytes.push(b\'\\n\');\n    Ok(bytes)', '    Ok(bytes)', 'encodeLedgerSnapshot'],
  ['encode-default-order', 'codec.rs', '    ("readOnly", Fallback::False),\n    ("recoveryLineageId", Fallback::Null),', '    ("recoveryLineageId", Fallback::Null),\n    ("readOnly", Fallback::False),', 'encodeLedgerSnapshot'],
  ['encode-default-false', 'codec.rs', '            Fallback::False => Value::Bool(false),', '            Fallback::False => Value::Null,', 'encodeLedgerSnapshot'],
  ['encode-envelope-defaults', 'codec.rs', 'const ENVELOPE_LEGACY_DEFAULTS: [(&str, Fallback); 2] = [("providerResetAt", Fallback::Null), ("autoResume", Fallback::Null)];', 'const ENVELOPE_LEGACY_DEFAULTS: [(&str, Fallback); 2] = [("autoResume", Fallback::Null), ("providerResetAt", Fallback::Null)];', 'encodeLedgerSnapshot'],
  ['encode-spread-last', 'codec.rs', '    let mut snapshot: JsObject = spread(value);\n    snapshot.set("tasks", Value::Array(tasks));', '    let mut snapshot = JsObject::new();\n    snapshot.set("tasks", Value::Array(tasks));\n    for (key, item) in spread(value).iter() {\n        if snapshot.get(&key).is_none() {\n            snapshot.insert(key, item.clone());\n        }\n    }', 'encodeLedgerSnapshot'],
  // persistence.js
  ['compact-lineage-bound', 'persistence.rs', 'pub const MAX_RETAINED_LINEAGE_RECORDS: usize = 3;', 'pub const MAX_RETAINED_LINEAGE_RECORDS: usize = 4;', 'compactManagedOrchestrationState'],
  ['compact-age', 'persistence.rs', '            if now - age(&tasks[index])? > max_age_ms {', '            if now - age(&tasks[index])? >= max_age_ms {', 'compactManagedOrchestrationState'],
  ['compact-separators', 'persistence.rs', 'let separators = |count: i64| (count - 1).max(0);', 'let separators = |count: i64| count.max(0);', 'compactManagedOrchestrationState'],
  ['compact-tombstone-bytes', 'persistence.rs', '            if ((serialized_bytes - tombstone_bytes) as f64) <= max_bytes {', '            if (serialized_bytes as f64) <= max_bytes {', 'compactManagedOrchestrationState'],
  ['compact-expire', 'persistence.rs', 'let expire_unacknowledged = !matches!(get(options, "expireUnacknowledged"), Value::Bool(false));', 'let expire_unacknowledged = truthy(get(options, "expireUnacknowledged"));', 'compactManagedOrchestrationState'],
  ['compact-released-fields', 'persistence.rs', '    object.set("canonicalRefs", Value::Array(Vec::new()));\n}', '}', 'compactManagedOrchestrationState'],
  ['compact-released-list', 'persistence.rs', '    "primaryStepBudget",\n    "dispatchObjectiveId",\n];', '    "primaryStepBudget",\n    "primaryStepBudget",\n];', 'compactManagedOrchestrationState'],
  ['compact-proof-hard', 'persistence.rs', 'if run.is_tombstone(task)? && !protection.hard.contains(&task_id) && envelope_task_ids', 'if run.is_tombstone(task)? && envelope_task_ids', 'compactManagedOrchestrationState'],
  ['compact-parked-prior', 'persistence.rs', '        hard.insert(prior.clone());\n        // The walk', '        // The walk', 'compactManagedOrchestrationState'],
  ['compact-collect-checks', 'persistence.rs', '            && length_above_zero(get(task, "requiredChecks"))?\n', '', 'compactManagedOrchestrationState'],
  ['compact-oldest-first', 'persistence.rs', '        return Ok(by_age.partial_cmp(&0.0).expect("finite"));', '        return Ok(0.0.partial_cmp(&by_age).expect("finite"));', 'compactManagedOrchestrationState'],
  ['compact-active-roots', 'persistence.rs', '|| now - latest <= max_age_ms {', '|| now - latest < max_age_ms {', 'compactManagedOrchestrationState'],
  ['compact-lineage-key', 'persistence.rs', '    if let Some(lineage) = as_str(get(task, "recoveryLineageId")).filter(|lineage| !lineage.is_empty()) {\n        return Ok(lineage.clone());\n    }', '', 'compactManagedOrchestrationState'],
  ['compact-shell-bytes', 'persistence.rs', '    let mut serialized_bytes = byte_length(&shell)?\n', '    let mut serialized_bytes = 0\n', 'compactManagedOrchestrationState'],
  ['tombstone-prompt', 'persistence.rs', 'pub const MANAGED_NATIVE_JOB_TOMBSTONE_PROMPT: &str = "Released native job proof";', 'pub const MANAGED_NATIVE_JOB_TOMBSTONE_PROMPT: &str = "Released native proof";', 'isManagedNativeJobTombstone'],
  ['tombstone-completion', 'persistence.rs', '        if !is_str(read(segment, "completion")?, "done") {', '        if is_str(read(segment, "completion")?, "pending") {', 'isManagedNativeJobTombstone'],
  ['tombstone-terminal', 'persistence.rs', '    if !is_terminal_managed_task_status(read(task, "status")?)\n        || !is_str(get(task, "executionBackend"), "native-job")', '    if read(task, "status")?.as_array().is_some()\n        || !is_str(get(task, "executionBackend"), "native-job")', 'isManagedNativeJobTombstone'],
  // transitions.js
  ['transition-queued-aborted', 'transitions.rs', '    ("queued", &["starting", "aborted"]),', '    ("queued", &["starting"]),', 'canTransitionManagedTaskStatus'],
  ['transition-prototype', 'transitions.rs', '    if OBJECT_PROTOTYPE_KEYS.iter().any(|name| key == *name) {', '    if OBJECT_PROTOTYPE_KEYS.iter().skip(1).any(|name| key == *name) {', 'canTransitionManagedTaskStatus'],
  ['transition-same-status', 'transitions.rs', '    if strict_equal(from, to)? {\n        return Ok(true);\n    }', '', 'canTransitionManagedTaskStatus'],
  ['transition-to-string', 'transitions.rs', '    let key = to_string(from)?;', '    let key = crate::jsv::as_str(from).cloned().unwrap_or_default();', 'canTransitionManagedTaskStatus'],
  ['transition-deadline-window', 'transitions.rs', 'after > before && after - before <= 15.0 * 60_000.0', 'after > before && after - before <= 16.0 * 60_000.0', 'assertManagedTaskTransition'],
  ['transition-designer', 'transitions.rs', 'is_one_of(get(previous, "agent"), &["fixer", "designer"])', 'is_one_of(get(previous, "agent"), &["fixer"])', 'assertManagedTaskTransition'],
  ['transition-immutable-label', 'transitions.rs', '    "label",\n    "prompt",', '    "prompt",\n    "prompt",', 'assertManagedTaskTransition'],
  ['transition-terminal-stop', 'transitions.rs', '        if key == "operatorStop" || key == "requiredCheckReceipts" {', '        if key == "requiredCheckReceipts" {', 'assertManagedTaskTransition'],
  ['transition-identity', 'transitions.rs', '        return Ok(same(key));', '        return Ok(crate::jsv::json_equal(before, after)?);', 'assertManagedTaskTransition'],
  ['transition-waiting', 'transitions.rs', '    if !is_str(get(next, "status"), "queued") && !matches!(get(next, "waitingReason"), Value::Null) {\n        return plain_error', '    if is_str(get(next, "status"), "running") && !matches!(get(next, "waitingReason"), Value::Null) {\n        return plain_error', 'assertManagedTaskTransition'],
  ['transition-correction', 'transitions.rs', '    if definitions_changed && !is_check_correction_transition(previous, next)? {', '    if definitions_changed {', 'assertManagedTaskTransition'],
  // auto-resume-policy.js
  ['lineage-prefix', 'auto_resume.rs', 'pub const MANAGED_LINEAGE_ID_PREFIX: &str = "dvr_lineage_";', 'pub const MANAGED_LINEAGE_ID_PREFIX: &str = "dvr_lineage";', 'createLineageId'],
  ['lineage-check', 'auto_resume.rs', '        Some(id) if crate::text::starts_with(id.units(), MANAGED_TASK_ID_PREFIX) => {', '        Some(id) if id.len() >= MANAGED_TASK_ID_PREFIX.len() => {', 'createLineageId'],
  ['lineage-message', 'auto_resume.rs', 'type_error("rootTaskId must be a managed task id")', 'type_error("rootTaskId must be a task id")', 'createLineageId'],
  ['eligible-backup', 'auto_resume.rs', '        || as_number(get(get(task, "transportRecovery"), "backupAttempts")) == Some(1.0)\n', '', 'isAutoResumeEligible'],
  ['eligible-stop', 'auto_resume.rs', '        || truthy(get(task, "operatorStop"))\n', '', 'isAutoResumeEligible'],
  ['eligible-action', 'auto_resume.rs', '        || !matches!(get(envelope, "action"), Value::Null)\n', '', 'isAutoResumeEligible'],
  ['active-enabled', 'auto_resume.rs', 'truthy(state) && matches!(get(state, "enabled"), Value::Bool(true)) &&', 'truthy(state) && truthy(get(state, "enabled")) &&', 'isAutoResumeActive'],
  ['active-state', 'auto_resume.rs', '&& is_auto_resume_active_state(get(state, "state"))', '&& !matches!(get(state, "state"), Value::Undefined)', 'isAutoResumeActive'],
  ['active-field', 'auto_resume.rs', '    let state = get(envelope, "autoResume");\n    truthy(state)', '    let state = envelope;\n    truthy(state)', 'isAutoResumeActive'],
  ['initial-inherit', 'auto_resume.rs', '.is_some_and(|state| state == "attempting")', '.is_some_and(|state| state == "attempting" || state == "scheduled")', 'initialAutoResumeState'],
  ['initial-expires', 'auto_resume.rs', 'Value::Number(now_number + AUTO_RESUME_MAX_LINEAGE_MS)', 'Value::Number(now_number + AUTO_RESUME_MAX_LINEAGE_MS - 1.0)', 'initialAutoResumeState'],
  ['initial-reset-source', 'auto_resume.rs', '    } else if inherit && strict_equal(&reset_at, get(prior, "resetAt"))? {', '    } else if inherit {', 'initialAutoResumeState'],
  ['initial-cycle-default', 'auto_resume.rs', '                nullish_or(get(prior, "recoveryCycleTaskId"), &NULL).clone()', '                get(prior, "recoveryCycleTaskId").clone()', 'initialAutoResumeState'],
  ['rejection-jitter', 'auto_resume.rs', '(raw - window).abs() <= AUTO_RESUME_RESET_JITTER_MS)', '(raw - window).abs() < AUTO_RESUME_RESET_JITTER_MS)', 'recordProviderRejection'],
  ['rejection-count', 'auto_resume.rs', '            plus(get(state, "rejectionsInWindow"), 1.0)?\n        } else {\n            Value::Number(1.0)', '            plus(get(state, "rejectionsInWindow"), 1.0)?\n        } else {\n            Value::Number(0.0)', 'recordProviderRejection'],
  ['rejection-probes', 'auto_resume.rs', '        if matches!(reset_at, Value::Null) {\n            plus(probes, 1.0)?', '        if true {\n            plus(probes, 1.0)?', 'recordProviderRejection'],
  ['rejection-raw-reset', 'auto_resume.rs', 'as_number(&raw_reset)', 'as_number(&reset_at)', 'recordProviderRejection'],
  ['plan-max-attempts', 'auto_resume.rs', 'pub const AUTO_RESUME_MAX_ATTEMPTS: f64 = 8.0;', 'pub const AUTO_RESUME_MAX_ATTEMPTS: f64 = 7.0;', 'planAutoResumeAttempt'],
  ['plan-jitter', 'auto_resume.rs', 'pub const AUTO_RESUME_RESET_JITTER_MS: f64 = 15_000.0;', 'pub const AUTO_RESUME_RESET_JITTER_MS: f64 = 10_000.0;', 'planAutoResumeAttempt'],
  ['plan-ladder', 'auto_resume.rs', '    let delay = if ladder.trunc() == ladder && (0.0..3.0).contains(&ladder) {\n        AUTO_RESUME_BACKOFF_MS[ladder as usize]', '    let delay = if ladder.is_finite() {\n        AUTO_RESUME_BACKOFF_MS[(ladder.max(0.0) as usize).min(2)]', 'planAutoResumeAttempt'],
  ['plan-backup-read-only', 'auto_resume.rs', '        && (!truthy(get(task, "readOnly")) || supports_managed_read_only_provider(backup_provider, cursor_read_only))\n', '', 'planAutoResumeAttempt'],
  ['plan-transport-cap', 'auto_resume.rs', '        if attempt_count >= 1.0 || as_number', '        if attempt_count >= 2.0 || as_number', 'planAutoResumeAttempt'],
  ['plan-min-delay', 'auto_resume.rs', 'pub const AUTO_RESUME_MIN_DELAY_MS: f64 = 5_000.0;', 'pub const AUTO_RESUME_MIN_DELAY_MS: f64 = 5_001.0;', 'planAutoResumeAttempt'],
  ['plan-window-rejections', 'auto_resume.rs', '    if rejections > AUTO_RESUME_MAX_REJECTIONS_PER_WINDOW {', '    if rejections >= AUTO_RESUME_MAX_REJECTIONS_PER_WINDOW + 1.0 && rejections > 3.0 {', 'planAutoResumeAttempt'],
  ['plan-meridian', 'auto_resume.rs', '(provider_reset_at, Value::string("meridian_quota")),', '(provider_reset_at, Value::string("opencode_status")),', 'planAutoResumeAttempt'],
  ['plan-limited', 'auto_resume.rs', '!matches!(get(provider_reset, "limited"), Value::Bool(false))', 'truthy(get(provider_reset, "limited"))', 'planAutoResumeAttempt'],
  ['plan-breaker-source', 'auto_resume.rs', 'if matches!(source, Value::String(_)) { source.clone() } else { Value::Null }', 'source.clone()', 'planAutoResumeAttempt'],
  ['ack-key', 'auto_resume.rs', '        &units("auto-resume:"),', '        &units("auto-resume-"),', 'buildAutoResumeAcknowledgeParams'],
  ['ack-variant', 'auto_resume.rs', '    params.set("variant", nullish_or(get(target, "variant"), &NULL).clone());', '    params.set("variant", get(target, "variant").clone());', 'buildAutoResumeAcknowledgeParams'],
  ['ack-target', 'auto_resume.rs', '    if !truthy(state) || !truthy(get(state, "target")) {', '    if !truthy(state) {', 'buildAutoResumeAcknowledgeParams'],
  // native-job-proof-store.js
  ['shard-prime', 'proof_store.rs', 'hash = hash.wrapping_mul(0x0100_0193);', 'hash = hash.wrapping_mul(0x0100_0197);', 'managedNativeJobProofShard'],
  ['shard-offset', 'proof_store.rs', 'let mut hash: u32 = 0x811c_9dc5;', 'let mut hash: u32 = 0x811c_9dc4;', 'managedNativeJobProofShard'],
  ['shard-order', 'proof_store.rs', '        hash ^= u32::from(*unit);\n        hash = hash.wrapping_mul(0x0100_0193);', '        hash = hash.wrapping_mul(0x0100_0193);\n        hash ^= u32::from(*unit);', 'managedNativeJobProofShard'],
  ['shard-empty', 'proof_store.rs', 'let Some(text) = as_str(task_id).filter(|text| !text.is_empty()) else {', 'let Some(text) = as_str(task_id) else {', 'managedNativeJobProofShard'],
  ['shard-file-suffix', 'proof_store.rs', '&units(".json")', '&units(".jsonl")', 'managedNativeJobProofShardFile'],
  ['shard-file-check', 'proof_store.rs', 'pub fn managed_native_job_proof_shard_file(shard: &Value) -> JsResult<JsStr> {\n    if !is_managed_native_job_proof_shard(shard) {', 'pub fn managed_native_job_proof_shard_file(shard: &Value) -> JsResult<JsStr> {\n    if as_str(shard).is_none() {', 'managedNativeJobProofShardFile'],
  ['shard-file-prefix', 'proof_store.rs', 'Ok(concat(&[as_str(shard).expect("a shard").units(), &units(".json")]))', 'Ok(concat(&[&units("shard-"), as_str(shard).expect("a shard").units(), &units(".json")]))', 'managedNativeJobProofShardFile'],
  ['shard-names-count', 'proof_store.rs', 'as_str(value).is_some_and(|text| (0..MANAGED_NATIVE_JOB_PROOF_SHARD_COUNT).any(', 'as_str(value).is_some_and(|text| (0..MANAGED_NATIVE_JOB_PROOF_SHARD_COUNT - 1).any(', 'isManagedNativeJobProofShard'],
  ['shard-names-trim', 'proof_store.rs', 'as_str(value).is_some_and(|text| (0..MANAGED_NATIVE_JOB_PROOF_SHARD_COUNT).any(|index| *text == *shard_name(index)))', 'as_str(value).map(|text| JsStr::from_units(crate::text::trim(text.units()).to_vec())).is_some_and(|text| (0..MANAGED_NATIVE_JOB_PROOF_SHARD_COUNT).any(|index| text == *shard_name(index)))', 'isManagedNativeJobProofShard'],
  ['shard-names', 'proof_store.rs', '    format!("{index:02x}")', '    format!("{index:02X}")', 'isManagedNativeJobProofShard'],
  ['decode-shard-passthrough', 'proof_store.rs', '            return Err(Failure::Throw(error));', '            return Err(invalid("record"));', 'decodeManagedNativeJobProofShard'],
  ['decode-shard-proof', 'proof_store.rs', 'if !is_managed_native_job_tombstone(task)? || managed_native_job_proof_shard', 'if managed_native_job_proof_shard', 'decodeManagedNativeJobProofShard'],
  ['decode-shard-envelopes', 'proof_store.rs', '    if tasks.len() != envelopes.len() {\n        return Err(invalid("envelope"));', '    if tasks.len() < envelopes.len() {\n        return Err(invalid("envelope"));', 'decodeManagedNativeJobProofShard'],
  ['decode-shard-keys', 'proof_store.rs', 'const DOCUMENT_KEYS: [&str; 4] = ["version", "shard", "tasks", "resultEnvelopes"];', 'const DOCUMENT_KEYS: [&str; 4] = ["version", "shard", "tasks", "extra"];', 'decodeManagedNativeJobProofShard'],
  ['decode-proof-envelope', 'proof_store.rs', '        ("resultEnvelopes", Value::Array(vec![get(entry, "envelope").clone()])),', '        ("resultEnvelopes", Value::Array(Vec::new())),', 'decodeManagedNativeJobProof'],
  ['decode-proof-task', 'proof_store.rs', 'let shard = Value::string(&managed_native_job_proof_shard(get(get(entry, "task"), "taskId"))?);', 'let shard = Value::string(&managed_native_job_proof_shard(get(get(entry, "task"), "taskId")).unwrap_or_default());', 'decodeManagedNativeJobProof'],
  ['decode-proof-shard-name', 'proof_store.rs', '    let mut proofs = decode_managed_native_job_proof_shard(&document, &shard)?;', '    let mut proofs = decode_managed_native_job_proof_shard(&document, &Value::string("00"))?;', 'decodeManagedNativeJobProof'],
  ['encode-shard-sort', 'proof_store.rs', '        sorted.sort_by(|left, right| as_str(get(get(left, "task"), "taskId")).cmp(&as_str(get(get(right, "task"), "taskId"))));', '', 'encodeManagedNativeJobProofShard'],
  ['encode-shard-newline', 'proof_store.rs', '    let mut bytes = stringify_text(&document)?;\n    bytes.push(b\'\\n\');', '    let bytes = stringify_text(&document)?;', 'encodeManagedNativeJobProofShard'],
  ['encode-shard-envelope', 'proof_store.rs', ' || !strict_equal(get(get(entry, "envelope"), "taskId"), task_id)?', '', 'encodeManagedNativeJobProofShard'],
  ['encode-shard-message', 'proof_store.rs', 'format!("native job proof does not belong to shard {name}")', 'format!("native job proof is not in shard {name}")', 'encodeManagedNativeJobProofShard'],
]);

const NATIVE = path.join(REPOSITORY_ROOT, 'packages', 'native');
const CRATE = path.join(NATIVE, 'crates', 'scheduler-policy');

/** Each planting site must exist exactly once (a Rust-free check the contract runs too). */
export function plantingProblems(read = (file) => readFileSync(path.join(CRATE, 'src', file), 'utf8')) {
  const problems = [];
  for (const [id, file, find] of PLANTED_BUGS) {
    const count = read(file).split(find).length - 1;
    if (count !== 1) problems.push(`${id}: ${file} holds the planting site ${count} times`);
  }
  return problems;
}

function main() {
  const argv = process.argv.slice(2);
  const onlyAt = argv.indexOf('--only');
  const only = onlyAt >= 0 ? new Set(argv[onlyAt + 1].split(',')) : null;
  const shardAt = argv.indexOf('--shard');
  const [shardIndex, shardCount] = shardAt >= 0 ? argv[shardAt + 1].split('/').map(Number) : [0, 1];
  if (!(Number.isInteger(shardIndex) && Number.isInteger(shardCount) && shardIndex >= 0 && shardIndex < shardCount)) throw new Error('--shard takes <i>/<n> with 0 <= i < n');
  const problems = plantingProblems();
  if (problems.length) throw new Error(problems.join('\n'));
  const run = createRunRoot({ parent: scratchParent('qa'), prefix: `scheduler-policy-planted-${shardIndex}-`, owner: 'scheduler-policy-planted-bugs' });
  let status = 'failed';
  try {
    // The crate, the JavaScript layer and the ledger sources that layer
    // compiles by path, at the same relative places.
    const root = path.join(run.dir, 'repo');
    const workspace = path.join(root, 'packages', 'native');
    mkdirSync(path.join(workspace, 'crates'), { recursive: true });
    for (const file of ['Cargo.lock', 'rust-toolchain.toml']) cpSync(path.join(NATIVE, file), path.join(workspace, file));
    const manifest = readFileSync(path.join(NATIVE, 'Cargo.toml'), 'utf8').replace(/^members = \[[^\]]*\]/m, 'members = ["crates/js-layer", "crates/scheduler-policy"]');
    writeFileSync(path.join(workspace, 'Cargo.toml'), manifest);
    cpSync(path.join(NATIVE, 'crates', 'js-layer'), path.join(workspace, 'crates', 'js-layer'), { recursive: true });
    for (const source of ['ledger-core/src/js', 'ledger/ledger-native/src/js.rs']) {
      cpSync(path.join(REPOSITORY_ROOT, 'packages', 'harness-runtime', 'native', source), path.join(root, 'packages', 'harness-runtime', 'native', source), { recursive: true });
    }
    const copy = path.join(workspace, 'crates', 'scheduler-policy');
    cpSync(CRATE, copy, { recursive: true });
    const cargo = (args) => spawnSync('cargo', args, { cwd: workspace, encoding: 'utf8', env: { ...process.env, CARGO_TARGET_DIR: path.join(run.dir, 'target') } });
    const testArgs = ['test', '--offline', '--quiet', '-p', 'devryan-scheduler-policy', '--test', 'policy_vectors'];
    const baseline = cargo(testArgs);
    if (baseline.status !== 0) throw new Error(`the unmodified copy fails its vectors:\n${baseline.stdout}\n${baseline.stderr}`);
    const survivors = [];
    const byFunction = new Map();
    let ran = 0;
    for (const [index, [id, file, find, replacement, target]] of PLANTED_BUGS.entries()) {
      if ((only && !only.has(id)) || index % shardCount !== shardIndex) continue;
      ran += 1;
      const planted = path.join(copy, 'src', file);
      const original = readFileSync(planted, 'utf8');
      writeFileSync(planted, original.replace(find, replacement));
      const result = cargo(testArgs);
      writeFileSync(planted, original);
      const output = `${result.stdout}${result.stderr}`;
      if (/error\[E\d+\]|could not compile/.test(output)) throw new Error(`${id}: the planted copy does not build:\n${output.slice(0, 3000)}`);
      // A differing row or a panic both fail the vector suite.
      const caught = result.status !== 0 && /test result: FAILED/.test(output);
      const rows = /(\d+) of \d+ rows differ/.exec(output)?.[1] ?? '?';
      console.log(`${caught ? 'caught  ' : 'SURVIVED'} ${id} (${target})${caught ? `: ${rows} rows differ` : ''}`);
      const tally = byFunction.get(target) ?? { plants: 0, caught: 0 };
      tally.plants += 1;
      if (caught) tally.caught += 1;
      byFunction.set(target, tally);
      if (!caught) survivors.push(id);
    }
    console.log('\nfunction\tplants\tcaught');
    for (const [target, tally] of [...byFunction.entries()].sort()) console.log(`${target}\t${tally.plants}\t${tally.caught}`);
    if (survivors.length) throw new Error(`planted bugs the vectors miss: ${survivors.join(', ')}`);
    console.log(`Every planted bug is caught (${ran}).`);
    status = 'passed';
  } finally {
    run.finish(status);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { main(); } catch (error) { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; }
}
