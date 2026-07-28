---
name: linear
description: Manage issues, projects & team workflows in Linear. Use when the user wants to read, create or updates tickets in Linear.
metadata:
  short-description: Manage Linear issues in Codex
---

# Linear

## Overview

This skill provides a structured workflow for managing issues, projects & team workflows in Linear. It ensures consistent integration with the Linear MCP server, which offers natural-language project management for issues, projects, documentation, and team collaboration.

## Prerequisites
- Linear MCP server must be connected and accessible via OAuth
- Confirm access to the relevant Linear workspace, teams, and projects

## Required Workflow

**Follow these steps in order. Do not skip steps.**

### Step 0: Set up Linear MCP (if not already configured)

If any MCP call fails because Linear MCP is not connected, pause and set it up:

1. Add the Linear MCP:
   - `codex mcp add linear --url https://mcp.linear.app/mcp`
2. Enable remote MCP client:
   - Set `[features] rmcp_client = true` in `config.toml` **or** run `codex --enable rmcp_client`
3. Log in with OAuth:
   - `codex mcp login linear`

After successful login, the user will have to restart codex. You should finish your answer and tell them so when they try again they can continue with Step 1.

**Windows/WSL note:** If you see connection errors on Windows, try configuring the Linear MCP to run via WSL:
```json
{"mcpServers": {"linear": {"command": "wsl", "args": ["npx", "-y", "mcp-remote", "https://mcp.linear.app/sse", "--transport", "sse-only"]}}}
```

### Step 1
Gain a general understanding of the issue being reported. Clarify the user's goal and scope (e.g., issue triage, sprint planning, documentation audit, workload balance). Confirm team/project, priority, labels, cycle, and due dates as needed. 

### Step 2
If it is an issue related to the 1Health website that needs to be fixed, follow Step 2, if it is not an issue that needs to be fixed, skip to step 3. Investigate the issue in the repository and gain a good understanding of what the issue is, then make a plan that will me inserted in a code snippet on linear in .md format. 

Before creating the issue, assign the label/labels that make logical sense, and always ask these three questions: 
1. Who should this issue be assigned to? (first name alphabetical order, exclude: 1Health Team, Codex, Cursor, Linear) and Unassigned as the last option.
2. What project it should be added to. 
3. What's the priority for this issue (in order: No Priority, Urgent, High, Medium, Low).
Assign the label/labels that make logical sense.


Full structure:
Section 1: "User Story"
Use "User Story Template.md" file to inform yourself, then build it in this format: 
• As a: a user/admin/professional/clini

• I want: [Goal]

• So that: [Outcome]

Section 2: "Implementation Plan"
The plan must only be created if resolving the issue requires code changes in the onehealth-connector repository, and is only a part of the issue and must always be in a code snippet. The structure for plans must be the following:
"## Context

Explain why this change is being made — the problem or need it addresses, what prompted it, and the intended outcome. 1–2 short paragraphs.

## Critical files

**New files**
- `path/to/new/file.ext` — one-line purpose.

**Files modified**
- `path/to/existing/file.ext` — what changes and why.

**Files read (no edit) for behavior reuse**
