# Cloudflare Managed Tunnel Token Normalization

## Problem

Cloudflare's dashboard copies connector credentials as complete shell commands, such as `cloudflared tunnel run --token <token>` or `cloudflared.exe service install <token>`. DevRyan currently trims the pasted value but otherwise treats it as a raw token. It therefore persists the complete command and writes it to cloudflared's token file, which cloudflared rejects as an invalid tunnel token.

Cloudflare configuration is already correct for the affected tunnel:

- `devryan.1health.ae` is a proxied Tunnel DNS record targeting the `Dev` tunnel.
- The published application route sends `devryan.1health.ae` to `http://localhost:49565`.

## Goals

- Accept raw Cloudflare managed-tunnel tokens.
- Accept standard Cloudflare commands copied for Windows, macOS/Linux, and Docker/manual execution.
- Persist and launch only the extracted raw token.
- Reject unrelated or ambiguous text deterministically.
- Never include credentials in logs, diagnostics, or error responses.
- Preserve existing raw-token behavior and all Cloudflare DNS/route settings.

## Design

Add a focused server-side token normalizer in the tunnels module. The normalizer will:

1. Trim surrounding whitespace.
2. Return a valid raw token unchanged.
3. Recognize supported Cloudflare command shapes and extract the token argument:
   - `cloudflared tunnel run --token <token>`
   - `cloudflared tunnel run --token=<token>`
   - `cloudflared service install <token>`
   - `cloudflared.exe service install <token>`
   - commands prefixed by common wrappers such as `sudo`, package-install chaining, or Docker invocation when they contain an unambiguous `--token` argument.
4. Handle a single layer of shell quoting around the token.
5. Reject missing, multiple, malformed, or unrelated candidates.

Normalization will run at authoritative server boundaries:

- Before managed-remote credentials are persisted.
- Before a request-supplied credential is selected for tunnel startup.
- Before a token is written to cloudflared's temporary token file as a final defense.

The UI remains a presentation layer. It may continue showing a password field, while the server guarantees correctness for Electron, web, VS Code-compatible callers, CLI/API use, and non-interactive requests.

## Validation and Errors

The parser will use strict token-shape validation rather than accepting arbitrary final command text. Invalid input will produce a deterministic validation error that explains that users may paste either a raw Cloudflare token or a dashboard-generated command. The error must not echo any submitted value.

Stored legacy values containing a recognized command will be normalized when resolved or started, allowing recovery without exposing or manually editing the stored secret.

## Tests

Focused server tests will cover:

- Raw token remains unchanged.
- macOS/Linux manual command extraction.
- macOS service-install command extraction.
- Windows service-install command extraction.
- `--token=<token>` extraction.
- Docker command extraction.
- Quoted token extraction.
- Surrounding whitespace.
- Rejection of unrelated text, missing tokens, and ambiguous multiple-token commands.
- Error and diagnostic redaction.
- Persisted and startup paths both receive only normalized tokens.

The implementation will follow red-green-refactor: add a failing regression test, verify the expected failure, implement the smallest normalizer and boundary wiring, then rerun focused and affected validation.

## End-to-End Visual Verification

After automated validation:

1. Build or run the updated DevRyan Electron app.
2. Open Settings → Remote Tunnel → Managed Remote.
3. Paste a freshly copied Cloudflare command into the saved `Dev` tunnel credential field.
4. Save and start the tunnel.
5. Visually verify DevRyan shows the active managed tunnel state and connect-link controls without exposing the token.
6. In Firefox, refresh Cloudflare's `Dev` tunnel overview and verify at least one active replica and a Healthy status.
7. Confirm the published route remains `devryan.1health.ae` → `http://localhost:49565`.

No DNS or route mutation is part of this change.

## Scope

This is a focused managed-tunnel credential fix. It does not redesign tunnel lifecycle management, modify Cloudflare DNS, add dependencies, or change the legacy Tauri shell.
