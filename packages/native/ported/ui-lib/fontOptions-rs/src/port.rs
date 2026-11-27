//! The Rust port of `fontOptions.ts`: the two option guards (the rest is font data). Quirk kept:
//! `value in MAP` walks the prototype chain, so `Object.prototype` member names (`toString`,
//! `constructor`, `__proto__`, ...) are accepted as font options.

#![forbid(unsafe_code)]

use serde_json::Value;

const UI_FONTS: [&str; 10] = [
    "ibm-plex-sans",
    "inter",
    "geist-sans",
    "atkinson-hyperlegible",
    "source-sans-3",
    "roboto",
    "noto-sans",
    "dm-sans",
    "manrope",
    "system",
];
const MONO_FONTS: [&str; 10] = [
    "ibm-plex-mono",
    "jetbrains-mono",
    "fira-code",
    "geist-mono",
    "commit-mono",
    "source-code-pro",
    "cascadia-code",
    "roboto-mono",
    "iosevka",
    "system-mono",
];
/// The property names an ordinary object inherits from `Object.prototype`.
const OBJECT_PROTOTYPE: [&str; 12] = [
    "constructor",          // recorded-literal: an Object.prototype member name
    "__defineGetter__",     // recorded-literal: an Object.prototype member name
    "__defineSetter__",     // recorded-literal: an Object.prototype member name
    "hasOwnProperty",       // recorded-literal: an Object.prototype member name
    "__lookupGetter__",     // recorded-literal: an Object.prototype member name
    "__lookupSetter__",     // recorded-literal: an Object.prototype member name
    "isPrototypeOf",        // recorded-literal: an Object.prototype member name
    "propertyIsEnumerable", // recorded-literal: an Object.prototype member name
    "toString",             // recorded-literal: an Object.prototype member name
    "valueOf",              // recorded-literal: an Object.prototype member name
    "__proto__",            // recorded-literal: an Object.prototype member name
    "toLocaleString",       // recorded-literal: an Object.prototype member name
];

fn within(value: &Value, own: &[&str]) -> bool {
    value.as_str().is_some_and(|v| own.contains(&v) || OBJECT_PROTOTYPE.contains(&v))
}

/// Port of `isUiFontOption` (`fontOptions.ts:171`).
pub fn is_ui_font_option(value: Value) -> Result<bool, String> {
    Ok(within(&value, &UI_FONTS))
}

/// Port of `isMonoFontOption` (`fontOptions.ts:174`).
pub fn is_mono_font_option(value: Value) -> Result<bool, String> {
    Ok(within(&value, &MONO_FONTS))
}
