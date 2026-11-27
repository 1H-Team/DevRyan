//! The Rust port of `openInApps.ts`.

#![forbid(unsafe_code)]

use serde_json::{Value, json};

const OPEN_IN_APPS: [(&str, &str, &str); 23] = [
    ("finder", "Finder", "Finder"),
    ("terminal", "Terminal", "Terminal"),
    ("iterm2", "iTerm2", "iTerm"),
    ("ghostty", "Ghostty", "Ghostty"),
    ("vscode", "VS Code", "Visual Studio Code"),
    ("intellij", "IntelliJ", "IntelliJ IDEA"),
    ("visual-studio", "Visual Studio", "Visual Studio"),
    ("cursor", "Cursor", "Cursor"),
    ("android-studio", "Android Studio", "Android Studio"),
    ("pycharm", "PyCharm", "PyCharm"),
    ("xcode", "Xcode", "Xcode"),
    ("sublime-text", "Sublime", "Sublime Text"),
    ("webstorm", "WebStorm", "WebStorm"),
    ("rider", "Rider", "Rider"),
    ("zed", "Zed", "Zed"),
    ("phpstorm", "PhpStorm", "PhpStorm"),
    ("eclipse", "Eclipse", "Eclipse"),
    ("windsurf", "Windsurf", "Windsurf"),
    ("vscodium", "VSCodium", "VSCodium"),
    ("rustrover", "RustRover", "RustRover"),
    ("kiro", "Kiro", "Kiro"),
    ("antigravity", "Antigravity", "Antigravity"),
    ("trae", "Trae", "Trae"),
];

/// Port of `getOpenInAppById` (`openInApps.ts:37`).
pub fn get_open_in_app_by_id(id: Option<String>) -> Result<Option<Value>, String> {
    let Some(id) = id.filter(|id| !id.is_empty()) else { return Ok(None) };
    Ok(OPEN_IN_APPS
        .iter()
        .find(|(app_id, _, _)| *app_id == id)
        .map(|(id, label, app_name)| json!({ "id": id, "label": label, "appName": app_name })))
}
