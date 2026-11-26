//! Engine protocol 5 on fixed requests: what the runner answers, byte for
//! byte where the answer is fixed, and what it refuses.

use devryan_client_engine_runner::json::{Json, parse};
use devryan_client_engine_runner::serve;

/// The answers to `requests` (one JSON text each), as parsed lines.
fn run(requests: &[&str]) -> Vec<String> {
    let input: String = requests.iter().map(|line| format!("{line}\n")).collect();
    let mut output = Vec::new();
    serve(input.as_bytes(), &mut output).expect("serve");
    String::from_utf8(output).expect("UTF-8").lines().map(str::to_owned).collect()
}

fn answer(line: &str) -> Json {
    parse(line.as_bytes()).expect("an answer is JSON")
}

const OPEN_STATUS: &str = r#"{"id":2,"op":"open","unit":1,"family":{"name":"tool-status","module":"/x/toolStatus.ts","state":null,"entries":[],"injected":[],"injectedNames":[],"wrapAnswers":["fetch"],"ports":[],"unordered":[]},"plants":[]}"#;

#[test]
fn hello_names_protocol_5_and_the_families_it_implements() {
    let lines = run(&[
        r#"{"id":1,"op":"hello","protocol":5}"#,
        r#"{"id":2,"op":"stop"}"#,
        r#"{"id":3,"op":"hello","protocol":5}"#,
    ]);
    assert_eq!(lines.len(), 2, "nothing is answered after stop");
    let hello = answer(&lines[0]);
    assert_eq!(hello.get("protocol"), Some(&Json::Number(5.0)));
    let families = hello.get("families").and_then(Json::as_array).expect("families");
    assert!(families.contains(&Json::str("tool-status")) && families.contains(&Json::str("optimistic")));
    assert!(!families.contains(&Json::str("reducer")));
    assert_eq!(lines[1], r#"{"id":2,"ok":true}"#);
}

#[test]
fn a_family_it_does_not_implement_is_refused_as_not_ported() {
    let lines = run(&[
        r#"{"id":1,"op":"open","unit":7,"family":{"name":"reducer","entries":[],"injected":[],"ports":[]}}"#,
        r#"{"id":2,"op":"case","unit":7}"#,
    ]);
    let refused = answer(&lines[0]);
    assert_eq!(refused.get("ok"), Some(&Json::Bool(false)));
    assert_eq!(refused.get("notPorted"), Some(&Json::Bool(true)));
    assert!(refused.text("error").unwrap().contains("family reducer is not ported to Rust"));
    assert!(answer(&lines[1]).text("error").unwrap().contains("unit 7 is not open"));
}

#[test]
fn a_descriptor_that_disagrees_with_the_port_is_refused() {
    let with_port = r#"{"id":1,"op":"open","unit":1,"family":{"name":"tool-status","entries":[],"injected":[],"ports":[{"module":"/x/debug.ts","export":"syncDebug","name":"module:x#syncDebug"}]}}"#;
    let with_store = r#"{"id":2,"op":"open","unit":2,"family":{"name":"tool-status","entries":[],"injected":[],"ports":[],"store":"useStore"}}"#;
    let with_plants =
        r#"{"id":3,"op":"open","unit":3,"family":{"name":"tool-status","entries":[],"injected":[],"ports":[]},"plants":[{"module":"/x","source":""}]}"#;
    let with_state =
        r#"{"id":4,"op":"open","unit":4,"family":{"name":"tool-status","entries":[],"injected":[],"ports":[],"moduleState":{"bindings":["cache"]}}}"#;
    let toy_without_port = r#"{"id":5,"op":"open","unit":5,"family":{"name":"toy-relay","entries":[],"injected":[],"ports":[]}}"#;
    let lines = run(&[with_port, with_store, with_plants, with_state, toy_without_port]);
    for (line, why) in lines.iter().zip([
        "port map and the port disagree",
        "a store",
        "planted copies of TypeScript",
        "the module state",
        "port map and the port disagree",
    ]) {
        let refused = answer(line);
        assert_eq!(refused.get("ok"), Some(&Json::Bool(false)));
        assert_eq!(refused.get("notPorted"), None, "a mismatch is no not-ported family");
        assert!(refused.text("error").unwrap().contains(why), "{line}");
    }
}

#[test]
fn held_calls_together_make_one_group_and_the_end_writes_one_identity_scope() {
    // The object the test hands in twice is the case's object 1 both times, brought in place to its new content; the
    // time record it gains is seen in two slots of the third step, so it is numbered too.
    let lines = run(&[
        OPEN_STATUS,
        r#"{"id":3,"op":"case","unit":1}"#,
        r#"{"id":4,"op":"step","unit":1,"step":{"input":{"kind":"call","entry":"normalizeToolStatus","args":[{"$dr":"id","n":1,"value":{"status":"running"}}],"now":1700000001000},"env":[],"bind":[],"entryBind":[],"hold":true}}"#,
        r#"{"id":5,"op":"step","unit":1,"step":{"input":{"kind":"call","entry":"normalizeToolStatus","args":[" In_Pro-gress\u2028"],"now":1700000001000,"together":true},"env":[],"bind":[]}}"#,
        r#"{"id":6,"op":"step","unit":1,"step":{"input":{"kind":"call","entry":"getToolLifecycleState","args":[{"$dr":"id","n":1,"value":{"status":"running","time":{"start":5,"end":{"$dr":"number","value":"-0"}}}}],"now":1700000002000},"env":[{"kind":"clock","source":"Date.now","value":1}],"bind":[]}}"#,
        r#"{"id":7,"op":"end","unit":1}"#,
        r#"{"id":8,"op":"close","unit":1}"#,
    ]);
    assert_eq!(lines[2], r#"{"id":4,"ok":true,"halted":null,"held":true}"#);
    assert_eq!(lines[3], r#"{"id":5,"ok":true,"halted":null}"#);
    let steps = r#"[{"n":1,"input":{"kind":"call","entry":"normalizeToolStatus","now":1700000001000,"args":[{"$dr":"id","n":1,"value":{"status":"running"}}]},"group":1,"openedAt":0,"returnedAt":0,"returns":{"$dr":"undefined"},"after":[{"$dr":"id","n":1,"value":{"status":"running"}}]},{"n":2,"input":{"kind":"call","entry":"normalizeToolStatus","now":1700000001000,"args":[" In_Pro-gress\u2028"]},"group":1,"openedAt":0,"returnedAt":0,"returns":"inprogress","after":[" In_Pro-gress\u2028"]},{"n":3,"input":{"kind":"call","entry":"getToolLifecycleState","now":1700000002000,"args":[{"$dr":"id","n":1,"value":{"status":"running","time":{"$dr":"id","n":2,"value":{"start":5,"end":{"$dr":"number","value":"-0"}}}}}]},"group":2,"openedAt":0,"returnedAt":0,"returns":{"status":"running","start":5,"end":{"$dr":"undefined"},"hasStarted":true,"hasEnded":false,"isStatusActive":true,"isStatusFinal":false,"isInFlight":true,"isFinalized":false},"after":[{"$dr":"id","n":1,"value":{"status":"running","time":{"$dr":"id","n":2,"value":{"start":5,"end":{"$dr":"number","value":"-0"}}}}}]}]"#;
    let expected = format!(
        r#"{{"id":7,"ok":true,"replayed":{{"steps":{steps},"groups":[{{"effects":[]}},{{"effects":[]}}],"pending":[],"strings":[],"halt":null,"outside":[],"bindFailures":[],"flags":[]}}}}"#
    );
    assert_eq!(lines[5], expected);
    assert_eq!(lines[6], r#"{"id":8,"ok":true,"between":[]}"#);
}

#[test]
fn a_draft_entry_reports_its_change_set_and_binds_name_objects_by_slot_and_path() {
    let open = r#"{"id":1,"op":"open","unit":1,"family":{"name":"optimistic","entries":[{"export":"applyOptimisticAdd","draft":0},{"export":"applyOptimisticRemove","draft":0}],"injected":[],"ports":[]}}"#;
    let draft = r#"{"$dr":"id","n":1,"value":{"message":{"s":[{"id":"m1","time":{"created":1}}]},"part":{}}}"#;
    let add = format!(
        r#"{{"id":3,"op":"step","unit":1,"step":{{"input":{{"kind":"call","entry":"applyOptimisticAdd","args":[{draft},{{"sessionID":"s","message":{{"id":"m0","time":{{"created":0}}}},"parts":[{{"id":"p"}},null]}}],"now":1}},"env":[],"bind":[{{"slot":"after","path":[0,"part","m0"],"n":9}},{{"slot":"after","path":[0,"nothing"],"n":10}}]}}}}"#
    );
    let lines = run(&[open, r#"{"id":2,"op":"case","unit":1}"#, &add, r#"{"id":4,"op":"end","unit":1}"#]);
    let replayed = answer(&lines[3]);
    let step = &replayed.get("replayed").and_then(|value| value.get("steps")).and_then(Json::as_array).unwrap()[0];
    let mut written = Vec::new();
    devryan_client_engine_runner::json::write(step.get("changes").unwrap(), &mut written);
    // The list changed in place (its members moved), the part list is new: the array itself keeps its path and identity.
    assert_eq!(
        String::from_utf8(written).unwrap(),
        r#"[["message","s",0],["message","s",0,"time"],["message","s",1],["message","s",1,"time"],["part","m0"],["part","m0",0]]"#
    );
    let failures = replayed
        .get("replayed")
        .and_then(|value| value.get("bindFailures"))
        .and_then(Json::as_array)
        .unwrap();
    assert_eq!(failures.len(), 1, "the path to nothing is a bind failure, the other binds");
    assert_eq!(failures[0].get("path"), Some(&Json::Array(vec![Json::Number(0.0), Json::str("nothing")])));
}

#[test]
fn what_no_ported_family_takes_halts_the_case_unplaced() {
    for input in [
        r#"{"kind":"timer","id":1,"now":1}"#,
        r#"{"kind":"settle","port":"p","call":1,"outcome":"fulfilled","value":null,"now":1}"#,
        r#"{"kind":"new","entry":"normalizeToolStatus","args":[],"now":1}"#,
        r#"{"kind":"call","entry":"noSuchExport","args":[],"now":1}"#,
    ] {
        let step = format!(r#"{{"id":3,"op":"step","unit":1,"step":{{"input":{input},"env":[],"bind":[]}}}}"#);
        let lines = run(&[
            OPEN_STATUS,
            r#"{"id":2,"op":"case","unit":1}"#,
            &step,
            r#"{"id":4,"op":"step","unit":1,"step":{"input":{"kind":"call","entry":"normalizeToolStatus","args":["x"],"now":1},"env":[],"bind":[]}}"#,
        ]);
        let halted = answer(&lines[2]);
        assert_eq!(halted.get("halted").and_then(|halt| halt.text("check")).as_deref(), Some("unplaced"), "{input}");
        assert_eq!(answer(&lines[3]).get("skipped"), Some(&Json::Bool(true)), "a halted case takes no further step");
    }
    let nested = r#"{"id":3,"op":"step","unit":1,"step":{"input":{"kind":"call","entry":"normalizeToolStatus","args":["x"],"now":1},"env":[],"bind":[],"during":[{"call":1,"step":{"input":{"kind":"call","entry":"normalizeToolStatus","args":["y"],"now":1},"env":[],"bind":[]}}]}}"#;
    let lines = run(&[OPEN_STATUS, r#"{"id":2,"op":"case","unit":1}"#, nested]);
    assert!(
        answer(&lines[2])
            .get("halted")
            .and_then(|halt| halt.text("detail"))
            .unwrap()
            .contains("nested in a port call")
    );
    let lines = run(&[OPEN_STATUS, r#"{"id":2,"op":"case","unit":1}"#, r#"{"id":3,"op":"seed","unit":1,"state":{}}"#]);
    assert!(answer(&lines[2]).text("error").unwrap().contains("seeds no state"));
}

#[test]
fn long_strings_come_and_go_through_the_string_tables() {
    let long: String = "ab".repeat(600);
    let step = format!(
        r#"{{"id":3,"op":"step","unit":1,"step":{{"input":{{"kind":"call","entry":"normalizeToolStatus","args":[{{"$dr":"slice","s":0}}],"now":1}},"env":[],"bind":[],"strings":["{}"]}}}}"#,
        long.to_uppercase()
    );
    let lines = run(&[OPEN_STATUS, r#"{"id":2,"op":"case","unit":1}"#, &step, r#"{"id":4,"op":"end","unit":1}"#]);
    let replayed = answer(&lines[3]);
    let replayed = replayed.get("replayed").unwrap();
    let strings = replayed.get("strings").and_then(Json::as_array).unwrap();
    assert_eq!(strings, &[Json::str(&long.to_uppercase()), Json::str(&long)]);
    let step = &replayed.get("steps").and_then(Json::as_array).unwrap()[0];
    assert_eq!(
        step.get("returns"),
        Some(&Json::object(vec![("$dr", Json::str("slice")), ("s", Json::Number(1.0))]))
    );
    let bad = r#"{"id":3,"op":"step","unit":1,"step":{"input":{"kind":"call","entry":"normalizeToolStatus","args":[{"$dr":"slice","s":4}],"now":1},"env":[],"bind":[]}}"#;
    let lines = run(&[OPEN_STATUS, r#"{"id":2,"op":"case","unit":1}"#, bad]);
    assert!(answer(&lines[2]).text("error").unwrap().contains("string 4 of a table of 0"));
}

#[test]
fn an_engine_written_error_keeps_its_class_and_writes_this_engine_s_own_text() {
    let open = r#"{"id":1,"op":"open","unit":1,"family":{"name":"session-diff-stats","entries":[],"injected":[],"ports":[]}}"#;
    let step = r#"{"id":3,"op":"step","unit":1,"step":{"input":{"kind":"call","entry":"getScopedMessageDiffTotals","args":[{"diffs":[null]}],"now":1},"env":[],"bind":[]}}"#;
    let lines = run(&[open, r#"{"id":2,"op":"case","unit":1}"#, step, r#"{"id":4,"op":"end","unit":1}"#]);
    let replayed = answer(&lines[3]);
    let step = &replayed.get("replayed").and_then(|value| value.get("steps")).and_then(Json::as_array).unwrap()[0];
    let mut written = Vec::new();
    devryan_client_engine_runner::json::write(step.get("throws").unwrap(), &mut written);
    assert_eq!(
        String::from_utf8(written).unwrap(),
        r#"{"$dr":"class","name":"TypeError","error":{"name":"TypeError","message":"client-engine: null has no members (diff.additions)"},"value":{}}"#
    );
}

#[test]
fn a_line_that_is_no_json_is_answered_with_an_error_and_the_runner_goes_on() {
    let lines = run(&["{not json", r#"{"id":2,"op":"hello","protocol":5}"#, r#"{"id":3,"op":"frobnicate"}"#]);
    assert!(answer(&lines[0]).text("error").unwrap().starts_with("not JSON"));
    assert_eq!(answer(&lines[1]).get("ok"), Some(&Json::Bool(true)));
    assert!(answer(&lines[2]).text("error").unwrap().contains("unknown request frobnicate"));
}

const OPEN_RELAY: &str = r#"{"id":1,"op":"open","unit":1,"family":{"name":"toy-relay","entries":[{"export":"stamp","draft":0}],"injected":[],"ports":[{"module":"/x/toy-log.mjs","export":"log","name":"module:toy-log.mjs#log"}]},"plants":[]}"#;

#[test]
fn a_port_call_is_an_effect_of_its_group_answered_from_the_env_and_a_continuation_comes_after_the_return() {
    // `note` calls the port before it returns; `relay` calls it in a job after it returns (returnedAt counts it out).
    let note = r#"{"id":3,"op":"step","unit":1,"step":{"input":{"kind":"call","entry":"note","args":["abc"],"now":5},"env":[{"kind":"clock","source":"Date.now","value":5},{"kind":"port","port":"module:toy-log.mjs#log","call":1,"answer":"note:abc"}],"bind":[]}}"#;
    let relay = r#"{"id":4,"op":"step","unit":1,"step":{"input":{"kind":"call","entry":"relay","args":[[1,2]],"now":6},"env":[{"kind":"port","port":"module:toy-log.mjs#log","call":2,"answer":"relay:2"}],"bind":[]}}"#;
    let lines = run(&[OPEN_RELAY, r#"{"id":2,"op":"case","unit":1}"#, note, relay, r#"{"id":5,"op":"end","unit":1}"#]);
    let replayed = answer(&lines[4]);
    let replayed = replayed.get("replayed").expect("replayed");
    assert_eq!(replayed.get("halt"), Some(&Json::Null), "{}", lines[4]);
    let groups = replayed.get("groups").and_then(Json::as_array).expect("groups");
    let effect = &groups[0].get("effects").and_then(Json::as_array).expect("effects")[0];
    assert_eq!(effect.text("kind").as_deref(), Some("port"));
    assert_eq!(effect.text("port").as_deref(), Some("module:toy-log.mjs#log"));
    assert_eq!(effect.get("answer"), Some(&Json::str("note:abc")));
    let steps = replayed.get("steps").and_then(Json::as_array).expect("steps");
    assert_eq!(steps[0].get("returnedAt"), Some(&Json::Number(1.0)), "note's call is before its return");
    assert_eq!(steps[1].get("returnedAt"), Some(&Json::Number(0.0)), "relay's call is after its return");
    assert_eq!(groups[1].get("effects").and_then(Json::as_array).map(<[Json]>::len), Some(1));
}

#[test]
fn a_port_call_the_env_holds_later_or_not_at_all_halts_the_case() {
    // pair calls `log` twice; the env holds a draw first (effect-order), or nothing (unanswered).
    let later = r#"{"id":3,"op":"step","unit":1,"step":{"input":{"kind":"call","entry":"pair","args":["x","y"],"now":1},"env":[{"kind":"draw","source":"crypto.randomUUID","value":"u"},{"kind":"port","port":"module:toy-log.mjs#log","call":1,"answer":"first:x"}],"bind":[]}}"#;
    let none = r#"{"id":3,"op":"step","unit":1,"step":{"input":{"kind":"call","entry":"note","args":["x"],"now":1},"env":[],"bind":[]}}"#;
    for (step, check) in [(later, "effect-order"), (none, "unanswered")] {
        let lines = run(&[OPEN_RELAY, r#"{"id":2,"op":"case","unit":1}"#, step]);
        let halted = answer(&lines[2]);
        assert_eq!(halted.get("halted").and_then(|halt| halt.text("check")).as_deref(), Some(check), "{}", lines[2]);
    }
}

#[test]
fn module_state_lives_as_long_as_the_unit() {
    let tally = |id: u32, name: &str| {
        format!(r#"{{"id":{id},"op":"step","unit":1,"step":{{"input":{{"kind":"call","entry":"tally","args":["{name}"],"now":1}},"env":[],"bind":[]}}}}"#)
    };
    let (first, second) = (tally(3, "a"), tally(6, "b"));
    let lines = run(&[
        OPEN_RELAY,
        r#"{"id":2,"op":"case","unit":1}"#,
        &first,
        r#"{"id":4,"op":"end","unit":1}"#,
        r#"{"id":5,"op":"case","unit":1}"#,
        &second,
        r#"{"id":7,"op":"end","unit":1}"#,
    ]);
    let returned = |line: &str| {
        answer(line)
            .get("replayed")
            .and_then(|value| value.get("steps"))
            .and_then(Json::as_array)
            .unwrap()[0]
            .get("returns")
            .cloned()
    };
    assert_eq!(returned(&lines[3]), Some(Json::str("a:1")));
    assert_eq!(
        returned(&lines[6]),
        Some(Json::str("b:2")),
        "the second case of the unit sees the first's count"
    );
}
