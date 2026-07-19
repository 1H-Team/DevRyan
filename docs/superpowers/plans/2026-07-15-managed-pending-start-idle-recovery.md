# Managed pending-start idle recovery implementation plan

1. Add a focused plugin test that registers a managed start without executing it, verifies direct work stays pending, emits `session.idle`, and expects direct work to resume.
2. Run the focused test and confirm the missing lifecycle cleanup fails.
3. Add the smallest event-driven cleanup to the managed-orchestration plugin.
4. Run focused tests, affected validation, full validation, and the production build.
5. Exercise the actual plugin hooks in a controlled runtime/visual harness and preserve evidence that idle recovery releases the orphan without weakening a live start.
