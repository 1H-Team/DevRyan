//! The Rust port of `session-draft-storage.ts`: its four storage-key builders. Everything that
//! reads or writes browser `Storage`, takes callbacks or draws a random id stays in TypeScript.

#![forbid(unsafe_code)]

/// Port of `getDraftInputStorageKey` (`session-draft-storage.ts:44`).
pub fn get_draft_input_storage_key(draft_id: String) -> Result<String, String> {
    Ok(format!("devryan_chat_input_draft_draft_{draft_id}"))
}

/// Port of `getDraftConfirmedMentionsStorageKey` (`session-draft-storage.ts:47`).
pub fn get_draft_confirmed_mentions_storage_key(draft_id: String) -> Result<String, String> {
    Ok(format!("devryan_chat_confirmed_mentions_draft_{draft_id}"))
}

/// Port of `getSessionInputStorageKey` (`session-draft-storage.ts:50`).
pub fn get_session_input_storage_key(session_id: String) -> Result<String, String> {
    Ok(format!("devryan_chat_input_draft_{session_id}"))
}

/// Port of `getSessionConfirmedMentionsStorageKey` (`session-draft-storage.ts:53`).
pub fn get_session_confirmed_mentions_storage_key(session_id: String) -> Result<String, String> {
    Ok(format!("devryan_chat_confirmed_mentions_{session_id}"))
}
