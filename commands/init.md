---
description: Initialize kkamak gate.json with an auto-detected check command
---

# kkamak init — set up gate.json

> Token-free alternative: `bun "${CLAUDE_PLUGIN_ROOT:-.}/src/cli/init-cli.ts" [--check <cmd>] [--force] [--dry-run]` detects and writes gate.json with no model call. Use this command when you want the walkthrough instead.

You are setting up kkamak, a gate that runs a verification check when Claude finishes a turn in which it edited files. Follow these steps.

## Step 1: Detect the check command

Read the repo to find a cheap verification command, in this order:

1. `/package.json` in the current working directory — read its `scripts` object. Prefer `test`; accept `lint`, `check`, or a similar verification script.
2. A `bun.lock` file or an `@types/bun` dependency (the project uses Bun) — suggest `bun test` when no npm script fits.
3. Nothing detectable — skip to Step 4.

**Do not** scan Makefile, pyproject.toml, justfile, or other build systems. The token-free CLI does not either, and the two must agree.

## Step 2: Propose gate.json

Compose this structure:

```json
{
  "check": "<detected command>",
  "rounds": 2
}
```

Show it to the user in a code block. Explain briefly: this runs every time Claude finishes a turn that edited files, so it must be cheap — a fast test or lint run, seconds not minutes, never a full build or a deploy.

**Then ask:** "Approve this gate.json? (y/n)" and wait for the answer.

## Step 3: Write it (on approval only)

1. Write `gate.json` in the current working directory — the directory Claude Code was launched from, which is where the gate reads it from.
2. Offer: "Add `.km/` to your `.gitignore`? That is kkamak's runtime state and sensor log. (y/n)"
3. On yes, add `.km/` unless an exact line already says so.
4. Confirm: "gate.json written. The gate is active on your next turn."

If the user declines, stop and say so. Nothing is written.

## Step 4: Nothing detected

1. Say: "No check command detected in package.json or bun.lock."
2. Show the template:
   ```json
   {
     "check": "<your verification command here>",
     "rounds": 2
   }
   ```
3. Ask what command verifies their work (`npm test`, `make check`, `python -m pytest`, …), then continue from Step 2 with their answer.

## Notes

- Keep explanations short and practical.
- The gate fails open: if the check cannot be run at all, the turn is allowed through. Silence therefore looks exactly like a passing check — tell the user to confirm on first use by letting a failing check run.
- If the user wants to stop at any point, stop.
