//! `applyMutationText` and its helpers (`splitAt`, `baseRange`, `anchorAt`,
//! `replacedClosure`, `pastReplaced`, `coalesceChanges`), line for line.
//! The two recursive walks (`visit`, `replacedClosure`) run on explicit
//! stacks in the JavaScript's order, so no ancestry depth exhausts the stack.

use std::collections::{HashMap, HashSet};
use std::sync::Arc;

use super::{Range, Run, js_add, js_sub};
use crate::diff::{DELETE, EQUAL, INSERT, mutation_diff};
use crate::js::JsStr;

/// `MUTATION_DIFF_WORK_BUDGET`, the diff's default work budget.
pub const MUTATION_DIFF_WORK_BUDGET: i64 = 4_000_000;
/// `MUTATION_HUNK_WORK_BUDGET`: past this many hunk × run steps every hunk
/// merges into one replacement.
pub const MUTATION_HUNK_WORK_BUDGET: f64 = 2_000_000.0;

struct Change {
    kind: u32,
    text: Vec<u8>,
}

/// `mutationDiff(before, after)` as `{ kind, text }` changes.
fn changes_of(before: &[u8], after: &[u8]) -> Vec<Change> {
    let pairs = mutation_diff(before, after, MUTATION_DIFF_WORK_BUDGET);
    let (mut x, mut y) = (0usize, 0usize);
    pairs
        .as_chunks::<2>()
        .0
        .iter()
        .map(|&[kind, bytes]| {
            let bytes = bytes as usize;
            let text = if kind == INSERT {
                y += bytes;
                after[y - bytes..y].to_vec()
            } else {
                x += bytes;
                if kind == EQUAL {
                    y += bytes;
                }
                before[x - bytes..x].to_vec()
            };
            Change { kind, text }
        })
        .collect()
}

/// `coalesceChanges(changes)`: everything from the first to the last change
/// becomes one deletion of the old text and one insertion of the new.
fn coalesce_changes(changes: Vec<Change>) -> Vec<Change> {
    let Some(first) = changes.iter().position(|change| change.kind != EQUAL) else {
        return changes;
    };
    let last = changes
        .iter()
        .rposition(|change| change.kind != EQUAL)
        .expect("a change other than equal exists");
    let span = &changes[first..=last];
    let joined = |skip: u32| -> Vec<u8> {
        span.iter()
            .filter(|change| change.kind != skip)
            .flat_map(|change| change.text.iter().copied())
            .collect()
    };
    let (removed, inserted) = (joined(INSERT), joined(DELETE));
    let mut result = Vec::with_capacity(changes.len());
    let mut changes = changes.into_iter();
    result.extend(changes.by_ref().take(first));
    let mut changes = changes.skip(last - first + 1);
    if !removed.is_empty() {
        result.push(Change {
            kind: DELETE,
            text: removed,
        });
    }
    if !inserted.is_empty() {
        result.push(Change {
            kind: INSERT,
            text: inserted,
        });
    }
    result.extend(changes.by_ref());
    result
}

/// The runs being edited: every run object ever made lives in `arena` (as
/// JavaScript objects stay alive while referenced); `result` is the run list
/// and `by_id` the id index, both holding arena indices.
struct Runs {
    arena: Vec<Run>,
    result: Vec<usize>,
    by_id: HashMap<JsStr, Vec<usize>>,
}

/// One end of an insertion: `{ id, offset }`.
#[derive(Clone)]
struct Anchor {
    id: JsStr,
    offset: i64,
}

impl Runs {
    /// `runs.indexOf(run)`.
    fn index_of(&self, handle: usize) -> Option<usize> {
        self.result.iter().position(|&at| at == handle)
    }

    /// `splitAt(runs, byId, id, offset)`: the run of `id` that `offset`
    /// falls strictly inside becomes two runs.
    fn split_at(&mut self, id: &JsStr, offset: i64) {
        let Some(list) = self.by_id.get(id) else {
            return;
        };
        let Some(k) = list.iter().position(|&handle| {
            let run = &self.arena[handle];
            offset > run.start && offset < run.end()
        }) else {
            return;
        };
        let handle = list[k];
        let run = &self.arena[handle];
        // JS: `offset - run.start`, and `slice` clamps (a cut is always
        // inside the text: both ends are doubles strictly inside the run).
        let cut = (js_sub(offset, run.start) as usize).min(run.text.len());
        let mut left = run.clone();
        left.text.truncate(cut);
        let mut right = run.clone();
        right.start = offset;
        right.text.drain(..cut);
        let (left_at, right_at) = (self.arena.len(), self.arena.len() + 1);
        self.arena.push(left);
        self.arena.push(right);
        // JS: `runs.splice(runs.indexOf(run), 1, left, right)`; an index of -1
        // would replace the last run (never the case: every indexed run is listed).
        let at = match self.index_of(handle) {
            Some(at) => at,
            None => self.result.len().saturating_sub(1),
        };
        let remove = usize::from(at < self.result.len());
        self.result.splice(at..at + remove, [left_at, right_at]);
        self.by_id
            .get_mut(id)
            .expect("the list was found above")
            .splice(k..=k, [left_at, right_at]);
    }

