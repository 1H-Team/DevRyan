// The planted bugs of the Rust scheduler core (run by
// scheduler-core-planted-bugs.mjs in this folder): data only, so the native
// contract test checks every planting site without loading the harness.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const CRATE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** The scenarios the plants are judged on; the unchanged build reproduces each whole. */
export const PLANT_SCENARIOS = Object.freeze(['F1-fanout-1', 'F1-fanout-8', 'F1-fanout-8-same-prompt', 'F2-fanout-64-roots', 'F3-running-then-16', 'duplicate-after-start', 'F5-slow-save', 'F4-failures-and-submits', 'F7-restart-recovery', 'restart-mixed crash at save 9 durable']);

/** One bug each: [id, file under src, exact text, replacement, `<scenario>:<check or rule>` that must catch it]. */
export const PLANTED_BUGS = Object.freeze([
  ['lease-delay-plus-one', 'core.rs', 'let delay = js_max(0.0, due_at - self.now()?);', 'let delay = js_max(0.0, due_at - self.now()? + 1.0);', 'F1-fanout-1:value'],
  ['stall-delay-minus-one', 'core.rs', 'const PERSISTENCE_STALL_MS: f64 = 300_000.0;', 'const PERSISTENCE_STALL_MS: f64 = 299_999.0;', 'F1-fanout-1:value'],
  ['save-skipped-on-submit', 'core.rs', '            if let Err(error) = s.persist_locked().await {\n                // await scheduler.js:641', '            if let Err(error) = jobs::value::<V, V>(V::Undef).await {\n                // await scheduler.js:641', 'F1-fanout-1:order'],
  ['save-added-on-update', 'core.rs', '            if let Err(error) = s.persist_locked().await {\n                // await scheduler.js:654', '            s.persist_locked().await?;\n            if let Err(error) = s.persist_locked().await {\n                // await scheduler.js:654', 'F1-fanout-1:order'],
  ['lease-and-start-swapped', 'core.rs', '                let lease = s.call_fn(&s.create_lease_token, Vec::new())?;\n                let started = s.now()?;', '                let started = s.now()?;\n                let lease = s.call_fn(&s.create_lease_token, Vec::new())?;', 'F1-fanout-1:order'],
  ['launch-inside-the-lock', 'core.rs', '                s.schedule_starting_lease(&next)?;\n                admitted.borrow_mut().push(clone_task(&next));', '                s.schedule_starting_lease(&next)?;\n                s.launch_task(&clone_task(&next))?;\n                admitted.borrow_mut().push(clone_task(&next));', 'F1-fanout-8:order'],
  ['launch-one-job-late', 'core.rs', '            // finally, scheduler.js:2088-2095\n', '            // finally, scheduler.js:2088-2095\n            wait(V::Undef).await?;\n', 'F5-slow-save:order'],
  ['await-split-in-update', 'core.rs', '            s.tasks.borrow_mut().set(task_id(&next), next.clone());\n', '            s.tasks.borrow_mut().set(task_id(&next), next.clone());\n            wait(V::Undef).await?;\n', 'F3-running-then-16:order'],
  ['await-merged-in-pump', 'core.rs', '                Ok(promise) => promise.await, // await scheduler.js:2034', '                Ok(promise) => { let _ = promise; Ok(V::Undef) }', 'F1-fanout-1:order'],
  ['admission-retry-added', 'core.rs', '            if held == 0.0 {\n                s.clear_admission_retry()?;\n            }', '            s.set_timer(V::func("", |_| refuse("retry")), 5_000.0)?;\n            if held == 0.0 {\n                s.clear_admission_retry()?;\n            }', 'F1-fanout-1:order'],
  ['lease-drawn-twice', 'core.rs', '                let lease = s.call_fn(&s.create_lease_token, Vec::new())?;', '                let _ = s.call_fn(&s.create_lease_token, Vec::new())?;\n                let lease = s.call_fn(&s.create_lease_token, Vec::new())?;', 'F1-fanout-1:order'],
  ['created-at-clock-skipped', 'core.rs', '            record.set("createdAt", V::Num(s.now()?));', '            record.set("createdAt", V::Num(1_700_000_000_000.0));', 'F1-fanout-1:order'],
  ['publication-dropped-on-update', 'core.rs', '            if publish && s.tasks.borrow().has(&task_id(&next)) {', '            if !publish && s.tasks.borrow().has(&task_id(&next)) {', 'F1-fanout-1:order'],
  ['event-refs-not-shared', 'core.rs', '        event.get("properties").get("task").set("canonicalRefs", task.get("canonicalRefs"));\n', '', 'F1-fanout-1:case-bytes'],
  ['queue-order-reversed', 'core.rs', '        Ok(order) => order.partial_cmp(&0.0).unwrap_or(std::cmp::Ordering::Equal),', '        Ok(order) => 0.0f64.partial_cmp(&order).unwrap_or(std::cmp::Ordering::Equal),', 'F1-fanout-8:value'],
  ['duplicate-guard-off', 'core.rs', '                    return done(clone_task(&candidate));\n                }\n            }\n            if input.get("readOnly").truthy() {', '                    let _ = candidate;\n                }\n            }\n            if input.get("readOnly").truthy() {', 'duplicate-after-start:order'],
  ['lease-kept-on-acceptance', 'core.rs', '                    inner.clear_starting_lease(&id)?;\n', '', 'F3-running-then-16:order'],
  ['env-read-twice', 'core.rs', '                V::Bool(!env.is_str("0"))', '                let _ = host::ask(s.c, "env", vec![("site", Value::string("persistLocked")), ("name", Value::string("DEVRYAN_ORCHESTRATION_UNACKNOWLEDGED_EXPIRY"))]);\n                V::Bool(!env.is_str("0"))', 'F1-fanout-1:order'],
  ['snapshot-order-reversed', 'core.rs', '            order.partial_cmp(&0.0).unwrap_or(std::cmp::Ordering::Equal)\n        });\n        if let Some(error) = failed {\n            let _ = pol', '            0.0f64.partial_cmp(&order).unwrap_or(std::cmp::Ordering::Equal)\n        });\n        if let Some(error) = failed {\n            let _ = pol', 'F1-fanout-8:value'],
  ['submit-settles-uncloned', 'core.rs', '            done(clone_task(&committed.unwrap_or(task)))', '            done(committed.unwrap_or(task))', 'F1-fanout-1:case-bytes'],
  ['terminal-publication-dropped', 'core.rs', '            if s.tasks.borrow().has(&id) {\n                s.queue_task_publication(&next)?;', '            if !s.tasks.borrow().has(&id) {\n                s.queue_task_publication(&next)?;', 'F4-failures-and-submits:order'],
  ['finish-pumps-while-recovering', 'core.rs', '            if changed.get() && !s.recovering.get() {', '            if changed.get() {', 'F7-restart-recovery:order'],
  ['recovery-in-reverse', 'core.rs', '            sort_queue(&mut active)?;\n', '            sort_queue(&mut active)?;\n            active.reverse();\n', 'F7-restart-recovery:value'],
  ['relaunch-skipped', 'core.rs', '                    s.launch_task(&clone_task(&current))?;\n', '                    let _ = current;\n', 'F7-restart-recovery:order'],
  ['envelope-sequence-plus-two', 'core.rs', '.fold(0.0, |sequence, envelope| js_max(sequence, num(&envelope.get("sequence"), "sequence")))\n                        + 1.0;', '.fold(0.0, |sequence, envelope| js_max(sequence, num(&envelope.get("sequence"), "sequence")))\n                        + 2.0;', 'F4-failures-and-submits:value'],
  ['reconciliation-retry-delay-plus-one', 'core.rs', 'let timer = self.set_timer(callback, self.reconciliation_retry_ms)?;', 'let timer = self.set_timer(callback, self.reconciliation_retry_ms + 1.0)?;', 'restart-mixed crash at save 9 durable:value'],
]);

/** Each planting site must exist exactly once (a Rust-free check the native contract test runs). */
export function plantingProblems(read = (file) => readFileSync(path.join(CRATE, 'src', file), 'utf8')) {
  const problems = [];
  for (const [id, file, find] of PLANTED_BUGS) {
    const count = read(file).split(find).length - 1;
    if (count !== 1) problems.push(`${id}: ${file} holds the planting site ${count} times`);
  }
  return problems;
}
