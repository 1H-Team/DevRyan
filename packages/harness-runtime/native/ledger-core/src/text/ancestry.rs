//! `minimizeMutationAncestry`, line for line, with its yielding as a hook.
//!
//! The JavaScript counts work (`due`) and, every 256 units, calls `pause()`,
//! which resets the count and yields to the event loop when its time slice
//! (`sliceMs`, by `performance.now()`) is spent. Here the algorithm counts
//! the same work and awaits `AncestryPause::pause(site)` at exactly the six
//! places the JavaScript awaits `pause()`, in the same sequence; the hook
//! decides whether to yield. `SlicedPause` is the JavaScript's own rule over
//! a clock the caller supplies, and `minimize_mutation_ancestry_now` runs the
//! algorithm to completion when the hook never waits.

use std::collections::{HashMap, HashSet};
use std::future::Future;
use std::pin::pin;
use std::sync::Arc;
use std::task::{Context, Poll, Waker};

use super::{Range, Run};
use crate::js::JsStr;

/// Where the algorithm pauses, in the order the JavaScript's `await pause()`
/// calls appear in its source.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum PauseSite {
    /// Reading the runs (`due(1 + run.replaces.length)`).
    Read,
    /// The height walk, per child.
    Height,
    /// Each range of a list, in reduction order.
    Order,
    /// Each range a kept range reaches, while covering.
    Reach,
    /// Each range a kept range reaches, while building the check.
    Check,
    /// Each range of a list, while verifying.
    Verify,
}

impl PauseSite {
    pub const ALL: [PauseSite; 6] = [
        PauseSite::Read,
        PauseSite::Height,
        PauseSite::Order,
        PauseSite::Reach,
        PauseSite::Check,
        PauseSite::Verify,
    ];
}

/// The caller's yield: awaited where the JavaScript awaits `pause()`.
pub trait AncestryPause {
    fn pause(&mut self, site: PauseSite) -> impl Future<Output = ()>;
}

/// The JavaScript's `pause()`: yield (`yield_now`) once `slice_ms` have
/// passed on `clock` since the slice started, then start a new slice. The
/// clock is read once when the pause is made (the JavaScript reads
/// `performance.now()` first thing), once per pause, and once after each
/// yield, as the JavaScript reads it.
pub struct SlicedPause<C, Y> {
    clock: C,
    slice_ms: f64,
    started: f64,
    yield_now: Y,
}

impl<C: FnMut() -> f64, F: Future<Output = ()>, Y: FnMut() -> F> SlicedPause<C, Y> {
    pub fn start(mut clock: C, slice_ms: f64, yield_now: Y) -> Self {
        let started = clock();
        SlicedPause {
            clock,
            slice_ms,
            started,
            yield_now,
        }
    }
}

impl<C: FnMut() -> f64, F: Future<Output = ()>, Y: FnMut() -> F> AncestryPause
    for SlicedPause<C, Y>
{
    async fn pause(&mut self, _site: PauseSite) {
        if (self.clock)() - self.started < self.slice_ms {
            return;
        }
        (self.yield_now)().await;
        self.started = (self.clock)();
    }
}

/// `{ runs, before, after, changed }`.
#[derive(Clone, Debug, PartialEq)]
pub struct Minimized {
    pub runs: Vec<Run>,
    pub before: usize,
    pub after: usize,
    pub changed: bool,
}

/// The errors the JavaScript throws, by message.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum AncestryError {
    /// `mutation_ancestry_invalid`: a range with a negative start or length.
    Invalid,
    /// `mutation_ancestry_cycle`.
    Cycle,
    /// `mutation_ancestry_verification_failed`.
    VerificationFailed,
}

impl AncestryError {
    pub fn message(self) -> &'static str {
        match self {
            AncestryError::Invalid => "mutation_ancestry_invalid",
            AncestryError::Cycle => "mutation_ancestry_cycle",
            AncestryError::VerificationFailed => "mutation_ancestry_verification_failed",
        }
    }
}

/// Sorted, merged `[start, end)` intervals per id (`addInterval`).
fn add_interval(
    intervals: &mut HashMap<JsStr, Vec<(i64, i64)>>,
    id: &JsStr,
    mut start: i64,
    mut end: i64,
) {
    if end <= start {
        return;
    }
    let Some(list) = intervals.get_mut(id) else {
        intervals.insert(id.clone(), vec![(start, end)]);
        return;
    };
    let mut low = 0;
    while low < list.len() && list[low].1 < start {
        low += 1;
    }
    let mut high = low;
    while high < list.len() && list[high].0 <= end {
        start = start.min(list[high].0);
        end = end.max(list[high].1);
        high += 1;
    }
    list.splice(low..high, [(start, end)]);
}

