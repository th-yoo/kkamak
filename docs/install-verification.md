# Install verification

This is the procedure a maintainer runs, on a real machine, after pushing the
`0.4.1` tag, to prove the release is actually installable. It is a runbook,
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
`claude plugin install` prints no version — verified live, its actual output
is `Successfully installed plugin: kkamak@kkamak (scope: user)`. Don't expect
a version number here; step 2's cache path is the real proof of which
version landed. If either command instead reports "not found" or a
network/auth error, stop here — the release is not installable and nothing
below will make sense.

## 2. Cache verification — prove the running copy is the new one

Installing is a copy, not a live reference: the installed plugin lives under
`$CLAUDE_CONFIG_DIR/plugins/cache/`, in a directory tree keyed by
marketplace name and plugin name. Verified live against a fresh
`CLAUDE_CONFIG_DIR`: `.claude-plugin/marketplace.json`'s `name` field is
`kkamak`, and a real `marketplace add` + `install` against an isolated,
otherwise-empty config produces exactly
`$CLAUDE_CONFIG_DIR/plugins/cache/kkamak/kkamak/0.4.1/` — no hedging needed
on that path, since isolation (step 0) also means there is no pre-existing
`kkamak-local` or other dev registration under this same `CLAUDE_CONFIG_DIR`
to collide with it.

Confirm exactly one version directory exists (more than one here would mean
this "fresh" config directory wasn't actually fresh — reuse of a stale temp
dir from an earlier run, for instance):

```bash
ls -d "$CLAUDE_CONFIG_DIR/plugins/cache/kkamak/kkamak/"*/
```

This must print exactly one path, ending in `/0.4.1/`.

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

**The isolated-config auth problem applies on Linux too — verified live.**
`CLAUDE_CONFIG_DIR` re-roots credential lookup, not just plugin/marketplace
state: a fresh, isolated config has no `.credentials.json` of its own, so
`claude auth status` under it reports `loggedIn: false` / `authMethod: none`,
and a `claude -p` turn dies before it ever reaches the model. Seed the real
credential into the isolated dir before running this step:

```bash
install -m 600 ~/.claude/.credentials.json "$CLAUDE_CONFIG_DIR/.credentials.json"
```

**Do not use a symlink here, and do not expect the copy to stay fresh.**
A symlink was tried and measured: it survives only until the first token
refresh, because Claude Code refreshes by unlinking and rewriting rather
than writing through the link — after which the isolated dir silently holds
a plain, frozen copy. Observed on a session left running overnight: the
isolated credential stopped at one refresh while the real one moved on
seven hours later. Either way the seeded credential goes stale when the
real one rotates, so re-seed before a run rather than assuming a long-lived
isolated config still authenticates.

**Also required, and easy to miss: onboarding.** Even with credentials
resolving, an isolated config with no onboarding record runs the
onboarding/login flow instead of the `claude -p` prompt. Seed that too:

```bash
printf '%s' '{"hasCompletedOnboarding":true}' > "$CLAUDE_CONFIG_DIR/.claude.json"
```

**Pre-check both, before spending a turn.** `claude auth status` is
token-free — it prints JSON and exits `0` (logged in) or `1` (not) — so it
catches a missing credential or missing onboarding record before any model
turn is spent:

```bash
CLAUDE_CONFIG_DIR="$CLAUDE_CONFIG_DIR" claude auth status
```

Confirm `loggedIn: true` and a real `authMethod` before proceeding. If this
fails, fix the seeding above rather than going on to debug a `claude -p` turn
that was never going to reach the model.

**What this pre-check does NOT prove — measured.** It reports presence, not
validity: a seeded credential whose `expiresAt` has already passed still
reports `loggedIn: true` and exits `0`. Verified directly — an isolated
config holding a credential that expired nine hours earlier passed this
check, while the real config's credential had refreshed since. So a green
`auth status` rules out a *missing* or *unseeded* credential, which is what
it is here for, and rules out nothing about an *expired* one. If the check
passes and the turn still dies before reaching the model, compare
`expiresAt` in the seeded file against now, and re-seed.