    /// `replacedClosure(byId, owner)`: every range reachable from the run's
    /// own ranges through the runs starting inside them. Only membership is
    /// read (`pastReplaced` asks `some`), so the walk order is free.
    fn replaced_closure(&self, owner: usize) -> HashSet<Range> {
        let mut seen = HashSet::new();
        let mut stack: Vec<Range> = self.arena[owner].replaces.iter().rev().cloned().collect();
        while let Some(range) = stack.pop() {
            if !seen.insert(range.clone()) {
                continue;
            }
            for &handle in self.by_id.get(&range.id).into_iter().flatten() {
                let run = &self.arena[handle];
                if range.holds(run) {
                    stack.extend(run.replaces.iter().rev().cloned());
                }
            }
        }
        seen
    }

    /// `pastReplaced(runs, byId, at)`: the first index from `at` whose run no
    /// range of the closure of the run before `at` holds.
    fn past_replaced(&self, mut at: usize) -> usize {
        let ranges = self.replaced_closure(self.result[at - 1]);
        while at < self.result.len() {
            let run = &self.arena[self.result[at]];
            if !ranges.iter().any(|range| range.holds(run)) {
                break;
            }
            at += 1;
        }
        at
    }

    /// `position(id, match)`: the list index of the first run of `id` that
    /// matches, or -1.
    fn position(&self, id: &JsStr, matches: impl Fn(&Run) -> bool) -> Option<usize> {
        let handle = self
            .by_id
            .get(id)?
            .iter()
            .copied()
            .find(|&handle| matches(&self.arena[handle]))?;
        self.index_of(handle)
    }
}

/// `baseRange(base, start, length)`: the base runs' pieces under
/// `[start, start + length)`, as ranges of their ids.
fn base_range(base: &[&Run], start: i64, length: i64) -> Vec<Range> {
    let mut ranges = Vec::new();
    let mut position = 0i64;
    for run in base {
        let size = run.text.len() as i64;
        let low = start.max(position);
        let high = (start + length).min(position + size);
        if low < high {
            ranges.push(Range {
                id: run.id.clone(),
                start: js_sub(js_add(run.start, low), position),
                length: high - low,
            });
        }
        position += size;
    }
    ranges
}

/// `anchorAt(base, offset)`: the base positions just before and at `offset`.
fn anchor_at(base: &[&Run], offset: i64) -> (Option<Anchor>, Option<Anchor>) {
    let mut position = 0i64;
    let mut left = None;
    for run in base {
        let size = run.text.len() as i64;
        if offset < position + size {
            if offset > position {
                left = Some(Anchor {
                    id: run.id.clone(),
                    offset: js_sub(js_add(run.start, offset), position),
                });
            }
            let right = Anchor {
                id: run.id.clone(),
                offset: js_sub(js_add(run.start, offset), position),
            };
            return (left, Some(right));
        }
        position += size;
        left = Some(Anchor {
            id: run.id.clone(),
            offset: js_add(run.start, size),
        });
    }
    (left, None)
}

/// A pending `visit(range)` call: the range, the next index `j` of its id's
/// list, and the ancestors of `list[j]` still to visit.
struct Visit {
    range: Range,
    next: usize,
    ancestors: Option<(Arc<[Range]>, usize)>,
}

