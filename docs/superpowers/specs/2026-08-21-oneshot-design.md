# oneshot — design

Date: 2026-08-21 (revision 2 — supersedes commit 1d0c487's MCP-server approach; struck entirely,
not deferred, see Revision note. 1d0c487 is kept in history as superseded-with-reason, not
deleted.)
Status: draft, pending user review (this file) and cross-lane review (meta-harness lane-B)
Scope: one skill + one small CLI helper. No new running component, no hook changes, no change to
the existing gate (kernel/adapters/runtime for Stop/PostToolUse/UserPromptSubmit).

## Revision note

Revision 1 of this file proposed an MCP server exposing a `oneshot(program)` tool with a narrow
guest API (`bash`, `check`), reasoning from the meta-harness lab's `code-mode-gate`, where
capability discipline (no guest commit capability) is load-bearing because the gate is the *only*
effect path.

That reasoning doesn't transfer to Claude Code: Claude already has unrestricted `Bash`. An MCP
tool sitting next to `Bash` restricts nothing — nothing stops Claude from ignoring it and running
`Bash` directly, so the "only surface" property that made the lab's discipline meaningful never
holds here. The lab's actual point — batch ops + inline verification in one execution so a
rejection is consumed without costing a round trip — is achievable with a plain script run through
the existing `Bash` tool. No worker, no RPC, no MCP server, no new plugin manifest surface.
MCP re-enters only for a host with no unrestricted exec tool, or a deliberate exclusive-surface
experiment — that's a lab/bench question, not a kkamak one.

## Purpose

`oneshot`: a skill that tells Claude, when it's about to do an edit-then-verify loop, to run one
script (one `Bash` tool call) that performs the edits, invokes `gate.json`'s own `check` command
inline, and retries *inside that same script execution* on failure — instead of making a separate
tool call (and paying a round trip) per attempt. The verifier is the same `check` command the
Stop-hook gate already runs; `oneshot` doesn't add a new completion signal, it lets Claude consume
the existing one earlier, in-script, if it chooses to.

## Non-goals

- **No new trust boundary.** The script runs via the same unsandboxed `Bash` tool Claude already
  has. `oneshot` adds no isolation and claims none.
- **No enforcement.** Nothing here makes Claude use `oneshot`, and nothing prevents bypass. If
  enforcement is ever wanted, that is the Stop-hook gate's job (already shipped) — `oneshot` is
  purely a cost-saving option Claude can pick up via its skill description, same as every other
  skill in this ecosystem.
- **No enable flag.** There is no running component to gate on/off (the earlier MCP design's
  `oneshot.enabled` config field is struck along with the server). A skill's trigger description
  is its only activation surface — consistent with how every other skill here works, not a special
  case for this one.
- **Actuation still unmeasured.** Whether Claude, given the skill, actually (a) picks it up for a
  suitable task and (b) consumes an in-script check failure by retrying rather than abandoning the
  script are both open, model-behavior questions — not something a unit test can prove. This
  design ships the mechanism and a protocol to measure both; it does not claim either happens
  until logged data says so (see Dogfood protocol).

## Components

```
skills/
  oneshot/
    SKILL.md       trigger description + instructions: when to reach for oneshot, how to
                    structure the script, how to read the structured result
    run-once.ts     bun CLI: reads gate.json, runs its `check` once (reusing the existing
                    SpawnCheckRunner + config-source, not reimplementing them), prints one JSON
                    line { ok, output } to stdout, exits 0 on ok / 1 on not-ok
```

`run-once.ts` imports from `runtime/` (read-only reuse of `SpawnCheckRunner` and the config
reader). Nothing under `kernel/`, `adapters/`, or `runtime/` imports from `skills/` — one
directional, enforced by a small grep-guard test (`skills/oneshot/isolation.test.ts`), built by
temporarily adding a violating import in the test fixture and asserting the guard catches it, not
just read as absent.

## Script contract (what `SKILL.md` instructs Claude to write)

A script that, in one `Bash` call:
1. performs the edit(s) for this attempt,
2. runs `bun "<resolved plugin root>/skills/oneshot/run-once.ts"` — the literal absolute path,
   inlined by Claude when it writes the script (see Path resolution below), never the
   `${CLAUDE_PLUGIN_ROOT}` token itself — capturing its JSON line,
3. on `ok: true` — proceeds to print the final structured result and exit 0,
4. on `ok: false` — prints `output` (this *is* the steering; no separate steering object), retries
   from step 1, bounded by `gate.json`'s `rounds` — same **configured value** as the Stop-hook
   gate reads, so there's one number to tune, but an **independent counter**: an in-script retry
   does not touch the Stop-hook gate's own per-session round state (`state.ts`/`GateState`). A
   script that burns 2 in-script rounds and still ends the turn with edits outstanding leaves the
   Stop-hook gate's own count untouched — the gate still gets its own full round budget afterward,
   unaffected by what `oneshot` did inside the turn.
