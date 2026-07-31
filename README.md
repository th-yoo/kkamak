# kkamak

kkamak is a completion gate: it stops a coding agent from claiming a turn is done until a check you configure — usually your test suite — actually passes. It works with Claude Code and opencode.

## Configuration: `gate.json`

Drop a `gate.json` in the repo root. Every field but `check` is optional:

| field            | required | default                     | meaning |
|------------------|----------|------------------------------|---------|
| `check`          | yes      | —                            | Shell command to run as the completion check. A config with no non-empty `check` string disables the gate entirely (no-op). |
| `rounds`         | no       | `2`                          | How many failing checks the gate will block on before giving up. `rounds: 2` means: the first and second failing checks each produce a block, and the third failing check is allowed through. `rounds: 0` is observe-only — the check still runs and is recorded, but the very first failure is let through unblocked. |
| `sensor`         | no       | `.km/gate-outcomes.ndjson`   | Where outcome lines are appended, relative to the repo root. |
| `checkTimeoutMs` | no       | `300000` (5 minutes)         | Hard cap on one check run; a check that runs past this is killed and counted as a failed round. |
| `marker`         | no       | `false`                      | If `true`, a clean accept (not a block, not an exhausted give-up) also returns a hygiene notice — advisory text saying this cycle's check evidence is closed and should not be carried into unrelated work. Same-cycle only; nothing is persisted across sessions. |

Under Claude Code, keep `checkTimeoutMs` under 600000 (600s): the `Stop` hook in `hooks/hooks.json` has its own 600s timeout, and if that fires first, Claude Code kills the hook process before the gate ever gets to record a decision — fail-open still holds (no state written, no round consumed), but the check silently never gets its full configured time.

Example:

```json
{ "check": "bun test", "rounds": 2 }
```

Keep the check cheap. It runs every time the agent tries to finish a turn in which it edited a file — not just once at the end of a session — so a slow check is paid repeatedly.

