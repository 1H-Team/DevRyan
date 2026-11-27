//! The Rust port of `legacyStorageMigration.ts`: `devRyanStorageKey` only. The two
//! `migrate*` exports call and write browser `Storage` objects and stay in TS.

#![forbid(unsafe_code)]

/// Port of `devRyanStorageKey` (`legacyStorageMigration.ts:10`): `/^openchamber(?=[._:-])/`
/// becomes `devryan`.
pub fn dev_ryan_storage_key(legacy_key: String) -> Result<String, String> {
    Ok(match legacy_key.strip_prefix("openchamber") {
        Some(rest) if rest.starts_with(['.', '_', ':', '-']) => format!("devryan{rest}"),
        _ => legacy_key,
    })
}