5. on exhausting rounds — prints the final structured result with `ok: false` and exits 1.

Structured result (final line of stdout, so it survives in the `Bash` tool's captured output):

```json
{ "ok": true, "rounds": 2, "roundsMax": 2, "lastCheckOutput": "..." }
```

Total wall-clock is capped the same way any `Bash` call already is: the caller passes a timeout
to the `Bash` tool. `run-once.ts` itself still respects `gate.json`'s `checkTimeoutMs` per
attempt, same as the Stop-hook gate. No new timeout mechanism.

**Output truncation is `run-once.ts`'s job, not the `Bash` tool's.** A real test suite's stdout
can run to tens of KB; the `Bash` tool caps captured output, and if `run-once.ts`'s JSON marker
line lands past that cap it never reaches Claude at all — the same judge-window failure mode this
codebase has hit before, now with the *failing* tail as the part most likely to be cut. So
`run-once.ts` self-truncates its own `output` field before printing — keep the **tail** (~4000
chars; test-runner failures are almost always at the end), with an explicit in-band marker:
`"...[truncated N of M chars]..."` prepended. The JSON marker line is always short enough to
survive the `Bash` tool's own cap; truncation, when it happens, is visible in-band rather than
silently swallowed further upstream.

## Path resolution (confirmed constraint, not just a risk)

kkamak's own README already states it plainly: "`${CLAUDE_PLUGIN_ROOT}` only resolves inside a
Claude Code command body, not in a plain shell." A script spawned by the `Bash` tool *is* a plain
shell subprocess — if `SKILL.md` tells Claude to write a literal `${CLAUDE_PLUGIN_ROOT}` token
into the script body for that subprocess to expand at its own runtime, it resolves to empty and
`run-once.ts` is never found. This is confirmed from the existing artifact, not hypothetical.

The mechanism `commands/init.md` already relies on is different and safe: Claude Code substitutes
`${CLAUDE_PLUGIN_ROOT}` when it renders the command/skill *markdown* into context, before the
model ever writes a line of script — by the time the model reads `SKILL.md`, any
`${CLAUDE_PLUGIN_ROOT}` in that markdown text has already become a literal absolute path. So
`SKILL.md` must instruct Claude to **inline the resolved path as a literal string into the script
it writes**, never to re-emit the `${CLAUDE_PLUGIN_ROOT}` token for the spawned shell to expand.

**Plan-time verification task** (not resolved by this spec, flagged for the implementation plan):
confirm this rendering-time-substitution behavior empirically — load the skill in a real session
and check what literal text appears in context where `SKILL.md` names `run-once.ts`'s path —
before writing `SKILL.md`'s wording. If substitution does not occur the same way for skills as it
does for commands, `SKILL.md` needs an explicit alternative (e.g., a documented fixed install
path, or a small discovery step) instead.

## Dogfood protocol (measurement, not shipped code)

**The script must not be its own measurement instrument.** A script that self-logs
`separateCallAfterFailure` cannot see whether a *different, later* Bash call was made — that
happens outside the script's own process, after it has already exited. And the exact failure mode
under study — a script that abandons the retry loop instead of running it — is also the failure
mode most likely to skip writing an honest log line. Self-report is downstream of the behavior
being measured; it can corroborate, it cannot verify. Measurement has to come from outside the
measured artifact.

**Corrected against the real payload (rev 3):** Claude Code's `PostToolUse` hook carries
`tool_input` (what Claude asked to run) but not the tool's result — there is no `tool_response`
field to scan for output, confirmed against the official hooks reference (searched in full: zero
occurrences of `tool_response`/`tool_output`; the docs' own worked example for logging Bash calls
via `PostToolUse` extracts only `tool_input.command`, never a result). Rev 2's "scan the Bash
call's output for markers" cannot be built. Two independent, external sources replace it:

**Source 1 — `run-once.ts`'s own log write.** `run-once.ts` is fixed, host-authored code, not
something Claude's wrapper script controls or can suppress the honesty of. On every real
invocation it appends one line to `.km/oneshot-dogfood.ndjson` (same `NdjsonSensorSink`
convention the gate already uses), computed from the same real check result the gate itself
verifies against:

```json
{ "ts": ..., "ok": false, "output": "...(same tail-truncated field as the stdout marker)..." }
```

This is not the wrapper self-reporting a summary — it is a probe that fires whenever the helper
actually runs, regardless of whether the wrapper "wants" to be honest about it.

**Source 2 — the `PostToolUse` hook, extended to also match `Bash`** (currently
`Edit|MultiEdit|Write|NotebookEdit` only), reading `tool_input.command` — a real, documented
field — not to recover output, but to see the **command text itself**: a static count of how many
times that one call's command invokes `run-once.ts` (does the script Claude wrote even attempt a
retry loop, structurally), and, across consecutive `Bash` `PostToolUse` events in a session,
whether a *later, separate* call also invokes `run-once.ts` — the call-boundary information only
the hook has, since `run-once.ts`'s own log (Source 1) cannot tell which invocations happened
inside the same Bash call versus different ones.

