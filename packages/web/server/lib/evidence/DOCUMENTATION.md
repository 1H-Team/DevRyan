# Turn evidence

This module owns the web host integration for optional Git-backed turn checkpoints.
It derives a stable primary repository from Git's common directory, stores the
per-project opt-in in project config, and subscribes to shared lifecycle events.

Checkpoint IDs are opaque at every route boundary. The module exposes read-only
list and diff operations plus explicit retention cleanup. It does not expose
refs or any restore, reset, apply, attribution, or revert capability.

Evidence is interval-based: user edits, external processes, and overlapping
sessions may be included. Capture failures become explicit gaps and never block
prompt delivery.
