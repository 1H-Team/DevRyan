//! The Rust port of `executionFailure.ts`. JS `\b` here is ASCII: a code matches where the
//! characters beside it are not `[A-Za-z0-9_]`.

#![forbid(unsafe_code)]

use serde_json::{Value, json};

const EXPLANATIONS: [(&str, &str); 16] = [
    (
        "local_execution_timeout",
        "The workspace was not ready before the startup deadline. Retry the subtask.",
    ),
    (
        "execution_preparation_stalled",
        "Workspace preparation stopped making progress. Retry the subtask.",
    ),
    (
        "workspace_changing",
        "Workspace files kept changing during preparation. Pause the writer and retry the subtask.",
    ),
    (
        "execution_artifacts_unavailable",
        "The verified execution runtime is missing or incompatible. Repair or update DevRyan, then restart the server.",
    ),
    (
        "execution_owner_termination_unconfirmed",
        "The previous execution host has not confirmed shutdown. Wait for recovery before retrying.",
    ),
    (
        "execution_owner_lost",
        "The execution host restarted while preparing this work. Retry the subtask.",
    ),
    ("execution_owner_unavailable", "The execution host is unavailable. Reconnect and retry."),
    (
        "payload_too_large",
        "This request exceeds the execution input limit. Reduce attached context or start a new task.",
    ),
    (
        "skill_source_mismatch",
        "The selected skill changed during preparation. Retry to load its current version.",
    ),
    (
        "native_skill_unreviewed",
        "The skill name or ID was not recognized. Retry using an exact available skill name.",
    ),
    (
        "storage_unavailable",
        "There is not enough available storage to prepare or save this work. Free space and retry.",
    ),
    (
        "mutation_runtime_missing",
        "The paired execution runtime is missing. Repair or update the installation before retrying.",
    ),
    (
        "mutation_runtime_unsupported",
        "This runtime cannot provide the required execution protection. Use a supported runtime.",
    ),
    ("session_retention_in_progress", "Session cleanup is in progress. Retry after it finishes."),
    (
        "mutation_history_captured",
        "This conversation's changes are owned by the DevRyan companion, which is unavailable. Restore it to Revert or Redo.",
    ), // recorded-literal: the source escapes its quote
    (
        "mutation_recovery_pending",
        "An interrupted Revert in this project is waiting for the DevRyan companion to finish recovery. Restore it before reverting.",
    ),
];

fn word(byte: u8) -> bool {
    byte.is_ascii_alphanumeric() || byte == b'_'
}

/// `/\b<code>\b/.test(value)` for an ASCII word `code`.
fn has_word(value: &str, code: &str) -> bool {
    let bytes = value.as_bytes();
    value.match_indices(code).any(|(at, _)| {
        let end = at + code.len();
        (at == 0 || !word(bytes[at - 1])) && bytes.get(end).is_none_or(|&b| !word(b))
    })
}

/// Port of `describeExecutionRecoveryFailure` (`executionFailure.ts:20`).
pub fn describe_execution_recovery_failure(value: String) -> Result<Option<Value>, String> {
    if !has_word(&value, "native_slim_retry_primary_fenced") && !has_word(&value, "execution_recovery_unavailable") {
        return Ok(None);
    }
    Ok(Some(json!({
        "code": "execution_recovery_unavailable",
        "message": "Automatic recovery could not verify this task's execution. Review the task and its recovery options before continuing.", // recorded-literal: the source escapes its quote
    })))
}

/// Port of `describeExecutionFailure` (`executionFailure.ts:29`).
pub fn describe_execution_failure(value: String) -> Result<Option<String>, String> {
    let Some((code, message)) = EXPLANATIONS.iter().find(|(code, _)| has_word(&value, code)) else {
        return Ok(None);
    };
    if value.contains("cleanup unconfirmed") {
        return Ok(Some(format!(
            "Execution could not start and cleanup is still unconfirmed. Wait for recovery before retrying. ({code})"
        )));
    }
    Ok(Some(format!("{message} ({code})")))
}
