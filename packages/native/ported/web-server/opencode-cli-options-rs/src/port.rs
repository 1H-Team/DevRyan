//! The Rust port of `opencode/cli-options.js` (`parseServeCliOptions`). `argv` and `env` are the
//! caller's values (nothing is read from the process). `parseInt(value, 10)` and `trim` are
//! written out over UTF-16 units; a non-string argument throws as `arg.startsWith` does in JS.

#![forbid(unsafe_code)]

use serde_json::{Map, Value};

use crate::js;

fn space(unit: u16) -> bool {
    matches!(unit, 0x09..=0x0d | 0x20 | 0xa0 | 0x1680 | 0x2000..=0x200a | 0x2028 | 0x2029 | 0x202f | 0x205f | 0x3000 | 0xfeff)
}

fn trim(u: &[u16]) -> &[u16] {
    let start = u.iter().position(|c| !space(*c)).unwrap_or(u.len());
    let end = u.iter().rposition(|c| !space(*c)).map_or(start, |i| i + 1);
    &u[start..end]
}

fn plain(value: &Value) -> Option<&Map<String, Value>> {
    value.as_object().filter(|o| !(o.len() == 1 && o.keys().all(|k| k.starts_with('$'))))
}

fn read(value: &Value, key: &str) -> Result<Value, String> {
    if value.is_null() || js::is_undefined(value) {
        let shown = if value.is_null() { "null" } else { "undefined" };
        return Err(format!("Cannot read properties of {shown} (reading '{key}')")); // recorded-literal: V8 TypeError text
    }
    Ok(plain(value).and_then(|o| o.get(key)).cloned().unwrap_or_else(js::undefined))
}

fn truthy(value: &Value) -> bool {
    match js::string_units(value) {
        Some(u) => !u.is_empty(),
        None => match value {
            Value::Null => false,
            Value::Bool(b) => *b,
            _ if js::is_undefined(value) => false,
            _ if value.get("$bigint").is_some_and(|b| b.as_str() == Some("0")) && value.as_object().is_some_and(|o| o.len() == 1) => false,
            _ => js::as_number(value).is_none_or(|n| n != 0.0 && !n.is_nan()),
        },
    }
}

fn or_else(value: Value, fallback: Value) -> Value {
    if truthy(&value) { value } else { fallback }
}

/// `parseInt(text, 10)`: leading white space, a sign, then the longest run of digits.
fn parse_int(text: &[u16]) -> f64 {
    let t = &text[text.iter().position(|c| !space(*c)).unwrap_or(text.len())..];
    let (negative, t) = match t.first() {
        Some(0x2d) => (true, &t[1..]),
        Some(0x2b) => (false, &t[1..]),
        _ => (false, t),
    };
    let digits: String = t
        .iter()
        .map_while(|c| u8::try_from(*c).ok().filter(u8::is_ascii_digit).map(char::from))
        .collect();
    let n = if digits.is_empty() {
        f64::NAN
    } else {
        digits.parse::<f64>().unwrap_or(f64::NAN)
    };
    if negative { -n } else { n }
}

fn starts_dashes(u: &[u16]) -> bool {
    u.starts_with(&[0x2d, 0x2d])
}