/// `containsInterval`.
fn contains_interval(
    intervals: &HashMap<JsStr, Vec<(i64, i64)>>,
    id: &JsStr,
    start: i64,
    end: i64,
) -> bool {
    let list = intervals.get(id).map(Vec::as_slice).unwrap_or_default();
    let (mut low, mut high) = (0, list.len());
    while low < high {
        let middle = (low + high) >> 1;
        if list[middle].0 <= start {
            low = middle + 1;
        } else {
            high = middle;
        }
    }
    low > 0 && list[low - 1].1 >= end
}

/// The work counter: `due(units)` and the reset `pause()` makes.
struct Work(u64);

impl Work {
    fn due(&mut self, units: usize) -> bool {
        self.0 += units as u64;
        self.0 >= 256
    }
}

/// `validRange` for a range of the model: a safe start and length, neither
/// negative.
fn valid_range(range: &Range) -> bool {
    (0..=MAX_SAFE_INTEGER).contains(&range.start) && (0..=MAX_SAFE_INTEGER).contains(&range.length)
}

/// `Number.MAX_SAFE_INTEGER`.
const MAX_SAFE_INTEGER: i64 = 9_007_199_254_740_991;

/// `minimizeMutationAncestry(runs, { yieldNow, sliceMs })`.
pub async fn minimize_mutation_ancestry<P: AncestryPause>(
    runs: &[Run],
    pauser: &mut P,
) -> Result<Minimized, AncestryError> {
    let mut work = Work(0);
    macro_rules! pause_if_due {
        ($units:expr, $site:expr) => {
            if work.due($units) {
                work.0 = 0;
                pauser.pause($site).await;
            }
        };
    }
    // One list per distinct `replaces` of an id; `canonical[i]` is run i's.
    let mut ids: Vec<JsStr> = Vec::new();
    let mut lists: HashMap<JsStr, Vec<usize>> = HashMap::new();
    let mut storage: Vec<Arc<[Range]>> = Vec::new();
    let mut canonical: Vec<usize> = Vec::with_capacity(runs.len());
    let mut pieces: HashMap<JsStr, Vec<usize>> = HashMap::new();
    let mut before = 0usize;
    for (index, run) in runs.iter().enumerate() {
        if !run.replaces.iter().all(valid_range) {
            return Err(AncestryError::Invalid);
        }
        before += run.replaces.len();
        let known = lists.get(&run.id).map(Vec::as_slice).unwrap_or_default();
        let list = match known.iter().copied().find(|&candidate| {
            Arc::ptr_eq(&storage[candidate], &run.replaces) || storage[candidate] == run.replaces
        }) {
            Some(list) => list,
            None => {
                storage.push(run.replaces.clone());
                let list = storage.len() - 1;
                if !lists.contains_key(&run.id) {
                    ids.push(run.id.clone());
                }
                lists.entry(run.id.clone()).or_default().push(list);
                list
            }
        };
        canonical.push(list);
        pieces.entry(run.id.clone()).or_default().push(index);
        pause_if_due!(1 + run.replaces.len(), PauseSite::Read);
    }
    for same in pieces.values_mut() {
        same.sort_by_key(|&index| runs[index].start);
    }
    // Runs starting inside `range`, as `inRange` selects them.
    let starting = |range: &Range| -> &[usize] {
        let same = pieces.get(&range.id).map(Vec::as_slice).unwrap_or_default();
        let low = same.partition_point(|&index| runs[index].start < range.start);
        let high = low
            + same[low..]
                .iter()
                .take_while(|&&index| runs[index].start < range.end())
                .count();
        &same[low..high]
    };
    // One step of reach: the range itself and every list its runs hold.
    let reach = |range: &Range| -> Vec<Range> {
        let mut out = vec![range.clone()];
        let mut seen = HashSet::new();
        for &index in starting(range) {
            let list = canonical[index];
            if seen.insert(list) {
                out.extend(storage[list].iter().cloned());
            }
        }
        out
    };
    // Height: 0 without ancestry, else one above the highest id it lists.
    let children = |id: &JsStr| -> Vec<JsStr> {
        let mut seen = HashSet::new();
        let mut out = Vec::new();
        for &list in lists.get(id).map(Vec::as_slice).unwrap_or_default() {
            for range in storage[list].iter() {
                if seen.insert(range.id.clone()) {
                    out.push(range.id.clone());
                }
            }
        }
        out
    };
    struct Frame {
        id: JsStr,
        children: Vec<JsStr>,
        next: usize,
        height: u64,
    }
    let mut heights: HashMap<JsStr, u64> = HashMap::new();
    for id in &ids {
        if heights.contains_key(id) {
            continue;
        }
        let mut stack = vec![Frame {
            id: id.clone(),
            children: children(id),
            next: 0,
            height: 0,
        }];
        let mut active: HashSet<JsStr> = HashSet::from([id.clone()]);
        while let Some(frame) = stack.last_mut() {
            if frame.next < frame.children.len() {
                let child = frame.children[frame.next].clone();
                frame.next += 1;
                pause_if_due!(1, PauseSite::Height);
                let frame = stack.last_mut().expect("the frame is still on the stack");
                if let Some(height) = heights.get(&child) {
                    frame.height = frame.height.max(height + 1);
                    continue;
                }
                if active.contains(&child) {
                    return Err(AncestryError::Cycle);
                }
                active.insert(child.clone());
                let grandchildren = children(&child);
                stack.push(Frame {
                    id: child,
                    children: grandchildren,
                    next: 0,
                    height: 0,
                });
                continue;
            }
            let frame = stack.pop().expect("a frame is on the stack");
            heights.insert(frame.id.clone(), frame.height);
            active.remove(&frame.id);
            if let Some(parent) = stack.last_mut() {
                parent.height = parent.height.max(frame.height + 1);
            }
        }
    }
    let mut reductions: HashMap<usize, Arc<[Range]>> = HashMap::new();
    for id in &ids {
        for &list in &lists[id] {
            let ranges = storage[list].clone();
            let mut order: Vec<(usize, u64)> = ranges
                .iter()
                .enumerate()
                .map(|(index, range)| (index, heights.get(&range.id).copied().unwrap_or(0)))
                .collect();
            order.sort_by(|left, right| {
                right
                    .1
                    .cmp(&left.1)
                    .then(ranges[right.0].length.cmp(&ranges[left.0].length))
                    .then(left.0.cmp(&right.0))
            });
            let mut covered: HashMap<JsStr, Vec<(i64, i64)>> = HashMap::new();
            let mut kept: Vec<usize> = Vec::new();
            for &(index, _) in &order {
                pause_if_due!(1, PauseSite::Order);
                let range = &ranges[index];
                if range.length == 0
                    || contains_interval(&covered, &range.id, range.start, range.end())
                {
                    continue;
                }
                kept.push(index);
                for reached in reach(range) {
                    add_interval(&mut covered, &reached.id, reached.start, reached.end());
                    pause_if_due!(1, PauseSite::Reach);
                }
            }
            let mut check: HashMap<JsStr, Vec<(i64, i64)>> = HashMap::new();
            for &index in &kept {
                for reached in reach(&ranges[index]) {
                    pause_if_due!(1, PauseSite::Check);
                    if reached.length == 0 {
                        continue;
                    }
                    let interval = (reached.start, reached.end());
                    check.entry(reached.id.clone()).or_default().push(interval);
                }
            }
            for intervals in check.values_mut() {
                intervals.sort_by_key(|interval| interval.0);
                let mut write = 0;
                for at in 0..intervals.len() {
                    let interval = intervals[at];
                    if write > 0 && interval.0 <= intervals[write - 1].1 {
                        intervals[write - 1].1 = intervals[write - 1].1.max(interval.1);
                    } else {
                        intervals[write] = interval;
                        write += 1;
                    }
                }
                intervals.truncate(write);
            }
            for range in ranges.iter() {
                pause_if_due!(1, PauseSite::Verify);
                if range.length > 0
                    && !contains_interval(&check, &range.id, range.start, range.end())
                {
                    return Err(AncestryError::VerificationFailed);
                }
            }
            let reduction = if kept.len() == ranges.len() {
                ranges
            } else {
                kept.sort_unstable();
                Arc::from(
                    kept.iter()
                        .map(|&index| ranges[index].clone())
                        .collect::<Vec<_>>(),
                )
            };
            reductions.insert(list, reduction);
        }
    }
    let mut after = 0usize;
    let result = runs
        .iter()
        .zip(&canonical)
        .map(|(run, list)| {
            let replaces = &reductions[list];
            after += replaces.len();
            let mut run = run.clone();
            if replaces.len() != run.replaces.len() {
                run.replaces = replaces.clone();
            }
            run
        })
        .collect();
    Ok(Minimized {
        runs: result,
        before,
        after,
        changed: after < before,
    })
}

/// A hook that only observes: `minimize_mutation_ancestry_now` calls it at
/// every pause and never waits.
struct Observe<F>(F);

impl<F: FnMut(PauseSite)> AncestryPause for Observe<F> {
    async fn pause(&mut self, site: PauseSite) {
        (self.0)(site);
    }
}

/// `minimize_mutation_ancestry` run to completion with a hook that never
/// waits (`on_pause` sees every pause).
pub fn minimize_mutation_ancestry_now(
    runs: &[Run],
    on_pause: impl FnMut(PauseSite),
) -> Result<Minimized, AncestryError> {
    let mut hook = Observe(on_pause);
    let future = pin!(minimize_mutation_ancestry(runs, &mut hook));
    match future.poll(&mut Context::from_waker(Waker::noop())) {
        Poll::Ready(result) => result,
        Poll::Pending => unreachable!("no future here ever waits"),
    }
}