`marker: true`'s hygiene notice is delivered by both adapters, each over the channel it already uses for a block: Claude Code's `Stop` hook returns `additionalContext` under `hookSpecificOutput` — the same field the reference implementation uses for its own hygiene marker, distinct from `systemMessage` (which only surfaces as a status line rather than feeding the model's context). opencode has no such hook return value, so it continues the session with an injected `[kkamak-gate]`-prefixed message, same as a block. In both adapters `notice` and `marker` are separate channels: `notice` is diagnostic and only ever logged/surfaced as a status line, `marker` only ever reaches the model's own context. It is also always recorded on the sensor line, independent of delivery.

## Installing — Claude Code

This repo is a Claude Code plugin: `.claude-plugin/plugin.json` is the manifest and `hooks/hooks.json` registers the three hooks (`PostToolUse` on edit tools, `UserPromptSubmit`, `Stop`), each invoking `bun src/adapters/claude-code/hook-cli.ts <EventName>`. There is no published marketplace listing yet (`package.json` is `"private": true`, and Claude Code's `plugin install` only pulls from a configured marketplace), so load this checkout directly instead:

- One session only: `claude --plugin-dir /path/to/kkamak` (repeatable flag; confirmed against `claude --help`).
- Persisted: symlink this checkout to `~/.claude/skills/kkamak`. `claude plugin init --help` documents that path as auto-loading next session as `kkamak@skills-dir` — but only for a plugin it scaffolds there itself, not one symlinked in, so confirm on first use: edit a file, end your turn, expect a block message on a failing check. Silence means it never loaded — indistinguishable from a passing check, since kkamak fails open.

## Installing — opencode

`src/adapters/opencode/plugin.ts` default-exports the plugin function opencode loads. Confirmed by reading opencode's own loader: it auto-loads any `.ts`/`.js` file it finds under a `plugin/`-or-`plugins/` directory — project-local (`.opencode/plugin/`) or global (`~/.config/opencode/plugin/`) — no config entry needed. There is no packaged distribution yet, so symlink (not copy) the adapter file into one of those directories:

```bash
ln -s /path/to/kkamak/src/adapters/opencode/plugin.ts .opencode/plugin/kkamak.ts
```

Confirmed by reading further into the loader: it imports whatever path the directory scan found exactly as given, without first resolving a symlink to its real path. Confirmed with a local Bun reproduction of that same mechanism: a module loaded that way still resolves its own relative imports against its real target directory, not the symlink's — so this checkout's internal imports keep working through the symlink. Not confirmed live: that opencode still expects this repo's exact plugin shape end to end. opencode has no blocking stop hook, so a block is delivered by continuing the session: the adapter injects a user message prefixed `[kkamak-gate]` carrying the check's output, rather than refusing the stop. Check this yourself on first use — edit a file and let opencode go idle; silence means the plugin never loaded, which looks exactly like a passing check since kkamak fails open.

## Delivery channels

`marker` and `notice` (see the `gate.json` table above and `GateDecision`'s doc comment) always deliver over separate, adapter-specific channels — never merged into one:

| adapter     | marker channel                                                    | notice channel |
|-------------|---------------------------------------------------------------------|-----------------|
| Claude Code | `hookSpecificOutput.additionalContext` on the `Stop` hook's response | `systemMessage` |
| opencode    | injected continuation prompt (`[kkamak-gate]`-prefixed, same mechanism a block uses) | logged only (stderr), never injected |

## Turning it off

The gate re-reads `gate.json` on every event and holds nothing in memory. Edit or delete it and the change applies on the very next turn — no restart, no reinstall.

The gate also disarms itself: if the check *cannot be run* (a spawn failure, not a failing test) three times in a row for a session, the gate gives up on that session and allows everything through for the rest of it, with a notice telling you to check the `check` command. A normal failing check does not count toward this — only a check the gate could not execute at all.

## The sensor file

Each completed gate cycle appends one JSON line to the sensor file (default `.km/gate-outcomes.ndjson`). Example, generated by driving the Claude Code hook CLI against a scratch repo:

```json
{"ts":1785388549418,"sessionID":"demo-session-1","check":"test -f .fail_once && rm .fail_once && exit 1 || exit 0","accepted":true,"gateExhausted":false,"interrupted":false,"rounds":["verify-failed","accepted"],"durationMs":42,"host":"yoo-dev","app":"claude-code","checkMs":[4,4],"marker":false,"pluginVersion":"0.3.0"}
```

Fields:

- `ts`, `sessionID`, `check`, `host`, `app` — identity and timing of the cycle.
- `accepted` — true whenever the stop was ultimately allowed through.
- `gateExhausted` — true when the `rounds` budget ran out rather than the check passing.
- `interrupted` — true whenever a new user prompt cut measurement short: preempting an open cycle, or (see `skippedStop`) arriving before one ever reached a stop.
- `rounds` — `"accepted"`/`"verify-failed"` per check attempt in the cycle.
- `durationMs` — whole-cycle wall time, including agent think time, subagent runs and human wait.
- `marker` — true iff this cycle injected the hygiene notice described in the `gate.json` table above: the `marker` config was on and the round was a clean accept. Always `false` on a block, an exhausted give-up, or an interrupted/skipped line, even with the config on. Same-cycle, same-session only — despite this field's name, nothing here is ever persisted or read back across sessions.
- `pluginVersion` — this kernel's own version (`package.json`'s `version`), stamped on every line. Optional on the downstream consumer's frozen contract, since a producer may be unable to determine its own version; this kernel always can, so it is never absent here.
- `checkMs` *(optional)* — per-round check execution time only, parallel to `rounds`. `durationMs` alone can't tell you what the check itself costs: an observed 420-second cycle contained a ~1-second check.
- `skippedStop` *(optional)* — present and `true` only on a diagnostic line: a queued user message consumed a turn boundary before a stop was ever delivered, so no check ran and `rounds` is empty. The session stays armed, so the next real stop still measures the accumulated edits. Without this field, that session would look identical to one with no edits at all.
- `forced` *(optional)* — true iff an env override forced this session's reinject arm. The downstream consumer's frozen contract scopes this to `KKAMAK_REINJECT`; this kernel has no reinject-arm mechanism at all, so it never sets this field today.

All optional fields may be absent from any given line; a consumer must tolerate that.

## Docs

Notable changes are tracked in [`CHANGELOG.md`](CHANGELOG.md).
