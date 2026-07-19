# Managed result tool-payload implementation plan

1. Add a failing plugin test showing a terminal preview and canonical references
   are serialized twice by `devryan_task wait`.
2. Add a small non-mutating model-output compactor at the bundled plugin
   serialization boundary, retaining mismatched fields fail-safely.
3. Document the result-envelope ownership rule in the default-config and managed
   orchestration module documentation.
4. Run the focused plugin/orchestration suites and repeat the deterministic
   maximum-preview payload measurement.
5. Exercise wait and continuation through the real DevRyan UI, then run the
   appropriate affected/full validation and build gates.
