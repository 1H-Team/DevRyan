//! Engine protocol 5 (scripts/client-conformance/engine.mjs; docs/TESTING.md,
//! "What package C0i's runner must implement"), for the families
//! `devryan-client-engine` implements. One request per line in, one answer
//! per line out, each with its request's `id`.
//!
//! What it implements: `hello` (protocol 5, and the families it runs),
//! `open` (a family it implements, checked against the port map's
//! descriptor; any other is refused as not ported, `notPorted: true`),
//! `case`, `step` (held deliveries, `together` members, groups cut as the
//! checklist says, each step's `group`, `openedAt` and `returnedAt`, the
//! group's one effect list, binds of the step's own slots, the arguments
//! after the call and a draft's change set), `end` (every value slot of the
//! case in one identity scope, long strings in a string table), `close` and
//! `stop`. A family is called with a context (`devryan_client_engine::ctx`):
//! its port calls and draws are effects of the group, in the order made,
//! answered from the group's one env list (the concatenation of its
//! top-level steps' envs; the next item of that kind and name, a port the
//! family lists as unordered from any later item; anything else halts
//! `effect-order` or `unanswered`); clock items are passed over (the family
//! is handed the step's `now`); binds of effect slots (`effects.<i>.args`)
//! name the group's i-th effect; continuations run once every member of the
//! delivery that came `together` was delivered, in the order queued, and what
//! they throw is the case's `outside`. A unit keeps its family instance (its
//! module state) from case to case, as a module does in file order.
//!
//! What it refuses, loudly: a family it does not implement (`open`), a
//! family whose descriptor gives it other ports than its Rust port calls,
//! injected ports, a store, other module state, a planted TypeScript copy or
//! load-time port data (`open` fails), a `seed`, a promise as a port's answer,
//! and any input but a call of an export: a `new`, a `get`, a timer firing, a
//! settle, a callback, an input nested in a port call (the step halts
//! `unplaced`, which the replayer counts as inconclusive, never as
//! reproduced).

use std::collections::{HashMap, HashSet};

use devryan_client_engine::ctx::{Ctx, Halted, Host, Jobs, Quiet};
use devryan_client_engine::families::{FAMILIES, Family, Instance, family};
use devryan_client_engine::js::{Js, Obj, Str, Value};
use devryan_client_engine::toys::TOYS;

use crate::codec::{Snapshot, at_path, changed_paths, emit_slots, identity_paths, paths_value, rebuild, snapshot};
use crate::json::Json;

pub const PROTOCOL: f64 = 5.0;
/// From this length (UTF-16 units) a string travels once per case in a string table (engine.mjs LONG_STRING).
const LONG_STRING: usize = 1024;

