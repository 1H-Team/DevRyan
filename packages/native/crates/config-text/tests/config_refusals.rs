//! A refusal (the crate hands the input back to JavaScript) is a different
//! type from what the package throws, in every public result, so a caller
//! never compares strings to tell them apart.

use devryan_config_text::value::{CYCLIC_VALUE, DEEP_VALUE, Graph, Val};
use devryan_config_text::{Refused, js, jsonc, yaml};

fn units(text: &str) -> Vec<u16> {
    js::units(text)
}

fn nested_brackets(depth: usize) -> Vec<u16> {
    units(&format!("{}{}", "[".repeat(depth), "]".repeat(depth)))
}

#[test]
fn jsonc_parse_refuses_deep_text() {
    assert_eq!(jsonc::parse(&nested_brackets(jsonc::MAX_DEPTH + 1)).err(), Some(jsonc::TOO_DEEP));
    assert!(jsonc::parse(&nested_brackets(jsonc::MAX_DEPTH)).is_ok());
}

#[test]
fn edits_keep_thrown_and_refused_apart() {
    let graph = Graph::new();
    let path = [units("a")];
    // The package throws: removing from an empty document.
    let thrown = jsonc::modify(&units(""), &path, &graph, &Val::Undefined, &units("\n"));
    assert_eq!(thrown, Err(jsonc::ModifyError::Thrown("Error: Can not delete in empty document".to_owned())));
    // The crate refuses: a text nested deeper than MAX_DEPTH, alone and in the server's sequences.
    let deep = nested_brackets(jsonc::MAX_DEPTH + 1);
    let refused = jsonc::ModifyError::Refused(jsonc::TOO_DEEP);
    assert_eq!(jsonc::modify(&deep, &path, &graph, &Val::Undefined, &units("\n")), Err(refused.clone()));
    assert_eq!(jsonc::remove_key_paths(&deep, &[path.to_vec()]), Err(refused.clone()));
    assert_eq!(jsonc::set_key_path(&deep, &path, &graph, &Val::Null), Err(refused));
}

#[test]
fn json_stringify_refuses_cycles_and_deep_values() {
    let mut graph = Graph::new();
    let cyclic = graph.from_description("{\"self\":*0}").expect("description");
    assert_eq!(graph.json_stringify(&cyclic), Err(CYCLIC_VALUE));
    let deep = graph
        .from_description(&format!("{}{}", "[".repeat(jsonc::MAX_DEPTH + 1), "]".repeat(jsonc::MAX_DEPTH + 1)))
        .expect("description");
    assert_eq!(graph.json_stringify(&deep), Err(DEEP_VALUE));
    let limit = graph
        .from_description(&format!("{}{}", "[".repeat(jsonc::MAX_DEPTH), "]".repeat(jsonc::MAX_DEPTH)))
        .expect("description");
    assert!(graph.json_stringify(&limit).is_ok());
    // A shared object that is not a cycle is written twice, as JavaScript does.
    let shared = graph.from_description("[{\"a\":#1},*1]").expect("description");
    assert_eq!(graph.json_stringify(&shared), Ok(Some(units("[{\"a\":1},{\"a\":1}]"))));
    // modify passes the refusal through as its own variant.
    let edit = jsonc::modify(&units("{}"), &[units("a")], &graph, &cyclic, &units("\n"));
    assert_eq!(edit, Err(jsonc::ModifyError::Refused(CYCLIC_VALUE)));
}

#[test]
fn yaml_parse_refusal_is_its_own_variant() {
    for source in ["%YAML 1.1\n---\na: yes\n", "a: !!binary aGk=\n", "? [a, b]\n: c\n"] {
        assert!(
            matches!(yaml::parse(&units(source)), yaml::Parsed::Refused(Refused(_))),
            "{source:?} is refused"
        );
    }
    let deep = format!("{}x{}", "[".repeat(yaml::MAX_DEPTH + 1), "]".repeat(yaml::MAX_DEPTH + 1));
    assert!(matches!(yaml::parse(&units(&deep)), yaml::Parsed::Refused(yaml::TOO_DEEP)));
    // What the package throws stays Thrown.
    assert!(matches!(
        yaml::parse(&units("a: 1\na: 2\n")),
        yaml::Parsed::Thrown { name: "YAMLParseError", .. }
    ));
}

#[test]
fn yaml_stringify_refuses_deep_values() {
    let mut graph = Graph::new();
    let deep = graph
        .from_description(&format!("{}{}", "[".repeat(yaml::MAX_DEPTH + 1), "]".repeat(yaml::MAX_DEPTH + 1)))
        .expect("description");
    assert_eq!(yaml::stringify(&graph, &deep), Err(yaml::TOO_DEEP));
    let cyclic = graph.from_description("{\"self\":*0}").expect("description");
    assert_eq!(yaml::stringify(&graph, &cyclic), Ok(Some(units("&a1\nself: *a1\n"))));
}

#[test]
fn descriptions_keep_raw_lone_surrogates() {
    let mut graph = Graph::new();
    let text = [0x22, 0xd800, 0x78, 0x22];
    assert_eq!(graph.from_description_units(&text), Ok(Val::String(vec![0xd800, 0x78])));
}
