//! The Rust port of `userSendAnimation.ts`: the module-level pending counts, per thread.

#![forbid(unsafe_code)]

use std::cell::RefCell;
use std::collections::HashMap;

thread_local! {
    static PENDING_COUNTS: RefCell<HashMap<String, f64>> = RefCell::new(HashMap::new());
}

fn count(session_id: &str) -> f64 {
    PENDING_COUNTS.with(|m| m.borrow().get(session_id).copied().unwrap_or(0.0))
}

/// Port of `markPendingUserSendAnimation` (`userSendAnimation.ts:12`).
pub fn mark_pending_user_send_animation(session_id: String) -> Result<(), String> {
    let next = count(&session_id) + 1.0;
    PENDING_COUNTS.with(|m| m.borrow_mut().insert(session_id, next));
    Ok(())
}

/// Port of `hasPendingUserSendAnimation` (`userSendAnimation.ts:17`).
pub fn has_pending_user_send_animation(session_id: String) -> Result<bool, String> {
    Ok(count(&session_id) > 0.0)
}

/// Port of `consumePendingUserSendAnimation` (`userSendAnimation.ts:25`).
pub fn consume_pending_user_send_animation(session_id: String) -> Result<bool, String> {
    let current = count(&session_id);
    if current <= 0.0 {
        return Ok(false);
    }
    PENDING_COUNTS.with(|m| {
        let mut map = m.borrow_mut();
        if current == 1.0 {
            map.remove(&session_id);
        } else {
            map.insert(session_id, current - 1.0);
        }
    });
    Ok(true)
}
