# Install verification

This is the procedure a maintainer runs, on a real machine, after pushing the
`0.4.0` tag, to prove the release is actually installable. It is a runbook,
not a report: nothing in this file has been executed as written. A green
`bun test` run proves the code is correct; it says nothing about whether
`claude plugin install` on a clean machine actually produces a working gate.
**Until every step below has been run for real, the release is unproven.**

## 1. Install

Prerequisite: `bun` on `PATH` (see README "Install" for why this matters —
hook processes inherit whatever environment launched Claude Code).

```bash
claude plugin marketplace add th-yoo/kkamak
claude plugin install kkamak@kkamak
```

**What success looks like:** both commands exit without an error message.
`claude plugin marketplace add` reports the marketplace was added (or that it
already exists, if this is a re-run); `claude plugin install` reports the
plugin was installed at version `0.4.0`. If either command instead reports
"not found" or a network/auth error, stop here — the release is not
installable and nothing below will make sense.

## 2. Cache verification — prove the running copy is the new one

Installing is a copy, not a live reference: the installed plugin lives under
`~/.claude/plugins/cache/`, in a directory tree keyed by marketplace name and
plugin name (`.claude-plugin/marketplace.json`'s `name` field is `kkamak`, so
expect a path shaped like `~/.claude/plugins/cache/kkamak/kkamak/0.4.0/` —
confirm the actual marketplace-name segment on the machine you're running
this on rather than assuming it, since this exact segment has not been
observed from a real marketplace-based install).

Confirm exactly one version directory exists for the plugin (a stale prior
version left behind by a previous install would mean the running copy is
ambiguous):

```bash
ls -d ~/.claude/plugins/cache/*/kkamak/*/
```

This must print exactly one path, ending in `/0.4.0/`. More than one means an
old version is still cached — remove it before trusting the result of step 3.

Confirm the files this release adds are present in that one version
directory (these are new in `0.4.0`; their absence would mean the cache still
holds a pre-0.4.0 copy despite the version string):

```bash
ls ~/.claude/plugins/cache/*/kkamak/0.4.0/src/cli/init-cli.ts
ls ~/.claude/plugins/cache/*/kkamak/0.4.0/commands/init.md
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

Open a Claude Code session rooted at `/tmp/kkamak-install-check`. Edit any
file in the repo (creating one is enough — `echo hi > scratch.txt`), then try
to end the turn. Because `check` is `exit 1`, it can never pass: you should
see the turn blocked, with the check's failure output handed back to the
agent, on the first attempt.

Confirm the sensor line recorded the cycle:

```bash
cat /tmp/kkamak-install-check/.km/gate-outcomes.ndjson
```

Check the last line: `"accepted"` should be `false` (or `"gateExhausted":true`
once `rounds: 1` is spent), and `"pluginVersion"` must read `"0.4.0"` — that
field is the durable proof that the session ran the copy this release
installed, not a leftover older one.

## 4. Cleanup

```bash
rm -rf /tmp/kkamak-install-check
```

## Warning: reinstalling while a session is live

Reinstalling (or running `claude plugin marketplace update` + reinstall)
deletes the plugin's cache root and replaces it. Any Claude Code session that
is live at that moment has its hook process's files pulled out from under it
mid-session; kkamak fails open by design, so that session's gate goes
silently inert rather than erroring visibly. Do not reinstall while a Claude
Code session you care about is still running — finish or close it first.