/// An answer: `Ok` members, or a failure (`error`, and `notPorted` for a family the engine does not implement).
pub enum Answer {
    Ok(Vec<(&'static str, Json)>),
    Fail { error: String, not_ported: bool },
}

fn fail(error: impl Into<String>) -> Answer {
    Answer::Fail {
        error: error.into(),
        not_ported: false,
    }
}

/// The halt of a case: the engine's step count, the check, why.
#[derive(Clone)]
struct Halt {
    step: Option<u32>,
    check: &'static str,
    detail: String,
}

impl Halt {
    fn json(&self) -> Json {
        Json::object(vec![
            ("step", self.step.map_or(Json::Null, |n| Json::Number(f64::from(n)))),
            ("check", Json::str(self.check)),
            ("detail", Json::String(self.detail.encode_utf16().collect::<Vec<u16>>().into())),
        ])
    }
}

/// A step of the case as the engine reports it.
struct Record {
    n: u32,
    echo: Vec<(&'static str, Json)>,
    given: Json,
    /// The answers the step's env holds for its effects and those of its nested inputs.
    env: Vec<Json>,
    bind: Vec<Json>,
    together: bool,
    /// The step carries inputs the test made inside its port calls (`during`).
    nested: bool,
    group: Option<usize>,
    opened_at: Option<usize>,
    returned_at: Option<usize>,
    /// Value slots taken: `args`, then `returns` or `throws`, `after`, `changes` (the end writes them in this order).
    args: Option<Snapshot>,
    returns: Option<Snapshot>,
    throws: Option<Snapshot>,
    after: Option<Snapshot>,
    changes: Option<Snapshot>,
}

/// One observable of a group, its values taken when it was made.
struct Effect {
    kind: &'static str,
    /// `port` (a port call) or `source` (a draw), and its name.
    name_key: &'static str,
    name: Str,
    call: Option<u32>,
    args: Option<Snapshot>,
    answer: Option<Snapshot>,
    throws: Option<Snapshot>,
    value: Option<Snapshot>,
}

struct Group {
    /// Everything observable made in the group, in order.
    effects: Vec<Effect>,
    /// The answers: the group's top-level steps' envs, in order, and which of them were taken.
    env: Vec<Json>,
    env_next: usize,
    used: HashSet<usize>,
    /// The bind lists of the group's steps, pooled (binds of effect slots name the group's effects).
    binds: Vec<Json>,
}

struct Case {
    bound: HashMap<i64, Obj>,
    strings: Vec<Str>,
    records: Vec<Record>,
    held: Vec<usize>,
    groups: Vec<Group>,
    next_n: u32,
    halt: Option<Halt>,
    bind_failures: Vec<Json>,
    /// The case's port calls, counted as they are made.
    port_calls: u32,
    /// What was made while no step of the case was open (what a continuation threw, uncaught).
    outside: Vec<Json>,
}

struct Unit {
    family: &'static Family,
    /// The family's module instance: its module state lives as long as the unit.
    instance: Box<dyn Instance>,
    /// The exports the port map says take a draft (an argument changed in place), with its index.
    drafts: HashMap<String, usize>,
    /// The port map's name of each module port the family calls, by export.
    port_names: HashMap<String, Str>,
    /// Ports whose answers may be taken out of order (the family's `unordered` waivers).
    unordered: HashSet<String>,
    case: Option<Case>,
}

#[derive(Default)]
pub struct Runner {
    units: HashMap<i64, Unit>,
}

/// The engine's name and the families it implements, as `hello` reports them.
pub fn implemented() -> Vec<&'static str> {
    FAMILIES.iter().chain(TOYS).map(|family| family.name).collect()
}

impl Runner {
    /// Handles one request; `true` as the second value when the process must stop after answering.
    pub fn handle(&mut self, request: &Json) -> (Answer, bool) {
        let op = request.text("op").unwrap_or_default();
        let unit = request.integer("unit");
        let answer = match op.as_str() {
            "hello" => Answer::Ok(vec![
                ("engine", Json::str("rust")),
                ("protocol", Json::Number(PROTOCOL)),
                ("families", Json::Array(implemented().into_iter().map(Json::str).collect())),
            ]),
            "stop" => return (Answer::Ok(Vec::new()), true),
            "open" => match unit {
                Some(unit) => self.open(unit, request),
                None => fail("open needs a unit"),
            },
            "case" | "seed" | "step" | "end" | "close" => match unit {
                Some(id) if self.units.contains_key(&id) => match op.as_str() {
                    "case" => self.open_case(id),
                    "seed" => fail("the Rust runner seeds no state: no family it implements is stateful"),
                    "step" => self.step(id, request.get("step").unwrap_or(&Json::Null)),
                    "end" => self.end(id),
                    _ => {
                        self.units.remove(&id);
                        Answer::Ok(vec![("between", Json::Array(Vec::new()))])
                    }
                },
                Some(id) => fail(format!("unit {id} is not open")),
                None => fail(format!("{op} needs a unit")),
            },
            other => fail(format!("unknown request {other}")),
        };
        (answer, false)
    }

    fn open(&mut self, id: i64, request: &Json) -> Answer {
        if self.units.contains_key(&id) {
            return fail(format!("unit {id} is already open"));
        }
        let descriptor = request.get("family").unwrap_or(&Json::Null);
        let name = descriptor.text("name").unwrap_or_default();
        let Some(family) = family(&name) else {
            return Answer::Fail {
                error: format!("family {name} is not ported to Rust: the Rust runner implements {}", implemented().join(", ")),
                not_ported: true,
            };
        };
        // The port map's descriptor must agree with what the Rust family is: exactly the module ports it calls, no
        // injected port, no store, exactly the module state it keeps.
        if descriptor.get("injected").and_then(Json::as_array).is_some_and(|items| !items.is_empty()) {
            return fail(format!(
                "the port map gives {name} injected ports, which its Rust port does not take: the port map and the port disagree"
            ));
        }
        let mut port_names = HashMap::new();
        for port in descriptor.get("ports").and_then(Json::as_array).unwrap_or_default() {
            match (port.text("export"), port.get("name").and_then(Json::as_str).cloned()) {
                (Some(export), Some(port_name)) => {
                    port_names.insert(export, port_name);
                }
                _ => return fail(format!("a port of {name} without its export or name")),
            }
        }
        let mut wanted: Vec<&str> = family.ports.to_vec();
        wanted.sort_unstable();
        let mut given: Vec<&str> = port_names.keys().map(String::as_str).collect();
        given.sort_unstable();
        if wanted != given {
            return fail(format!(
                "the port map gives {name} the module ports {given:?}, its Rust port calls {wanted:?}: the port map and the port disagree"
            ));
        }
        if descriptor.get("store").is_some() {
            return fail(format!("the port map gives {name} a store, which its Rust port does not keep"));
        }
        let bindings: Vec<String> = descriptor
            .get("moduleState")
            .and_then(|state| state.get("bindings"))
            .and_then(Json::as_array)
            .unwrap_or_default()
            .iter()
            .filter_map(Json::as_string)
            .collect();
        if bindings != family.module_state {
            return fail(format!(
                "the port map gives {name} the module state {bindings:?}, its Rust port keeps {:?}",
                family.module_state
            ));
        }
        let unordered: HashSet<String> = descriptor
            .get("unordered")
            .and_then(Json::as_array)
            .unwrap_or_default()
            .iter()
            .filter_map(Json::as_string)
            .collect();
        if request.get("plants").and_then(Json::as_array).is_some_and(|plants| !plants.is_empty()) {
            return fail("the Rust runner cannot load planted copies of TypeScript modules (a Rust planted difference is chosen with --plant)");
        }
        if request
            .get("load")
            .and_then(|load| load.get("portData"))
            .is_some_and(|data| matches!(data, Json::Object(members) if !members.is_empty()))
        {
            return fail(format!("the recording gives {name} load-time port data, which its Rust port does not read"));
        }
        let mut drafts = HashMap::new();
        for entry in descriptor.get("entries").and_then(Json::as_array).unwrap_or_default() {
            if let (Some(export), Some(draft)) = (entry.text("export"), entry.integer("draft")) {
                drafts.insert(export, draft as usize);
            }
        }
        self.units.insert(
            id,
            Unit {
                family,
                instance: family.open(),
                drafts,
                port_names,
                unordered,
                case: None,
            },
        );
        Answer::Ok(vec![
            ("exports", Json::Array(family.exports.iter().map(|name| Json::str(name)).collect())),
            ("portObjects", Json::Array(Vec::new())),
            ("load", Json::Array(Vec::new())),
        ])
    }

    fn open_case(&mut self, id: i64) -> Answer {
        let Some(unit) = self.units.get_mut(&id) else { return fail("no unit") };
        if unit.case.is_some() {
            return fail("a case is open: end it first");
        }
        unit.case = Some(Case {
            bound: HashMap::new(),
            strings: Vec::new(),
            records: Vec::new(),
            held: Vec::new(),
            groups: Vec::new(),
            next_n: 1,
            halt: None,
            bind_failures: Vec::new(),
            port_calls: 0,
            outside: Vec::new(),
        });
        Answer::Ok(vec![("between", Json::Array(Vec::new()))])
    }

    fn step(&mut self, id: i64, message: &Json) -> Answer {
        let Some(unit) = self.units.get_mut(&id) else { return fail("no unit") };
        let family = unit.family;
        let Unit {
            instance,
            drafts,
            port_names,
            unordered,
            case,
            ..
        } = unit;
        let Some(case) = case.as_mut() else { return fail("no case is open") };
        let names = Names { ports: port_names, unordered };
        if let Some(halt) = &case.halt {
            return Answer::Ok(vec![("halted", halt.json()), ("skipped", Json::Bool(true))]);
        }
        for text in message.get("strings").and_then(Json::as_array).unwrap_or_default() {
            match text {
                Json::String(text) => case.strings.push(text.clone()),
                _ => return fail("a string table entry that is no string"),
            }
        }
        let given = match expand(message.get("input").unwrap_or(&Json::Null), &case.strings) {
            Ok(given) => given,
            Err(error) => return fail(error),
        };
        // The input as the engine echoes it: its kind, entry and time, and what names a timer, port or call.
        let echo: Vec<(&'static str, Json)> = ["kind", "entry", "now", "id", "port", "call", "outcome"]
            .into_iter()
            .filter_map(|key| given.get(key).map(|value| (key, value.clone())))
            .collect();
        let n = case.next_n;
        // A step's nested inputs keep the numbers right after it (they are never delivered here: see `deliver`).
        case.next_n += 1 + nested_count(message);
        let record = Record {
            n,
            echo,
            together: given.get("together").is_some_and(Json::is_true),
            nested: message.get("during").and_then(Json::as_array).is_some_and(|items| !items.is_empty()),
            env: message.get("env").and_then(Json::as_array).map(<[Json]>::to_vec).unwrap_or_default(),
            given,
            bind: message.get("bind").and_then(Json::as_array).map(<[Json]>::to_vec).unwrap_or_default(),
            group: None,
            opened_at: None,
            returned_at: None,
            args: None,
            returns: None,
            throws: None,
            after: None,
            changes: None,
        };
        case.records.push(record);
        let index = case.records.len() - 1;
        case.held.push(index);
        if message.get("hold").is_some_and(Json::is_true) {
            return Answer::Ok(vec![("halted", Json::Null), ("held", Json::Bool(true))]);
        }
        let delivery: Vec<usize> = std::mem::take(&mut case.held);
        // Groups (protocol 5): the first member of a delivery starts one, and so does every later member that did not
        // arrive together with the one before it (an immediate answer would join too; no family here gets a promise).
        // A group answers from one list, its steps' envs in order, and pools their binds.
        for (at, member) in delivery.iter().enumerate() {
            if at == 0 || !case.records[*member].together {
                case.groups.push(Group {
                    effects: Vec::new(),
                    env: Vec::new(),
                    env_next: 0,
                    used: HashSet::new(),
                    binds: Vec::new(),
                });
            }
            let group = case.groups.len() - 1;
            case.records[*member].group = Some(group);
            let (env, bind) = (case.records[*member].env.clone(), case.records[*member].bind.clone());
            case.groups[group].env.extend(env);
            case.groups[group].binds.extend(bind);
        }
        let mut jobs = Jobs::default();
        for (at, member) in delivery.iter().enumerate() {
            if case.halt.is_some() {
                break;
            }
            deliver(family, instance.as_mut(), drafts, &names, case, &mut jobs, *member);
            // A member that did not come together with the next runs its continuations before the next is delivered
            // (the next comes once the engine ran out); members that came together are delivered first.
            let next_together = delivery.get(at + 1).is_some_and(|next| case.records[*next].together);
            if !next_together && case.halt.is_none() {
                run_jobs(&names, case, &mut jobs, *member);
            }
        }
        Answer::Ok(vec![("halted", case.halt.as_ref().map_or(Json::Null, Halt::json))])
    }

    fn end(&mut self, id: i64) -> Answer {
        let Some(unit) = self.units.get_mut(&id) else { return fail("no unit") };
        let Some(mut case) = unit.case.take() else { return fail("no case is open") };
        case.records.sort_by_key(|record| record.n);
        // One identity scope (codec emitSlots), in the TypeScript engine's order: each step's input arguments, then
        // its returns or throws, after and changes (the families have no entry state, effects, end state or timers).
        let mut slots: Vec<&Snapshot> = Vec::new();
        let mut places: Vec<[Option<usize>; 5]> = Vec::new();
        for record in &case.records {
            let mut place = [None; 5];
            for (at, slot) in [&record.args, &record.returns, &record.throws, &record.after, &record.changes]
                .into_iter()
                .enumerate()
            {
                if let Some(slot) = slot {
                    place[at] = Some(slots.len());
                    slots.push(slot);
                }
            }
            places.push(place);
        }
        // Then every group's effects, in order, each one's values in its key order (the TypeScript engine's order).
        let mut effect_places: Vec<Vec<[Option<usize>; 4]>> = Vec::new();
        for group in &case.groups {
            let mut list = Vec::new();
            for effect in &group.effects {
                let mut place = [None; 4];
                for (at, slot) in [&effect.args, &effect.answer, &effect.throws, &effect.value].into_iter().enumerate() {
                    if let Some(slot) = slot {
                        place[at] = Some(slots.len());
                        slots.push(slot);
                    }
                }
                list.push(place);
            }
            effect_places.push(list);
        }
        let trees = emit_slots(&slots);
        let tree = |at: Option<usize>| at.map(|at| trees[at].clone());
        let mut steps = Vec::with_capacity(case.records.len());
        for (record, place) in case.records.iter().zip(&places) {
            let mut input = record.echo.clone();
            if let Some(args) = tree(place[0]) {
                input.push(("args", args));
            }
            let mut out = vec![("n", Json::Number(f64::from(record.n))), ("input", Json::object(input))];
            if let Some(group) = record.group {
                out.push(("group", Json::Number((group + 1) as f64)));
            }
            if let Some(at) = record.opened_at {
                out.push(("openedAt", Json::Number(at as f64)));
            }
            if let Some(at) = record.returned_at {
                out.push(("returnedAt", Json::Number(at as f64)));
            }
            for (key, at) in [("returns", place[1]), ("throws", place[2]), ("after", place[3]), ("changes", place[4])] {
                if let Some(value) = tree(at) {
                    out.push((key, value));
                }
            }
            steps.push(Json::object(out));
        }
        let groups: Vec<Json> = case
            .groups
            .iter()
            .zip(&effect_places)
            .map(|(group, places)| {
                let effects = group
                    .effects
                    .iter()
                    .zip(places)
                    .map(|(effect, place)| {
                        let mut out = vec![("kind", Json::str(effect.kind)), (effect.name_key, Json::String(effect.name.clone()))];
                        if let Some(call) = effect.call {
                            out.push(("call", Json::Number(f64::from(call))));
                        }
                        for (key, at) in [("args", place[0]), ("answer", place[1]), ("throws", place[2]), ("value", place[3])] {
                            if let Some(value) = tree(at) {
                                out.push((key, value));
                            }
                        }
                        Json::object(out)
                    })
                    .collect();
                Json::object(vec![("effects", Json::Array(effects))])
            })
            .collect();
        let mut table: Vec<Str> = Vec::new();
        let mut known: HashMap<Str, usize> = HashMap::new();
        let steps = share_strings(&Json::Array(steps), &mut table, &mut known);
        let groups = share_strings(&Json::Array(groups), &mut table, &mut known);
        let replayed = Json::object(vec![
            ("steps", steps),
            ("groups", groups),
            ("pending", Json::Array(Vec::new())),
            ("strings", Json::Array(table.into_iter().map(Json::String).collect())),
            ("halt", case.halt.as_ref().map_or(Json::Null, Halt::json)),
            ("outside", Json::Array(case.outside)),
            ("bindFailures", Json::Array(case.bind_failures)),
            ("flags", Json::Array(Vec::new())),
        ]);
        Answer::Ok(vec![("replayed", replayed)])
    }
}

/// How many inputs are nested in a step's port calls, at any depth.
fn nested_count(message: &Json) -> u32 {
    message
        .get("during")
        .and_then(Json::as_array)
        .unwrap_or_default()
        .iter()
        .map(|item| 1 + item.get("step").map_or(0, nested_count))
        .sum()
}

/// What the runner knows of a unit's ports.
struct Names<'u> {
    ports: &'u HashMap<String, Str>,
    unordered: &'u HashSet<String>,
}

/// Answers a family's observables from the group's env (the context's host).
struct CaseHost<'c, 'u> {
    case: &'c mut Case,
    names: &'c Names<'u>,
    group: usize,
    /// The step that is open (a halt names it).
    n: u32,
}

impl CaseHost<'_, '_> {
    fn halt(&mut self, check: &'static str, detail: String) -> Halted {
        self.case.halt.get_or_insert(Halt {
            step: Some(self.n),
            check,
            detail,
        });
        Halted
    }

    /// The group's next env item of this kind and name (clock items passed over: the family is handed `now`).
    fn take(&mut self, kind: &str, name: &Str) -> Result<Json, Halted> {
        let group = &mut self.case.groups[self.group];
        let key = if kind == "draw" { "source" } else { "port" };
        let matches = |item: &Json| item.text("kind").as_deref() == Some(kind) && item.get(key).and_then(Json::as_str) == Some(name);
        let unordered = kind == "port" && self.names.unordered.contains(&String::from_utf16_lossy(name));
        if unordered && let Some(at) = (group.env_next..group.env.len()).find(|at| !group.used.contains(at) && matches(&group.env[*at])) {
            group.used.insert(at);
            return Ok(group.env[at].clone());
        }
        while group.env_next < group.env.len() && (group.used.contains(&group.env_next) || group.env[group.env_next].text("kind").as_deref() == Some("clock")) {
            group.env_next += 1;
        }
        if let Some(next) = group.env.get(group.env_next)
            && matches(next)
        {
            group.env_next += 1;
            return Ok(next.clone());
        }
        let later = (group.env_next + 1..group.env.len()).any(|at| !group.used.contains(&at) && matches(&group.env[at]));
        let next = group.env.get(group.env_next).map_or_else(
            || "nothing".to_owned(),
            |item| {
                format!(
                    "{} {}",
                    item.text("kind").unwrap_or_default(),
                    item.text("port").or_else(|| item.text("source")).unwrap_or_default()
                )
            },
        );
        let what = format!("{kind} {}", String::from_utf16_lossy(name));
        Err(if later {
            self.halt(
                "effect-order",
                format!("{what} was asked before its turn; the recording's next effect is {next}"),
            )
        } else {
            self.halt("unanswered", format!("{what} has no recorded answer; the recording's next effect is {next}"))
        })
    }

    fn rebuild(&mut self, tree: &Json) -> Result<Value, Halted> {
        match rebuild(tree, &mut self.case.bound) {
            Ok(value) => Ok(value),
            Err(error) => Err(self.halt("rebuild", error.0)),
        }
    }
}

impl Host for CaseHost<'_, '_> {
    fn port(&mut self, port: &str, args: &[Value]) -> Result<Js, Halted> {
        let Some(name) = self.names.ports.get(port).cloned() else {
            return Err(self.halt("unplaced", format!("the Rust port called {port}, which the port map does not give it")));
        };
        self.case.port_calls += 1;
        let list = Value::Object(Obj::array(args.to_vec()));
        let group = self.group;
        let index = self.case.groups[group].effects.len();
        self.case.groups[group].effects.push(Effect {
            kind: "port",
            name_key: "port",
            name: name.clone(),
            call: Some(self.case.port_calls),
            args: Some(snapshot(&list)),
            answer: None,
            throws: None,
            value: None,
        });
        let binds = self.case.groups[group].binds.clone();
        let n = self.n;
        bind_slot(self.case, n, &format!("effects.{index}.args"), &list, &binds);
        let item = self.take("port", &name)?;
        if let Some(thrown) = item.get("throws") {
            let thrown = self.rebuild(thrown)?;
            self.case.groups[group].effects[index].throws = Some(snapshot(&thrown));
            return Ok(Err(thrown));
        }
        let answer = item.get("answer").cloned().unwrap_or(Json::Null);
        let promise = |node: &Json| node.is_tag("promise") || (node.is_tag("id") && node.get("value").is_some_and(|value| value.is_tag("promise")));
        if promise(&answer) {
            return Err(self.halt(
                "unplaced",
                format!(
                    "a promise as the answer of {}: the Rust runner does not settle answers yet",
                    String::from_utf16_lossy(&name)
                ),
            ));
        }
        let answer = self.rebuild(&answer)?;
        self.case.groups[group].effects[index].answer = Some(snapshot(&answer));
        Ok(Ok(answer))
    }

    fn draw(&mut self, source: &str) -> Result<Value, Halted> {
        let name: Str = source.encode_utf16().collect::<Vec<u16>>().into();
        let item = self.take("draw", &name)?;
        let value = self.rebuild(item.get("value").unwrap_or(&Json::Null))?;
        let group = self.group;
        self.case.groups[group].effects.push(Effect {
            kind: "draw",
            name_key: "source",
            name,
            call: None,
            args: None,
            answer: None,
            throws: None,
            value: Some(snapshot(&value)),
        });
        Ok(value)
    }
}

/// Runs the delivery's continuations to quiescence; what they throw uncaught is the case's `outside`.
fn run_jobs(names: &Names<'_>, case: &mut Case, jobs: &mut Jobs, member: usize) {
    let n = case.records[member].n;
    let group = case.records[member].group.unwrap_or(0);
    let now = case.records[member].given.get("now").and_then(Json::as_f64);
    let quiet = {
        let mut host = CaseHost { case, names, group, n };
        jobs.run(now, &mut host)
    };
    for thrown in jobs.take_uncaught() {
        case.outside.push(Json::object(vec![(
            "what",
            Json::String(format!("uncaught {}", describe(&thrown)).encode_utf16().collect::<Vec<u16>>().into()),
        )]));
    }
    if quiet == Quiet::Endless {
        case.halt.get_or_insert(Halt {
            step: Some(n),
            check: "quiescence",
            detail: format!("the step was still running after {} jobs", devryan_client_engine::ctx::JOB_LIMIT),
        });
    }
}

/// `name: message` of a thrown value, as the TypeScript engine describes what a job threw.
fn describe(thrown: &Value) -> String {
    let name = devryan_client_engine::js::get_opt(thrown, "name");
    let message = devryan_client_engine::js::get_opt(thrown, "message");
    let text = |value: &Value| devryan_client_engine::js::to_string(value).map_or_else(|_| "?".to_owned(), |text| String::from_utf16_lossy(&text));
    match thrown {
        Value::Object(_) => format!("{}: {}", text(&name), text(&message)),
        other => format!("{}: {}", devryan_client_engine::js::type_of(other), text(other)),
    }
}

/// Delivers one member of a delivery: the synchronous part of a call of an export (its continuations are queued).
fn deliver(
    family: &'static Family,
    instance: &mut dyn Instance,
    drafts: &HashMap<String, usize>,
    names: &Names<'_>,
    case: &mut Case,
    jobs: &mut Jobs,
    index: usize,
) {
    let n = case.records[index].n;
    let unplaced = |case: &mut Case, detail: String| {
        case.halt.get_or_insert(Halt {
            step: Some(n),
            check: "unplaced",
            detail,
        });
    };
    let given = case.records[index].given.clone();
    let kind = given.text("kind").unwrap_or_default();
    let group = case.records[index].group.unwrap_or(0);
    // An input with a synchronous part opens before it (a settle would open at its promise's first reaction).
    if kind != "settle" {
        case.records[index].opened_at = Some(case.groups[group].effects.len());
    }
    let nested = case.records[index].nested;
    if kind != "call" {
        unplaced(case, format!("an input of kind {kind}, which the Rust runner does not deliver yet"));
        return;
    }
    if nested {
        unplaced(case, "inputs nested in a port call, which the Rust runner does not deliver yet".into());
        return;
    }
    let entry = given.text("entry").unwrap_or_default();
    if !family.exports.contains(&entry.as_str()) {
        unplaced(case, format!("call {entry} names nothing {} has (an export of its Rust port)", family.name));
        return;
    }
    let args = match rebuild(given.get("args").unwrap_or(&Json::Array(Vec::new())), &mut case.bound) {
        Ok(Value::Object(array)) if array.is_array() => array,
        Ok(_) => {
            case.halt.get_or_insert(Halt {
                step: Some(n),
                check: "rebuild",
                detail: "the arguments are not a list".into(),
            });
            return;
        }
        Err(error) => {
            case.halt.get_or_insert(Halt {
                step: Some(n),
                check: "rebuild",
                detail: error.0,
            });
            return;
        }
    };
    // The runner made `args` from the step's list of arguments (an array shorter than the codec's bound).
    let list = match args.elements() {
        Some(Ok(list)) => list,
        _ => {
            unplaced(case, "the arguments are no list the engine can visit".to_owned());
            return;
        }
    };
    case.records[index].args = Some(snapshot(&Value::Object(args)));
    let draft = drafts.get(&entry).copied();
    let before = draft.map(|at| identity_paths(list.get(at).unwrap_or(&Value::Undefined)));
    let now = given.get("now").and_then(Json::as_f64);
    let result = {
        let mut host = CaseHost { case, names, group, n };
        let mut ctx = Ctx::new(now, &mut host, jobs);
        instance.call(&mut ctx, &entry, &list)
    };
    if case.halt.is_some() {
        return;
    }
    case.records[index].returned_at = Some(case.groups[group].effects.len());
    let Some(result) = result else {
        unplaced(case, format!("call {entry} names nothing {} has", family.name));
        return;
    };
    let bind = case.records[index].bind.clone();
    match result {
        Ok(value) => {
            case.records[index].returns = Some(snapshot(&value));
            bind_slot(case, n, "returns", &value, &bind);
        }
        Err(thrown) => {
            case.records[index].throws = Some(snapshot(&thrown));
            bind_slot(case, n, "throws", &thrown, &bind);
        }
    }
    let after = Value::Object(Obj::array(list.clone()));
    case.records[index].after = Some(snapshot(&after));
    bind_slot(case, n, "after", &after, &bind);
    if let (Some(at), Some(before)) = (draft, before) {
        let changes = paths_value(&changed_paths(&before, &identity_paths(list.get(at).unwrap_or(&Value::Undefined))));
        case.records[index].changes = Some(snapshot(&changes));
        bind_slot(case, n, "changes", &changes, &bind);
    }
}

/// Binds what a step's own slot holds at each bind path of that slot to the recording's number (or notes the failure).
fn bind_slot(case: &mut Case, n: u32, slot: &str, live: &Value, bind: &[Json]) {
    for request in bind {
        if request.text("slot").as_deref() != Some(slot) {
            continue;
        }
        let path = request.get("path").and_then(Json::as_array).unwrap_or_default();
        match at_path(live, path) {
            Some(Value::Object(found)) => {
                if request.get("name").is_some() {
                    // Handed-out engine code: the pure families hand out none, so a later input naming it finds nothing.
                    continue;
                }
                if let Some(number) = request.integer("n") {
                    case.bound.entry(number).or_insert(found);
                }
            }
            _ => {
                let mut failure = vec![
                    ("step", Json::Number(f64::from(n))),
                    ("slot", Json::str(slot)),
                    ("path", Json::Array(path.to_vec())),
                ];
                if let Some(number) = request.get("n") {
                    failure.push(("n", number.clone()));
                }
                if let Some(name) = request.get("name") {
                    failure.push(("name", name.clone()));
                }
                case.bind_failures.push(Json::object(failure));
            }
        }
    }
}

/// A tree with the case's string-table references put back (`{"$dr":"slice","s":k}`).
fn expand(node: &Json, table: &[Str]) -> Result<Json, String> {
    Ok(match node {
        Json::Array(items) => Json::Array(items.iter().map(|item| expand(item, table)).collect::<Result<_, _>>()?),
        Json::Object(members) => {
            if node.is_tag("slice") && members.len() == 2 {
                let index = node.integer("s").ok_or("a string-table reference without its index")?;
                return table
                    .get(usize::try_from(index).map_err(|_| "a negative string-table index")?)
                    .map(|text| Json::String(text.clone()))
                    .ok_or_else(|| format!("a tree referred to string {index} of a table of {}", table.len()));
            }
            Json::Object(
                members
                    .iter()
                    .map(|(key, value)| Ok((key.clone(), expand(value, table)?)))
                    .collect::<Result<_, String>>()?,
            )
        }
        other => other.clone(),
    })
}

/// Long strings of a tree put in the answer's string table (engine.mjs shareStrings).
fn share_strings(node: &Json, table: &mut Vec<Str>, known: &mut HashMap<Str, usize>) -> Json {
    match node {
        Json::String(text) if text.len() >= LONG_STRING => {
            let index = *known.entry(text.clone()).or_insert_with(|| {
                table.push(text.clone());
                table.len() - 1
            });
            Json::object(vec![("$dr", Json::str("slice")), ("s", Json::Number(index as f64))])
        }
        Json::Array(items) => Json::Array(items.iter().map(|item| share_strings(item, table, known)).collect()),
        Json::Object(members) => Json::Object(members.iter().map(|(key, value)| (key.clone(), share_strings(value, table, known))).collect()),
        other => other.clone(),
    }
}
