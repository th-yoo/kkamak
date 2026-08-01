# Install verification

This is the procedure a maintainer runs, on a real machine, after pushing the
`0.4.0` tag, to prove the release is actually installable. It is a runbook,
not a report: nothing in this file has been executed as written. A green
`bun test` run proves the code is correct; it says nothing about whether
`claude plugin install` on a clean machine actually produces a working gate.
**Until every step below has been run for real, the release is unproven.**

## 0. Why this whole procedure runs against an isolated config, not your real one

Every step below runs with `CLAUDE_CONFIG_DIR` pointed at a fresh temp
directory instead of your real `~/.claude`. This is not optional isolation
for tidiness — running these steps against your live config is the actual
defect this section exists to prevent:

- **Duplicate installs writing the same sensor file.** A maintainer's own
  machine may already have kkamak registered another way (a `--plugin-dir`
  dev checkout, an internal fork under a different marketplace name). Adding
  `th-yoo/kkamak` as a *second* marketplace and installing a *second* plugin
  named `kkamak` beside it means two Stop hooks can end up appending to the
  same repo's `.km/gate-outcomes.ndjson` — corrupting whatever corpus that
  repo's sensor stream was building, silently.
- **The cleanup step reopens a live fail-open window.** Uninstalling (step 4)
  deletes the plugin's cache root — see the warning at the bottom of this
  file. Running that against your real config risks tripping it while a
  session you actually care about is running. Running it against a temp
  directory that gets `rm -rf`'d wholesale has no such risk.

Verified live: `CLAUDE_CONFIG_DIR=$(mktemp -d) claude plugin marketplace list`
prints "No marketplaces configured" while the real config (no override) lists
several — confirming `CLAUDE_CONFIG_DIR` genuinely re-roots plugin state
rather than merely namespacing part of it.

A maintainer verifying a release must never risk the install they work in to
do it. Set the override once, for the whole procedure:

```bash
export CLAUDE_CONFIG_DIR=$(mktemp -d)
echo "Isolated config: $CLAUDE_CONFIG_DIR"
```

Run every command below, and the Claude Code session in step 3, in that same
shell / with that same `CLAUDE_CONFIG_DIR` exported — every path in this
runbook is now rooted there, not at `~/.claude`.

## 1. Install

Prerequisite: `bun` on `PATH` (see README "Install" for why this matters —
hook processes inherit whatever environment launched Claude Code).

```bash
claude plugin marketplace add th-yoo/kkamak
claude plugin install kkamak@kkamak
```

**What success looks like:** both commands exit without an error message.
`claude plugin marketplace add` reports the marketplace was added;
`claude plugin install` reports the plugin was installed at version `0.4.0`.
If either command instead reports "not found" or a network/auth error, stop
here — the release is not installable and nothing below will make sense.

## 2. Cache verification — prove the running copy is the new one

Installing is a copy, not a live reference: the installed plugin lives under
`$CLAUDE_CONFIG_DIR/plugins/cache/`, in a directory tree keyed by
marketplace name and plugin name. Verified live against a fresh
`CLAUDE_CONFIG_DIR`: `.claude-plugin/marketplace.json`'s `name` field is
`kkamak`, and a real `marketplace add` + `install` against an isolated,
otherwise-empty config produces exactly
`$CLAUDE_CONFIG_DIR/plugins/cache/kkamak/kkamak/0.4.0/` — no hedging needed
on that path, since isolation (step 0) also means there is no pre-existing
`kkamak-local` or other dev registration under this same `CLAUDE_CONFIG_DIR`
to collide with it.

Confirm exactly one version directory exists (more than one here would mean
this "fresh" config directory wasn't actually fresh — reuse of a stale temp
dir from an earlier run, for instance):

```bash
ls -d "$CLAUDE_CONFIG_DIR/plugins/cache/kkamak/kkamak/"*/
```

This must print exactly one path, ending in `/0.4.0/`.

Confirm the files this release adds are present in that one version
directory (these are new in `0.4.0`; their absence would mean the cache
somehow holds a pre-0.4.0 copy despite the version string). Capture the
directory step 2 already confirmed rather than retyping the version segment:

```bash
KK=$(ls -d "$CLAUDE_CONFIG_DIR/plugins/cache/kkamak/kkamak/"*/ | head -1)
ls "$KK/src/cli/init-cli.ts" "$KK/commands/init.md"
```

Both must exist.

## 3. Live block proof

This proves the installed copy is actually wired into a Claude Code session
and produces a real block — not just that files were copied.

```bash
mkdir -p /tmp/kkamak-install-check
cd /tmp/kkamak-install-check
git init -q
echo '{ "check": "exit 1", "rounds": 1 }' > gate.json
```

Run a Claude Code turn rooted at `/tmp/kkamak-install-check`, under the same
isolated `CLAUDE_CONFIG_DIR` (`claude -p` is the simplest way to drive one
turn non-interactively for this check — e.g.
`CLAUDE_CONFIG_DIR="$CLAUDE_CONFIG_DIR" claude -p "create scratch.txt with the word hi in it"`
run from `/tmp/kkamak-install-check`). Because `check` is `exit 1`, it can
never pass: you should see the turn blocked, with the check's failure output
handed back to the agent, on the first attempt.

**A single blocked attempt writes no sensor line.** The gate only appends a
line once a cycle *resolves* — cleanly, or by exhaustion — never on an
in-budget block; with `rounds: 1` the first failure is exactly one in-budget
block, so nothing is written yet and `.km/gate-outcomes.ndjson` does not
exist after it. Since this check can never pass, let the agent retry: it will
be blocked once, then fail again on the retry, and that second failing check
is what exhausts the `rounds: 1` budget and finally writes the line. Confirm
you've seen two failed attempts (one block, then the exhaustion notice)
before checking the file:

```bash
cat /tmp/kkamak-install-check/.km/gate-outcomes.ndjson
```

Check the last line: `"gateExhausted"` must be `true` and `"rounds"` must
list two `"verify-failed"` entries. `"accepted"` will read `true` here too —
that field means "the stop was ultimately allowed through" (exhaustion always
ends by allowing the stop), not "the check passed"; no code path ever writes
`"accepted": false`, so it is not useful as a failure signal on its own.
`"pluginVersion"` must read `"0.4.0"` — that field is the durable proof that
the session ran the copy this release installed, not a leftover older one.

## 4. Cleanup

Because everything above lived under the isolated `CLAUDE_CONFIG_DIR` and
the scratch repo, cleanup is a single `rm -rf` of each — no
`claude plugin uninstall` needed, and nothing on your real config was ever
touched:

```bash
rm -rf /tmp/kkamak-install-check
rm -rf "$CLAUDE_CONFIG_DIR"
unset CLAUDE_CONFIG_DIR
```

## Warning: reinstalling while a session is live

This warning is about your *real* config, not the isolated one this runbook
uses — it's why step 0 isolates in the first place. Reinstalling (or running
`claude plugin marketplace update` + reinstall) against your real
`~/.claude` deletes the plugin's cache root and replaces it. Any Claude Code
session that is live at that moment has its hook process's files pulled out
from under it mid-session; kkamak fails open by design, so that session's
gate goes silently inert rather than erroring visibly. Do not reinstall
against your real config while a Claude Code session you care about is still
running — finish or close it first.
