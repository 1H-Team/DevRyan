//! The codec against what the JavaScript half can send, and against what it
//! cannot (the C0i review's M4a): seeded random trees of every tag the
//! harness's codec writes (well-formed: rebuilt and written again, twice, the
//! same; malformed: refused, never a panic), hole counts at and past the
//! array bound (a length, never an allocation), and a step of each through
//! the runner. The well-formed trees the JavaScript codec itself writes are
//! round-tripped against it on every call of the client differential and the
//! tracked vectors (`args`, the arguments as the engine saw them).

use std::collections::HashMap;
use std::time::Instant;

use devryan_client_engine_runner::codec::{emit_slots, rebuild, snapshot};
use devryan_client_engine_runner::json::{Json, parse, write};
use devryan_client_engine_runner::serve;

struct Random(u64);

impl Random {
    fn next(&mut self) -> u64 {
        self.0 = self.0.wrapping_mul(6_364_136_223_846_793_005).wrapping_add(1_442_695_040_888_963_407);
        self.0 >> 33
    }
    fn below(&mut self, n: u64) -> u64 {
        self.next() % n
    }
}

const STRINGS: &[&str] = &[
    "",
    "a",
    "id",
    "__proto__",
    "0",
    "4294967294",
    "4294967295",
    "-0",
    "\u{2028}",
    "\\ud800",
    "😀",
    "$dr",
    "constructor",
];