**macOS limitation, confirmed:** this step cannot complete on macOS under the
isolated `CLAUDE_CONFIG_DIR` from step 0, even with the seeding above —
macOS has no `.credentials.json` on disk to seed from; the credential lives
only in the Keychain. On macOS, skip to the **Container variant** below
instead, which handles this by exporting the Keychain credential explicitly
into the container.

```bash
mkdir -p /tmp/kkamak-install-check
cd /tmp/kkamak-install-check
git init -q
echo '{ "check": "exit 1", "rounds": 1 }' > gate.json
```

Run a Claude Code turn rooted at `/tmp/kkamak-install-check`, under the same
isolated `CLAUDE_CONFIG_DIR` (`claude -p` is the simplest way to drive one
turn non-interactively for this check). **`--permission-mode acceptEdits` is
required, not optional:** headless `claude -p` has no human to approve tool
calls, so without it the `Write` is auto-denied, no edit is ever made, the
gate never arms, and no sensor line gets written — which reads as a broken
release rather than what it actually is, a missing flag.

```bash
CLAUDE_CONFIG_DIR="$CLAUDE_CONFIG_DIR" claude -p \
  "create scratch.txt with the word hi in it" \
  --permission-mode acceptEdits
```

Run from `/tmp/kkamak-install-check`. Because `check` is `exit 1`, it can
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
`"pluginVersion"` must read `"0.4.1"` — that field is the durable proof that
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

## Container variant (proven) — full model-driven proof on a clean Linux machine

Run this instead of step 3 on macOS (see the limitation noted there), or
whenever you want the strongest form of this proof: a real Claude Code agent
turn, on a genuinely clean Linux machine, with no host toolchain to
accidentally lean on. **Proven live**, not just authored: kkamak 0.4.0
blocked a real agent turn on a clean `ubuntu:24.04` container — the agent
tried to end its turn, was blocked, retried, was blocked again, and the
second failure exhausted the `rounds: 1` budget and wrote a sensor line with
`gateExhausted: true`, two `"verify-failed"` entries in `rounds`, and
`pluginVersion: "0.4.0"` — the same evidence step 3 above describes, produced
by an actual model turn instead of a human driving `claude` interactively.

Uses this project's own podman pattern (persistent container: create with
`sleep infinity`, `start`, `exec` per step, `rm -f -t 0` at the end — see
`meta-harness/opencode-plugin/src/bench/sandbox.ts`'s `buildCreateArgv` if
you have that repo checked out; not required to run this). Installs *only*
what's needed to test the documented install path — the README's one stated
prerequisite (`bun`) plus what it takes to get the `claude` CLI itself —
never the maintainer's own pre-built toolchain image, so the run actually
exercises what a stranger's clean machine needs.

```bash
export PATH=/opt/podman/bin:$PATH   # wherever your podman lives; adjust or omit
podman machine start                # if not already running

NAME=kkamak-install-proof
podman rm -f -t 0 "$NAME" 2>/dev/null
podman create --name "$NAME" --init -e IS_SANDBOX=1 \
  docker.io/library/ubuntu:24.04 sleep infinity
podman start "$NAME"
podman exec "$NAME" mkdir -p /app
```

**Auth mounts — the corrected, proven recipe.** This project already has
this exact recipe for a different purpose (`prepareClaudeCodeAuth` in
`meta-harness/opencode-plugin/src/bench/agent-auth.ts`); use it as written,
don't improvise from doc comments alone as an earlier pass at this runbook
did (that attempt mounted only `.credentials.json` read-only and got the
onboarding file's contents wrong — both looked reasonable and both broke the
proof). The two mounts that actually work:

1. **`/root/.claude`, the whole directory, read-write, not read-only, and not
   just the one file.** Claude Code rotates its oauth refresh token and
   writes settings during a session; a read-only mount fails silently once
   the session runs past the first few seconds. On macOS there is no
   `.credentials.json` on disk — auth is Keychain-only — so export it into a
   throwaway directory and mount that:

   ```bash
   TMPROOT=$(mktemp -d "${TMPDIR:-/tmp}kkamak-cc-auth-XXXXXX")
   chmod 700 "$TMPROOT"
   CLAUDE_DIR="$TMPROOT/claude"
   mkdir -p "$CLAUDE_DIR" && chmod 700 "$CLAUDE_DIR"
   security find-generic-password -s "Claude Code-credentials" -w > "$CLAUDE_DIR/.credentials.json"
   chmod 600 "$CLAUDE_DIR/.credentials.json"
   ```

   The refresh token the container rotates to is discarded, not written back
   to the Keychain — fine for one proof run, not a durable credential store.
   On Linux, skip the export and mount the real `~/.claude` directly.

