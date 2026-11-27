//! Planted differences: test-only switches in the families' code, each a
//! small change of behaviour (package C0i, part C), that the conformance
//! harness must report as a difference on named cases. At most one is active
//! in a process, chosen once by the runner (`--plant=<id>`); with none, every
//! switch is off and the code is the port. `PLANTS` lists every switch the
//! sources hold (a test checks the two agree), with what it changes.

use std::sync::OnceLock;

pub struct Plant {
    pub id: &'static str,
    pub family: &'static str,
    pub change: &'static str,
}

static ACTIVE: OnceLock<&'static str> = OnceLock::new();

/// Turns on one planted difference for the rest of the process.
pub fn activate(id: &str) -> Result<(), String> {
    let Some(plant) = crate::plants::PLANTS.iter().find(|plant| plant.id == id) else {
        return Err(format!("no planted difference is named {id}"));
    };
    ACTIVE.set(plant.id).map_err(|_| "a planted difference is already active".to_owned())
}

/// Whether the planted difference `id` is the active one.
pub fn on(id: &str) -> bool {
    ACTIVE.get().is_some_and(|active| *active == id)
}