**Correlating the two, per `Bash` call's time window** (that call's `PreToolUse` timestamp to its
`PostToolUse` timestamp):
- *retries-happened-in-script* = count of Source-1 log lines falling inside the window,
  cross-checked against the static invocation count from Source 2's command-text scan.
  **A mismatch — fewer real log lines than the command text's retry loop implies — is itself a
  finding** (the script crashed or exited mid-loop), reported as such, not discarded as noise.
- *steering-consumption* = within one window, the last Source-1 line's `ok` is `true` after at
  least one earlier `ok:false` line in the same window.
- *abandoned-retry* (separate call after failure) = a window whose last Source-1 line is
  `ok:false`, followed by the **next** `Bash` `PostToolUse` event in the same session whose
  command text also invokes `run-once.ts` — Claude made a fresh call instead of the first script
  retrying further.

This fixes **steering-consumption rate** — of windows that hit `ok:false` at least once, how many
resolve `ok:true` in the same window — from two sources genuinely outside the measured wrapper
script, neither of which the wrapper's own honesty can compromise.

**Adoption rate stays open**, honestly: both sources only produce rows for calls that *did*
invoke `run-once.ts`; a task where Claude skipped `oneshot` entirely produces no row and no
denominator. Closing that requires an externally-tracked task set (a human or a separate harness
records which tasks were `oneshot`-shaped before the run) — out of scope for this spec, named
here so it isn't silently assumed solved.

This is the actuation number the meta-harness lab explicitly left unmeasured (prior: 1/8). This
design does not inherit that number — it measures its own, from outside the artifact under test.

## Failure modes (script-level, translating the struck design's enumeration)

| Mode | Trigger | Result |
|---|---|---|
| check fails, rounds remain | `run-once.ts` → `ok:false` | script retries in-process, no new `Bash` call |
| rounds exhausted | last retry still `ok:false` | script prints `{ok:false,...}`, exits 1 |
| check exceeds `checkTimeoutMs` | per-attempt, same as Stop-hook gate | that attempt counts as `ok:false` |
| total wall-clock exceeded | script itself runs too long | `Bash` tool's own call timeout kills it — not this design's mechanism, documented not implemented |
| no `gate.json` / no `check` | `run-once.ts` finds nothing to run | clear error to stderr, exit 1, no silent success |

## Testing (automated)

Deterministic, so this is ordinary TDD, not the dogfood protocol above:
- `run-once.ts` against a passing check → `{ ok: true, output }`, exit 0.
- `run-once.ts` against a failing check → `{ ok: false, output }`, exit 1, `output` carries the
  check's real stdout/stderr.
- `run-once.ts` respects `checkTimeoutMs` (fixture check that runs past it → treated as failing,
  same as the Stop-hook gate's own timeout handling).
- `run-once.ts` with no `gate.json` → clear error, non-zero exit, no silent success.
- **the design-buying property, tested directly:** drive the script template (not a live model)
  against a stateful fixture check that fails on its first invocation and passes on its second —
  a real `.km`-local fixture script, not a `Date.now()`-relative timer. Assert `run-once.ts` is
  invoked twice (the retry happened) while the outer script runs as a single process from a
  single `Bash` call. This is "one Bash call, including the retry" made falsifiable — it is a
  property of the script template's control flow, independent of whether a live model ever writes
  such a script correctly (that part is the Dogfood protocol, below).
- isolation guard: fails when a violating import from `kernel/`/`adapters/`/`runtime/` into
  `skills/` is added to the fixture (built, not assumed).

## README

The line "kkamak has no command of its own beyond that: it reads `gate.json` and runs whatever
`check` it names" becomes inaccurate the moment this ships and is rewritten in the same change.
New scope statement: kkamak is "a completion gate, plus an `oneshot` skill that lets Claude batch
an edit-verify loop into one script instead of one round trip per attempt, using the same check
command and the same round budget the gate already enforces."

## Versioning

Any merge touching `skills/oneshot/` bumps `plugin.json`'s version in the same change (version-
keyed plugin cache serves stale code otherwise). No `gate.json` schema change in this revision, so
no drift-guard entry needed this time.