/// A random tree: mostly what the codec writes, sometimes something it never writes.
fn tree(random: &mut Random, depth: u32, next_id: &mut i64, malformed: bool) -> String {
    let pick = random.below(if depth == 0 { 8 } else { 22 });
    let string = |random: &mut Random| format!("{:?}", STRINGS[random.below(STRINGS.len() as u64) as usize]).replace("\\\\u", "\\u");
    match pick {
        0 => "null".into(),
        1 => "true".into(),
        2 => ["0", "1.5", "-2", "1e21", "5e-324", "1.7976931348623157e308", "1000000000000042.2"][random.below(7) as usize].into(),
        3 => string(random),
        4 => r#"{"$dr":"undefined"}"#.into(),
        5 => format!(
            r#"{{"$dr":"number","value":"{}"}}"#,
            ["NaN", "Infinity", "-Infinity", "-0"][random.below(4) as usize]
        ),
        6 => r#"{"$dr":"date","value":1700000000000}"#.into(),
        7 => r#"{"$dr":"function","name":"f"}"#.into(),
        8..=10 => {
            let n = random.below(4);
            let mut items = Vec::new();
            for _ in 0..n {
                if random.below(5) == 0 {
                    let count =
                        [1u64, 2, 1000, 4_294_967_294, 4_294_967_295, 4_294_967_296, 1_000_000_000_000][random.below(if malformed { 7 } else { 3 }) as usize];
                    items.push(format!(r#"{{"$dr":"hole","n":{count}}}"#));
                } else {
                    items.push(tree(random, depth - 1, next_id, malformed));
                }
            }
            format!("[{}]", items.join(","))
        }
        11..=13 => {
            let n = random.below(4);
            let members: Vec<String> = (0..n)
                .map(|_| format!("{}:{}", string(random), tree(random, depth - 1, next_id, malformed)))
                .collect();
            let body = format!("{{{}}}", members.join(","));
            if body.contains("\"$dr\"") {
                format!(r#"{{"$dr":"escape","value":{body}}}"#)
            } else {
                body
            }
        }
        14 => format!(r#"{{"$dr":"nullproto","value":{{"a":{}}}}}"#, tree(random, depth - 1, next_id, malformed)),
        15 => format!(
            r#"{{"$dr":"map","entries":[[{},{}]]}}"#,
            tree(random, depth - 1, next_id, malformed),
            tree(random, depth - 1, next_id, malformed)
        ),
        16 => format!(r#"{{"$dr":"set","values":[{}]}}"#, tree(random, depth - 1, next_id, malformed)),
        17 => format!(
            r#"{{"$dr":"array","items":[{}],"props":{{"x":1}}}}"#,
            tree(random, depth - 1, next_id, malformed)
        ),
        18 => r#"{"$dr":"class","name":"TypeError","error":{"name":"TypeError","message":"m"},"value":{}}"#.into(),
        19 => {
            *next_id += 1;
            let id = *next_id;
            let inner = tree(random, depth - 1, next_id, malformed);
            format!(r#"{{"$dr":"id","n":{id},"value":{{"k":{inner}}}}}"#)
        }
        20 if malformed => [
            r#"{"$dr":"ref","n":99}"#,
            r#"{"$dr":"hole","n":-1}"#,
            r#"{"$dr":"map","entries":5}"#,
            r#"{"$dr":"zzz"}"#,
            r#"{"$dr":"id","n":1}"#,
            r#"{"$dr":"array","items":5}"#,
            r#"{"$dr":"date"}"#,
            r#"{"$dr":"set"}"#,
        ][random.below(8) as usize]
            .into(),
        _ => "1".into(),
    }
}

fn text_of(json: &Json) -> String {
    let mut out = Vec::new();
    write(json, &mut out);
    String::from_utf8(out).expect("UTF-8")
}

/// A tree rebuilt and written again (one slot, one scope).
fn round_trip(tree: &Json) -> Option<Json> {
    let value = rebuild(tree, &mut HashMap::new()).ok()?;
    let taken = snapshot(&value);
    Some(emit_slots(&[&taken]).remove(0))
}

#[test]
fn random_trees_rebuild_or_are_refused_and_written_again_stay_the_same() {
    let mut random = Random(20_261_126);
    let (mut rebuilt, mut refused) = (0, 0);
    for round in 0..4000 {
        let malformed = round % 3 == 0;
        let text = tree(&mut random, 4, &mut 0, malformed);
        let Ok(tree) = parse(text.as_bytes()) else { continue };
        let started = Instant::now();
        match round_trip(&tree) {
            Some(once) => {
                rebuilt += 1;
                let twice = round_trip(&once).unwrap_or_else(|| panic!("{text}: written {} and refused the second time", text_of(&once)));
                assert_eq!(text_of(&once), text_of(&twice), "{text}");
            }
            None => refused += 1,
        }
        // A hole count is a length: no tree of this size takes long, whatever its counts say.
        assert!(started.elapsed().as_secs() < 2, "{text} took {:?}", started.elapsed());
    }
    assert!(rebuilt > 1000 && refused > 100, "{rebuilt} rebuilt, {refused} refused");
}

#[test]
fn hole_counts_are_lengths_bounded_by_the_array_bound() {
    for (items, rebuilds) in [
        (r#"[{"$dr":"hole","n":4294967295}]"#, true),
        (r#"[1,{"$dr":"hole","n":4294967293},2]"#, true),
        (r#"[1,{"$dr":"hole","n":4294967294},2]"#, false),
        (r#"[{"$dr":"hole","n":4294967296}]"#, false),
        (r#"[{"$dr":"hole","n":1000000000000}]"#, false),
        (r#"[{"$dr":"hole","n":-1}]"#, false),
        (r#"[{"$dr":"hole","n":0}]"#, false),
        (r#"[{"$dr":"hole","n":1.5}]"#, false),
    ] {
        let started = Instant::now();
        let tree = parse(items.as_bytes()).expect("JSON");
        let written = round_trip(&tree);
        assert_eq!(written.is_some(), rebuilds, "{items}");
        if let Some(written) = written {
            assert_eq!(text_of(&written), items, "a sparse array is written back as it came");
        }
        assert!(started.elapsed().as_millis() < 500, "{items}: {:?}", started.elapsed());
    }
}

#[test]
fn a_step_on_a_huge_sparse_array_answers_without_visiting_its_holes() {
    // `getScopedMessageDiffTotals({ diffs })` iterates `diffs`: past the iteration limit that is a RangeError of the
    // engine's (no JavaScript engine visits 2^32 - 1 holes either), answered at once; `sanitize` keeps the holes.
    let open = r#"{"id":1,"op":"open","unit":1,"family":{"name":"session-diff-stats","entries":[],"injected":[],"ports":[]}}"#;
    let step = r#"{"id":3,"op":"step","unit":1,"step":{"input":{"kind":"call","entry":"getScopedMessageDiffTotals","args":[{"diffs":[{"$dr":"hole","n":4294967295}]}],"now":1},"env":[],"bind":[]}}"#;
    let input = format!("{open}\n{{\"id\":2,\"op\":\"case\",\"unit\":1}}\n{step}\n{{\"id\":4,\"op\":\"end\",\"unit\":1}}\n");
    let started = Instant::now();
    let mut output = Vec::new();
    serve(input.as_bytes(), &mut output).expect("serve");
    let text = String::from_utf8(output).expect("UTF-8");
    assert!(text.contains(r#""name":"RangeError""#), "{}", text.chars().take(600).collect::<String>());
    assert!(text.contains(r#"{"$dr":"hole","n":4294967295}"#), "the arguments are written back sparse");
    assert!(started.elapsed().as_secs() < 2, "{:?}", started.elapsed());
}