/// Port of `parseServeCliOptions` (`cli-options.js:1`).
pub fn parse_serve_cli_options(arg0: Value) -> Result<Value, String> {
    let given = |key: &str| -> Result<Value, String> { read(&arg0, key) };
    let argv = given("argv")?;
    let env = Some(given("env")?)
        .filter(|e| !js::is_undefined(e))
        .unwrap_or_else(|| Value::Object(Map::new()));
    let (default_port, cloudflare, managed) = (given("defaultPort")?, given("cloudflareProvider")?, given("managedLocalMode")?);
    let args: Vec<Value> = argv.as_array().cloned().unwrap_or_default();
    let e = |key: &str| read(&env, key);
    let password = or_else(or_else(e("DEVRYAN_UI_PASSWORD")?, e("OPENCODE_UI_PASSWORD")?), Value::Null);
    let cf = e("DEVRYAN_TRY_CF_TUNNEL")?.as_str() == Some("true");
    let provider = or_else(e("DEVRYAN_TUNNEL_PROVIDER")?, js::undefined());
    let mode = or_else(e("DEVRYAN_TUNNEL_MODE")?, js::undefined());
    let config = js::string_units(&e("DEVRYAN_TUNNEL_CONFIG")?).map_or_else(js::undefined, |c| {
        let t = trim(&c);
        if t.is_empty() { Value::Null } else { js::utf16_string(t) }
    });
    let token = or_else(e("DEVRYAN_TUNNEL_TOKEN")?, js::undefined());
    let hostname = or_else(e("DEVRYAN_TUNNEL_HOSTNAME")?, js::undefined());
    let mut options = Map::new();
    for (k, v) in [
        ("port", default_port.clone()),
        ("host", js::undefined()),
        ("uiPassword", password),
        ("tryCfTunnel", cf.into()),
        ("tunnelProvider", provider),
        ("tunnelMode", mode),
        ("tunnelConfigPath", config),
        ("tunnelToken", token),
        ("tunnelHostname", hostname),
    ] {
        options.insert(k.into(), v);
    }
    let mut i = 0;
    while i < args.len() {
        let Some(arg) = js::string_units(&args[i]) else {
            return Err("arg.startsWith is not a function".into()); // recorded-literal: V8 TypeError text
        };
        if !starts_dashes(&arg) {
            i += 1;
            continue;
        }
        let eq = arg.iter().position(|c| *c == 0x3d);
        let name = String::from_utf16_lossy(&arg[2..eq.unwrap_or(arg.len())]);
        let inline = eq.map(|e| arg[e + 1..].to_vec());
        // `consumeValue`: the inline value, else a following argument that is not an option.
        let mut consume = || -> Option<Vec<u16>> {
            if inline.is_some() {
                return inline.clone();
            }
            let next = args.get(i + 1).and_then(js::string_units).filter(|n| !starts_dashes(n))?;
            i += 1;
            Some(next)
        };
        let string_or = |v: Option<Vec<u16>>, fallback: Value| v.map_or(fallback, |u| js::utf16_string(&u));
        match name.as_str() {
            "port" | "p" => {
                let n = parse_int(&consume().unwrap_or_default());
                options.insert("port".into(), if n.is_finite() { js::number(n) } else { default_port.clone() });
            }
            "host" => {
                let host = consume().map(|v| trim(&v).to_vec()).filter(|t| !t.is_empty());
                options.insert("host".into(), string_or(host, js::undefined()));
            }
            "ui-password" => drop(options.insert("uiPassword".into(), string_or(consume(), "".into()))),
            "try-cf-tunnel" => drop(options.insert("tryCfTunnel".into(), true.into())),
            "tunnel-config" => drop(options.insert("tunnelConfigPath".into(), string_or(consume(), Value::Null))),
            "tunnel-provider" | "tunnel-mode" | "tunnel-token" | "tunnel-hostname" => {
                let key = match name.as_str() {
                    "tunnel-provider" => "tunnelProvider",
                    "tunnel-mode" => "tunnelMode",
                    "tunnel-token" => "tunnelToken",
                    _ => "tunnelHostname",
                };
                let value = consume();
                let current = options[key].clone();
                options.insert(key.into(), string_or(value, current));
            }
            "tunnel" => {
                let value = consume();
                options.insert("tunnelProvider".into(), cloudflare.clone());
                options.insert("tunnelMode".into(), managed.clone());
                options.insert("tunnelConfigPath".into(), string_or(value, Value::Null));
            }
            _ => {}
        }
        i += 1;
    }
    Ok(Value::Object(options))
}