/// `applyMutationText(runs, base, after, operationID, { hunkBudget })`.
/// `base` is the base revision's runs (the product passes
/// `visibleMutationRuns(runs, disabled)`), `after` the new text.
pub fn apply_mutation_text(
    runs: &[Run],
    base: &[&Run],
    after: &[u8],
    operation_id: &JsStr,
    hunk_budget: f64,
) -> Vec<Run> {
    let mut state = Runs {
        arena: runs.to_vec(),
        result: (0..runs.len()).collect(),
        by_id: HashMap::new(),
    };
    for (handle, run) in runs.iter().enumerate() {
        state.by_id.entry(run.id.clone()).or_default().push(handle);
    }
    let base_text: Vec<u8> = base
        .iter()
        .flat_map(|run| run.text.iter().copied())
        .collect();
    let mut changes = changes_of(&base_text, after);
    let hunks = changes
        .iter()
        .enumerate()
        .filter(|(index, change)| {
            change.kind != EQUAL
                && (*index == 0 || !matches!(changes[index - 1].kind, DELETE | INSERT))
        })
        .count();
    if hunks > 1 && (hunks * (state.result.len() + base.len())) as f64 > hunk_budget {
        changes = coalesce_changes(changes);
    }
    let mut offset = 0i64;
    let mut index = 0usize;
    let mut i = 0usize;
    while i < changes.len() {
        if changes[i].kind == EQUAL {
            offset += changes[i].text.len() as i64;
            i += 1;
            continue;
        }
        let (mut removed, mut inserted) = (Vec::new(), Vec::new());
        while i < changes.len() && changes[i].kind != EQUAL {
            if changes[i].kind == DELETE {
                removed.extend_from_slice(&changes[i].text);
            } else {
                inserted.extend_from_slice(&changes[i].text);
            }
            i += 1;
        }
        let (left, right) = anchor_at(base, offset);
        let ranges = base_range(base, offset, removed.len() as i64);
        let mut covered: HashSet<Range> = HashSet::new();
        for range in &ranges {
            visit(&mut state, &mut covered, range, operation_id);
        }
        // `[...new Map(ranges.map((range) => [key, range])).values()]`.
        let mut seen = HashSet::new();
        let direct: Vec<Range> = ranges
            .iter()
            .filter(|range| seen.insert((*range).clone()))
            .cloned()
            .collect();
        if !inserted.is_empty() {
            if let Some(left) = &left {
                state.split_at(&left.id, left.offset);
            }
            if let Some(right) = &right {
                state.split_at(&right.id, right.offset);
            }
            let boundary = removed.is_empty()
                && left.as_ref().is_some_and(|left| {
                    right
                        .as_ref()
                        .is_none_or(|right| left.id != right.id || left.offset != right.offset)
                });
            let mut at = match (&right, boundary) {
                (Some(right), false) => state.position(&right.id, |run| run.start == right.offset),
                _ => None,
            };
            if at.is_none()
                && let Some(left) = &left
                && let Some(found) = state.position(&left.id, |run| run.end() == left.offset)
            {
                at = Some(if boundary {
                    state.past_replaced(found + 1)
                } else {
                    found + 1
                });
            }
            let at = at.unwrap_or(state.result.len());
            let mut id = operation_id.clone();
            id.push_str(&format!(":{index}"));
            index += 1;
            let mut created = Run::new(id.clone(), 0, inserted, Some(operation_id.clone()));
            created.replaces = Arc::from(direct);
            let handle = state.arena.len();
            state.arena.push(created);
            state.result.insert(at, handle);
            state.by_id.insert(id, vec![handle]);
        }
        offset += removed.len() as i64;
    }
    state
        .result
        .iter()
        .map(|&handle| state.arena[handle].clone())
        .collect()
}

/// `visit(range)`: split the range's runs at its ends, mark every run
/// starting inside it as deleted by the operation, and visit their ancestry.
fn visit(state: &mut Runs, covered: &mut HashSet<Range>, range: &Range, operation_id: &JsStr) {
    let mut stack: Vec<Visit> = Vec::new();
    let mut enter = |state: &mut Runs, stack: &mut Vec<Visit>, range: Range| {
        if !covered.insert(range.clone()) {
            return;
        }
        state.split_at(&range.id, range.start);
        state.split_at(&range.id, range.end());
        stack.push(Visit {
            range,
            next: 0,
            ancestors: None,
        });
    };
    enter(state, &mut stack, range.clone());
    while let Some(frame) = stack.last_mut() {
        if let Some((ancestors, at)) = &mut frame.ancestors {
            if *at < ancestors.len() {
                let ancestor = ancestors[*at].clone();
                *at += 1;
                enter(state, &mut stack, ancestor);
            } else {
                frame.ancestors = None;
                frame.next += 1;
            }
            continue;
        }
        // The list as it is now: splits inside the ancestry walk show here.
        let handle = state
            .by_id
            .get(&frame.range.id)
            .and_then(|list| list.get(frame.next).copied());
        let Some(handle) = handle else {
            stack.pop();
            continue;
        };
        let range = &frame.range;
        let run = &mut state.arena[handle];
        if run.start < range.start || run.start >= range.end() {
            frame.next += 1;
            continue;
        }
        if !run.deleted_by.contains(operation_id) {
            run.deleted_by.push(operation_id.clone());
        }
        frame.ancestors = Some((run.replaces.clone(), 0));
    }
}
