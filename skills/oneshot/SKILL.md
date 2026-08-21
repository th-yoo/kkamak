---
name: oneshot
description: Use when about to do an edit-then-verify loop with a check command (e.g. running tests after a fix) and you want to retry failures inside one Bash call instead of paying a round trip per attempt. Batches edits + gate.json's check + in-process retry into a single script.
---

# oneshot

kkamak's completion gate already runs your `gate.json` `check` command when
you try to end a turn. `oneshot` lets you run that same check earlier,
inside one `Bash` tool call, and retry on failure without ending the turn —
so a failing check costs you an in-script retry, not a full round trip.

There is no new trust boundary here: the script runs through the same
unsandboxed `Bash` tool you already have. This is purely a way to spend
fewer round trips on the same edit-verify loop you would do anyway.

## When to use this

You are about to make an edit and then check whether it passes — a fix
followed by `bun test`, a change followed by a lint run, anything the
repo's `gate.json` already checks. If you expect the first attempt might
not pass and you would just retry with a small correction, do that inside
one script instead of across several tool calls.

## How to use it

1. Note the "Base directory for this skill: ..." line reported when this
   skill loaded — call it `PLUGIN_ROOT`. **Never** write the literal token
   `${CLAUDE_PLUGIN_ROOT}` into the script below — it does not resolve in a
   plain shell subprocess, only inside a Claude Code command body.
2. Read this repo's `gate.json` and note its `rounds` value. The attempt
   bound you pass to the template is `rounds + 1` — matching the gate's own
   semantics exactly (`rounds=2` means up to 3 total checks before giving
   up, not 2).
3. Copy `PLUGIN_ROOT/template.sh`'s contents (see that file — it is the
   canonical script, do not retype it from memory) into one `Bash` tool
   call. Replace the `# --- EDITS ---` / `# --- end EDITS ---` block with
   your real edit commands. Fill in `$1` (PLUGIN_ROOT) and `$2`
   (`rounds + 1`) as literal arguments, or as the first two lines of the
   script if you prefer not to pass them positionally.
4. Run it as a single `Bash` call. Exit 0 means the check passed within the
   attempt budget; exit 1 means it did not. Either way, the last JSON line
   printed carries `{ok, output}` from the most recent attempt — read
   `output` if `ok` is `false` to see what still needs fixing.
5. If it exits 1, you have real information about what is still wrong —
   fix it and either run `oneshot` again or fall back to the normal
   edit/Stop-hook cycle. Nothing about `oneshot` prevents that fallback.

## What this does not do

- It does not sandbox or restrict your edits — `api`-style capability
  discipline does not apply here, because you already have unrestricted
  `Bash`.
- It does not change the Stop-hook gate's own round budget. An in-script
  retry here is a separate counter from the gate's own `GateState.round` —
  using `oneshot` and still hitting the gate's block on a later `Stop` is
  expected, not a bug.
- It is not required. This is a cost-saving option, not a rule.
- Total wall-clock is not capped by `oneshot` itself — a runaway in-script
  loop is only bounded by the `Bash` tool's own call timeout, the same way
  any other long `Bash` call would be. Pass an explicit timeout to the
  `Bash` tool call if you want a tighter bound than its default.
