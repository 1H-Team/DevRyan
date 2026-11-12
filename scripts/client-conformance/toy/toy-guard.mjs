// Harness-owned toy guard (self-test corpus of the client conformance
// harness): a family of its own whose entry is also a port of the flow toy,
// the way a store API between two engine families is.
let checks = 0;

export function guardState() {
  return { checks };
}

export function guard(status) {
  checks += 1;
  return status === 'aborted' ? 'blocked' : status;
}

// A gate this family opens: a waiter of another family that it releases was released by no input of that family.
export function deferred() {
  let open = null;
  const promise = new Promise((resolve) => { open = resolve; });
  return { promise, open: (value) => { open(value); return true; } };
}
