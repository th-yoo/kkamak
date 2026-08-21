# oneshot — design

Date: 2026-08-21
Status: draft, pending user review (this file) and cross-lane review (meta-harness lane-B, checkpoint 1)
Scope: new, isolated component only. The existing hook-gate (kernel/adapters/runtime for
Stop/PostToolUse/UserPromptSubmit) is explicitly out of scope and must not change.

## Purpose

`oneshot`: one guest JS program per model turn, run host-side, that batches shell edits and
inline check-verification into a single MCP tool call. Rejections are absorbed inside the guest
program's own execution — the model sees the failure and can retry before the turn ends, instead
of paying a full round trip per attempt. The verifier is kkamak's own `check` command, the same
one the Stop-hook gate already runs; `oneshot` does not invent a new completion signal, it moves
an existing one earlier and lets a model consume it in-program.

This is a genuinely new component, not a bend of the hook-gate path — kkamak's hook adapters have
no tool-call mediation surface (Claude's tool calls never route through kkamak). `oneshot` ships
as its own MCP server, additive, OFF by default.

## Non-goals (explicitly unclaimed, stated up front per this repo's claim-hygiene rule)

- **Not a sandbox.** The guest's Bun Worker is a thread boundary, not a security boundary. A
  guest already has `api.bash`, i.e. full shell access at the user's privilege — the same trust
  level kkamak's `check` command already carries. `oneshot` adds no new trust boundary; it moves
  existing trust earlier in the turn.
- **Not staged/committed edits.** `api.bash` mutates the working tree immediately. There is no
  claim-commit model here (unlike the meta-harness lab's `code-mode-gate`, which stages typed
  claims and commits only on verify-pass). `api.check()` gates the *completion signal returned to
  the model*, not the edit — architecturally identical to what the Stop-hook already does, just
  inline. Naming reflects this: no function is called "commit."
- **No typed `Verifier<C,S>`.** The effect gate is `gate.json`'s existing shell `check`,
  literally. A pluggable typed-claim verifier is a real future extension point (see Open
  Questions) but is not built here — kkamak has no typed-claim concept today and inventing one
  now, with no consumer, is exactly the scope-creep class this repo's audits exist to catch.
- **Actuation is unmeasured here too.** Whether a real model consumes in-program steering (vs.
  giving up and ending the turn on first failure) is not something this design proves. The lab's
  own prior is 1/8. `oneshot` prices the mechanism; it does not claim actuation works until a
  measured fixture says so (see Testing).

## Architecture

New top-level directory, isolated from the existing gate:

```
src/
  kernel/        UNCHANGED. Zero imports from oneshot/.
  runtime/       UNCHANGED except: check-runner.ts's SpawnCheckRunner is imported BY oneshot/
                 (one-directional — runtime/ gains no knowledge of oneshot/).
  adapters/      UNCHANGED. Zero imports from oneshot/.
  oneshot/       NEW. Everything below lives here.
    mcp-server.ts    stdio MCP server, registers one tool: oneshot(program: string)
    runtime.ts       Bun Worker orchestration: spawn, RPC dispatch, enumerated fail-closed caps
    guest-shell.ts   worker-side entry: sets up api.bash / api.check, runs the guest program
    verifier.ts      runCheck(cwd) -> { ok, output } — thin wrapper over SpawnCheckRunner
    types.ts         FailureCode, Verdict, GuestApi shapes
```

An executable guard test (`oneshot/isolation.test.ts`, grep-based like the lab's
`agnostic.test.ts`) asserts no file under `kernel/` or `adapters/` imports anything from
`oneshot/`. This is a real check that fails if the import is added, not a comment — per this
repo's rule that a check must be built to prove it can fail, not just read as absent.

## Config

New optional block in `gate.json`, absent = disabled (matches the existing "no gate.json = inert"
convention — config-gated inertness, not a runtime toggle):

```json
{
  "check": "bun test",
  "rounds": 2,
  "oneshot": {
    "enabled": false,
    "check": null,
    "timeoutMs": null,
    "outputCapBytes": 65536,
    "pendingCallCap": 16
  }
}
```

- `enabled` (default `false`) — the only thing that turns `oneshot` on. Never implied by
  installing the plugin or by `mcpServers` being declared in `plugin.json`.
- `check` / `timeoutMs` (default `null`) — when unset, `oneshot` reuses the top-level `check` /
  `checkTimeoutMs`. One config source for what "passing" means; no drift between the inline gate
  and the Stop-hook gate unless the user deliberately splits them.
- `outputCapBytes`, `pendingCallCap` — hard caps on guest output size and in-flight RPC calls,
  ported from the lab's enumerated-failure-code design.

## Guest API

```ts
interface GuestApi {
  bash(cmd: string): Promise<{ code: number; output: string }>
  check(): Promise<{ ok: boolean; output: string }>
}
```

Two calls only for v1. No `api.commit` — there is nothing to commit (see Non-goals). A guest
probing for more finds nothing: authorization by object identity (only these two functions are
reachable from guest scope), not by a name-based allowlist.

## Data flow

1. Claude calls MCP tool `oneshot({ program })`.
2. `mcp-server.ts` reads `gate.json`. If `oneshot.enabled` is not `true`, returns a `CONFIG_DISABLED`
   verdict immediately — no worker spawned, nothing silently active.
3. A Bun Worker is spawned running `guest-shell.ts` with `program` as the guest source.
4. The guest calls `api.bash(...)` any number of times (each one real shell execution, cwd = repo
   root, same semantics as `SpawnCheckRunner`'s spawn) and `api.check()` any number of times.
5. Each `api.check()` runs `verifier.ts`'s `runCheck`, which shells out to the configured `check`
   command exactly as the Stop-hook gate does today. `{ ok: false, output }` is returned into the
   guest program as its return value — this *is* the steering; no separate steering object.
6. The guest may retry (edit again, check again) inside its own execution, bounded by
   `timeoutMs` (watchdog), `outputCapBytes`, and `pendingCallCap`.
7. When the guest returns, errors, or hits a cap, the Worker is torn down and the MCP tool call
   returns one result to Claude: final verdict, failure code if any, last check output.

## Failure codes (enumerated, fail-closed)

| Code | Trigger | Result |
|---|---|---|
| `CONFIG_DISABLED` | `oneshot.enabled` not `true` | no worker spawned |
| `TIMEOUT` | guest execution exceeds `timeoutMs` | worker killed, treated as non-passing |
| `OUTPUT_CAP_EXCEEDED` | combined `bash`/`check` output exceeds `outputCapBytes` | worker killed |
| `PENDING_CALL_CAP_EXCEEDED` | more than `pendingCallCap` concurrent RPCs in flight | worker killed |
| `GUEST_THROWN` | guest program throws | reported, worker torn down cleanly |
| `WORKER_CRASHED` | worker thread dies unexpectedly | reported as non-passing |

None of these grant any privilege on the way out — a capped/killed run is always reported as
not-passing, never silently treated as success.

## Testing

Oracle set (must pass):
- honest program: one `bash` edit, one `check()` that passes → verdict ok, one tool call, one
  worker spawn.
- in-turn retry: `check()` fails once (fixture check command that fails on first invocation,
  passes on second — no `Date.now()`-relative timing, a stateful fixture script instead), guest
  retries `bash` + `check()` inside the same program, second `check()` passes → verdict ok,
  **one** MCP tool call total (the retry must not cost a round trip — this is the property the
  whole design exists to buy, and it must be a test, not a claim).

Bad set (must fail closed, one fixture per failure code above):
- `oneshot.enabled` absent → `CONFIG_DISABLED`, no worker process observed.
- guest with an infinite loop → `TIMEOUT`.
- guest that `bash`-prints past the cap → `OUTPUT_CAP_EXCEEDED`.
- guest that fires more concurrent `bash` calls than `pendingCallCap` → `PENDING_CALL_CAP_EXCEEDED`.
- guest that throws → `GUEST_THROWN`, worker torn down (no zombie process left — assert on
  process table, not just the returned verdict).
- isolation guard: `kernel/`/`adapters/` importing from `oneshot/` fails the grep-guard test
  (built by temporarily adding such an import in the test fixture and asserting the guard catches
  it — per this repo's rule to build the input that should break a check, not just read the
  check's source).

## README

The current line "kkamak has no command of its own beyond that: it reads `gate.json` and runs
whatever `check` it names" becomes inaccurate the moment this ships and must be rewritten in the
same change — not left stale. New scope statement: kkamak is "a completion gate, plus an
experimental, OFF-by-default `oneshot` component that lets Claude batch edit+verify steps inline
using the same check command." Installation/trust-model sections gain a paragraph: `oneshot`'s
`api.bash` carries the same unsandboxed trust as the `check` command already does — read a
repo's `gate.json` before enabling `oneshot` in it, same as you would its `check`.

## Versioning

Any merge touching `src/oneshot/`, `mcp-server.ts` registration in `plugin.json`, or the
`gate.json` schema bumps `plugin.json`'s version in the same change (the version-keyed plugin
cache serves stale code otherwise — prior incident). `gate.json`/`KKAMAK_DEV_CHECKS` drift guard
gets an entry for the new `oneshot` config block.

## Open questions (not blocking this design, flagged for later)

- Pluggable typed verifier (`Verifier<C,S>` seam) — real extension point once a production
  consumer of typed claims exists. Not built now (see Non-goals).
- Whether `mcpServers` registration in `plugin.json` needs to be conditional at the manifest
  level (vs. the tool-handler-level `CONFIG_DISABLED` check this design relies on) — needs
  verification against current Claude Code plugin-manifest behavior before implementation;
  flagged as a plan-time risk, not resolved here.
