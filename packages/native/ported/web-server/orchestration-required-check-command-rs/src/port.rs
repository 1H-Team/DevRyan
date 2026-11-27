//! The Rust port of `orchestration/required-check-command.js`: the same argv lexer over UTF-16
//! units (`&&` chains only; quotes, backslash escapes, and every other shell operator refused).
//! `path.basename` is the POSIX one (the server's platform).

#![forbid(unsafe_code)]

use serde_json::Value;

use crate::js;

const AMBIGUOUS: &str = "required_check_command_exit_ambiguous";
const SHELLS: [&str; 14] = [
    "sh",
    "bash",
    "zsh",
    "dash",
    "ksh",
    "fish",
    "csh",
    "tcsh",
    "cmd",
    "cmd.exe",
    "powershell",
    "powershell.exe",
    "pwsh",
    "pwsh.exe",
];
const CONTROL: [&str; 25] = [
    "if", "then", "else", "elif", "fi", "for", "while", "until", "do", "done", "case", "esac", "select", "function", "eval", "source", ".", "return", "exit",
    "exec", "trap", "alias", "builtin", "command", "coproc",
];

fn js_space(u: u16) -> bool {
    matches!(u, 0x09..=0x0d | 0x20 | 0xa0 | 0x1680 | 0x2000..=0x200a | 0x2028 | 0x2029 | 0x202f | 0x205f | 0x3000 | 0xfeff)
}

fn ambiguous() -> Result<Value, String> {
    Ok(Value::String(AMBIGUOUS.into()))
}

/// POSIX `path.basename`.
fn basename(path: &str) -> &str {
    path.trim_end_matches('/').rsplit('/').next().unwrap_or("")
}

/// `/^[A-Za-z_][A-Za-z0-9_]*=/`.
fn is_assignment(word: &str) -> bool {
    let b = word.as_bytes();
    let Some(first) = b.first() else { return false };
    if !(first.is_ascii_alphabetic() || *first == b'_') {
        return false;
    }
    let rest = b[1..].iter().take_while(|c| c.is_ascii_alphanumeric() || **c == b'_').count();
    b.get(1 + rest) == Some(&b'=')
}

/// Port of `requiredCheckCommandIssue` (`orchestration/required-check-command.js:10`).
pub fn required_check_command_issue(command: Value) -> Result<Value, String> {
    let Some(s) = js::string_units(&command) else { return ambiguous() };
    if s.iter().all(|u| js_space(*u)) || s.iter().any(|u| matches!(u, 0x0d | 0x0a | 0x00)) {
        return ambiguous();
    }
    let unit = |c: char| c as u16;
    let mut commands: Vec<Vec<Vec<u16>>> = Vec::new();
    let mut words: Vec<Vec<u16>> = Vec::new();
    let mut word: Vec<u16> = Vec::new();
    let mut quote: Option<u16> = None;
    let mut started = false;
    let finish_word = |words: &mut Vec<Vec<u16>>, word: &mut Vec<u16>, started: &mut bool| {
        if *started {
            words.push(std::mem::take(word));
        }
        word.clear();
        *started = false;
    };
    let mut i = 0;
    while i < s.len() {
        let c = s[i];
        if quote == Some(unit('\'')) {
            if c == unit('\'') {
                quote = None;
            } else {
                word.push(c);
            }
            i += 1;
            continue;
        }
        if c == unit('\\') {
            i += 1;
            if i == s.len() {
                return ambiguous();
            }
            if quote == Some(unit('"')) && ![unit('$'), unit('`'), unit('"'), unit('\\')].contains(&s[i]) {
                word.push(unit('\\'));
            }
            word.push(s[i]);
            started = true;
            i += 1;
            continue;
        }
        if c == unit('$') || c == unit('`') {
            return ambiguous();
        }
        if quote == Some(unit('"')) {
            if c == unit('"') {
                quote = None;
            } else {
                word.push(c);
            }
            i += 1;
            continue;
        }
        if c == unit('\'') || c == unit('"') {
            quote = Some(c);
            started = true;
            i += 1;
            continue;
        }
        if js_space(c) {
            finish_word(&mut words, &mut word, &mut started);
            i += 1;
            continue;
        }
        if c == unit('&') && s.get(i + 1) == Some(&unit('&')) {
            finish_word(&mut words, &mut word, &mut started);
            if words.is_empty() {
                return ambiguous();
            }
            commands.push(std::mem::take(&mut words));
            i += 2;
            continue;
        }
        if ";|&<>(){}!#".encode_utf16().any(|o| o == c) {
            return ambiguous();
        }
        word.push(c);
        started = true;
        i += 1;
    }
    if quote.is_some() {
        return ambiguous();
    }
    finish_word(&mut words, &mut word, &mut started);
    if words.is_empty() {
        return ambiguous();
    }
    commands.push(words);
    for argv in commands {
        let argv: Vec<String> = argv.iter().map(|w| String::from_utf16_lossy(w)).collect();
        let Some(executable) = argv.iter().position(|v| !is_assignment(v)) else {
            return ambiguous();
        };
        let exe = &argv[executable];
        if exe.is_empty() || CONTROL.contains(&exe.as_str()) {
            return ambiguous();
        }
        if basename(exe) == "env" && argv[executable + 1..].iter().any(|v| v == "-S" || v.starts_with("--split-string")) {
            return ambiguous();
        }
        if argv[executable..].iter().any(|v| SHELLS.contains(&basename(v).to_lowercase().as_str())) {
            return ambiguous();
        }
    }
    Ok(Value::Null)
}