2. **`/root/.claude.json`, read-only, containing exactly
   `{"hasCompletedOnboarding":true}`.** This is Claude Code's headless
   first-run gate — a fresh config with no onboarding record fails before
   ever reaching the model. Nothing else belongs in this file: putting an
   `oauthAccount` blob here (the earlier, wrong attempt) produces
   "configuration file is corrupted", not a working session.

   ```bash
   printf '%s' '{"hasCompletedOnboarding":true}' > "$TMPROOT/claude.json"
   chmod 600 "$TMPROOT/claude.json"
   ```

Recreate the container with both mounts (the whole `.claude` dir rw, the
onboarding file ro), plus `-e IS_SANDBOX=1` — Claude Code requires that env
var to accept `--dangerously-skip-permissions` while running as the
container's root user:

```bash
podman rm -f -t 0 "$NAME"
podman create --name "$NAME" --init \
  -v "$CLAUDE_DIR:/root/.claude" \
  -v "$TMPROOT/claude.json:/root/.claude.json:ro" \
  -e IS_SANDBOX=1 \
  docker.io/library/ubuntu:24.04 sleep infinity
podman start "$NAME"
podman exec "$NAME" mkdir -p /app
```

Install only `bun` (the README's stated prerequisite) and what it takes to
get the `claude` CLI — nothing else:

```bash
podman exec -w /app "$NAME" bash -c \
  'apt-get update -qq && apt-get install -y -qq curl ca-certificates git unzip'
podman exec -w /app "$NAME" bash -c 'curl -fsSL https://bun.sh/install | bash'
podman exec -w /app "$NAME" bash -c 'curl -fsSL https://claude.ai/install.sh | bash'
```

`podman exec` doesn't source `.bashrc`, so pass `PATH` explicitly on every
following exec:

```bash
CPATH="/root/.local/bin:/root/.bun/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"
podman exec -e PATH="$CPATH" -w /app "$NAME" claude plugin marketplace add th-yoo/kkamak
podman exec -e PATH="$CPATH" -w /app "$NAME" claude plugin install kkamak@kkamak
podman exec -e PATH="$CPATH" -w /app "$NAME" bash -c \
  'ls -d /root/.claude/plugins/cache/kkamak/kkamak/*/'
```

Then the scratch repo with a check that can never pass, same as step 3:

```bash
podman exec -e PATH="$CPATH" -w /app "$NAME" bash -c '
  mkdir -p /root/kkamak-check && cd /root/kkamak-check
  git init -q && git config user.email t@t.com && git config user.name t
  echo "{ \"check\": \"exit 1\", \"rounds\": 1 }" > gate.json
'
```

And the real agent turn — `--dangerously-skip-permissions` is required (the
container has no human to approve tool calls) alongside `IS_SANDBOX=1`
(already set at container-create time above):

```bash
podman exec -e PATH="$CPATH" -w /root/kkamak-check "$NAME" \
  claude -p "Create a file named scratch.txt containing the word hi, then finish." \
  --dangerously-skip-permissions
```

Expect the agent to try, get blocked, try again, and get exhausted — read
the sensor line the same way step 3 does:

```bash
podman exec -e PATH="$CPATH" "$NAME" cat /root/kkamak-check/.km/gate-outcomes.ndjson
```

`gateExhausted: true`, `rounds` listing two `"verify-failed"` entries,
`pluginVersion: "0.4.1"`.

**Cleanup — shred the credential export, then remove the container:**

```bash
SIZE=$(stat -f%z "$CLAUDE_DIR/.credentials.json" 2>/dev/null || stat -c%s "$CLAUDE_DIR/.credentials.json")
printf '0%.0s' $(seq 1 "$SIZE") > "$CLAUDE_DIR/.credentials.json"
rm -rf "$TMPROOT"
podman rm -f -t 0 "$NAME"
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
