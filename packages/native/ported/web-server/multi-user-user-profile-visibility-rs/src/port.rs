//! The Rust port of `multi-user/user-profile-visibility.js`.

#![forbid(unsafe_code)]

use serde_json::{Value, json};

/// Port of `buildUserManagementProfileQuery` (`multi-user/user-profile-visibility.js:4`): a
/// non-admin reviewer never sees admin profiles.
pub fn build_user_management_profile_query(reviewer_role: Value) -> Result<Value, String> {
    let mut query = json!({ "order": "created_at.asc", "account_kind": "eq.human" });
    if reviewer_role.as_str() != Some("admin") {
        query["role"] = json!("neq.admin");
    }
    Ok(query)
}
