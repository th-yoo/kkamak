# kkamak kernel — design

Date: 2026-07-30
Status: approved (layout, rounds semantics, sensor schema confirmed by user)
Scope: harness-abstract core only. Harness adapters are the next step, explicitly out of scope here.

## Purpose

kkamak gates an agent's "done" behind a real check. A session becomes *gated* when a file is
edited; when the agent tries to stop, the configured check runs; if it fails the stop is blocked
and the check's output is handed back as evidence; after a bounded number of retry rounds the
gate gives up and lets the session through.

This step builds that logic as a pure kernel with zero harness imports, so both Claude Code and
opencode can drive it through one contract.

## Architecture

Three layers inside a single self-contained package root (the repo root — copying this directory
out of the repo yields a working plugin):

```
src/
  kernel/        PURE. No fs, no child_process, no os, no harness. Zero non-relative imports.
    ports.ts       adapter contract: events in, decisions out, port interfaces
    config.ts      parseGateConfig(raw) — pure text -> config
    state.ts       GateState shape, INITIAL_STATE, validation
    sensor.ts      buildSensorLine(...)
    gate.ts        createGate(host) — the state machine
    index.ts       public surface
  runtime/       Node/Bun implementations of the ports (node:fs, node:child_process, node:os).
  adapters/      NEXT STEP. Harness glue. Empty for now.
```

The kernel performs no I/O itself. Every effect arrives as an injected port, which is what makes
the state machine testable without a filesystem, a subprocess, or a harness.

## Adapter contract

Events in — the adapter normalizes harness payloads into three neutral events. The kernel never
sees a harness-shaped payload, a tool name, or a hook name:

```ts
type GateEvent =
  | { kind: "file-edited";     sessionId: string }
  | { kind: "stop-requested";  sessionId: string }
  | { kind: "new-user-prompt"; sessionId: string }
```

Deciding *which* harness tool counts as a file edit is adapter business (Claude Code's
`Edit`/`Write`/`MultiEdit`/`NotebookEdit` vs. opencode's equivalents). That mapping does not
belong in, and will not appear in, the kernel.

Decisions out — exactly two kinds:

```ts
type GateDecision =
  | { kind: "allow"; notice?: string }
  | { kind: "block"; evidence: string; round: number; roundsMax: number }
```

`evidence` is the check's raw output, nothing more. Framing prose ("not done: the check failed…")
is the adapter's job, because each harness delivers blocks differently. `notice` carries the
allow-path messages that still need to reach the user: gate exhausted, gate disarmed.

Ports the host must supply:

```ts
interface GateHost {
  info:   { app: string; host: string }   // app = harness id; kernel must never hardcode it
  config: { read(): string | undefined }  // raw gate.json text, re-read per event
  state:  { load(id): GateState; save(id, s): void }
  sensor: { append(line: SensorLine): void }
  check:  { run(cmd: string, timeoutMs: number): Promise<{ code: number; output: string }> }
  clock:  { now(): number }
  logger: { log(msg: string): void }
}

createGate(host: GateHost): { handle(event: GateEvent): Promise<GateDecision> }
```

`app` being a host field rather than a kernel constant is the single most important departure
from the previous implementation, which hardcoded `app: "claude-code"` inside its sensor builder.

## Config

`gate.json` at the repo root:

```json
{ "check": "bun test", "rounds": 2 }
```

`check` is required and must be a non-empty string; anything else yields `undefined`, which
no-ops the gate. Defaults: `rounds` 2, `sensor` `.km/gate-outcomes.ndjson`, `checkTimeoutMs`
300000.

`handle()` calls `host.config.read()` once at the top of **every** event and threads the result
down. The kernel holds no config field and no cache, so caching is impossible by construction
rather than by discipline. This is the escape hatch: editing or deleting `gate.json` takes effect
on the next turn with no restart. `rounds: 0` is legal and means observe-only — the first failure
records a line and allows.

## State machine

Per-session state:

```ts
interface GateState {
  v: 1
  edited: boolean          // a file was edited this session
  gating: boolean          // a gate cycle is open
  round: number            // blocks issued in the open cycle
  outcomes: ("passed" | "failed")[]
  cycleStartedAt: number
  errorStreak: number      // consecutive internal errors
  disarmed: boolean        // session gave up on itself; allow everything
  updatedAt: number
}
```

Transitions:

- **disarmed** — any event returns `allow` immediately.
- **file-edited** — arm (`edited = true`) if the config is valid; otherwise leave state alone, so
  a repo with no `gate.json` accumulates no state.
- **new-user-prompt** — if no cycle is open, state passes through unchanged (this is what lets
  `edited` survive ordinary turns). If a cycle *is* open the human has preempted it: record an
  interrupted sensor line, reset to initial (clearing `edited` — stand down completely), allow.
- **stop-requested**:
  1. Not armed (`!edited && !gating`) → `allow`. No check runs, so non-gated sessions pay nothing.
  2. Config missing or invalid → `allow`; if a cycle was open, reset the cycle but keep `edited`.
  3. Run the check.
     - It threw (spawn failure, not a test failure) → `errorStreak + 1`, no round consumed,
       `allow`. At 3, set `disarmed` and allow with a notice.
     - Exit 0 → sensor line `accepted: true, gateExhausted: false`, reset, `allow`.
     - Nonzero and `round < rounds` → open/continue the cycle, `block` with the output as
       evidence.
     - Nonzero and rounds spent → sensor line `accepted: true, gateExhausted: true`, reset,
       `allow` with a notice.

`rounds: 2` means **two blocks, third failure allows** — three check runs total. This matches the
installed v0.2.0 semantics so sensor data stays comparable across versions.

## Sensor record

Append-only NDJSON at `.km/gate-outcomes.ndjson`, one line per completed gate cycle:

```ts
interface SensorLine {
  ts: number
  sessionId: string
  check: string
  accepted: boolean
  gateExhausted: boolean
  interrupted: boolean
  rounds: ("passed" | "failed")[]
  durationMs: number
  host: string
  app: string
}
```

`gateExhausted` and `interrupted` are included beyond the eight core fields because without them
`accepted: true` is ambiguous: check-passed, rounds-exhausted, and user-preempted would be
indistinguishable, which defeats the record's purpose. Outcome strings are `passed`/`failed`
rather than v0.2.0's `accepted`/`verify-failed` — a deliberate, documented rename in a new file.

## Error handling — fail-open everywhere

The gate must never wedge a session. Concretely:

- `handle()` wraps everything in a catch-all that logs and returns `allow`.
- Port failures are contained individually: a throwing `state.save` or `sensor.append` must not
  change the decision that was already computed.
- A corrupt, absent, or wrong-shaped state file reads back as fresh initial state.
- Three consecutive internal errors disarm the gate for the rest of the session. Unlike v0.2.0,
  which merely reset state (so the next edit re-armed and the failure repeated), `disarmed` is
  persisted and terminal for that session.

## Self-containment

Installation copies the package directory out of the repo, so an import that escapes the package
root — or a runtime dependency from `node_modules` — breaks the installed plugin while passing
tests in-repo. Two static import-scan tests enforce this:

1. **Kernel purity:** no file under `src/kernel/` may import anything that is not a relative
   path resolving inside `src/kernel/`. No `node:*`, no bare specifiers, no `../` escapes.
2. **Package containment:** across `src/` and `test/`, every import is either relative and
   inside the package root, or on a tiny allowlist of things guaranteed present at runtime
   (`node:*` builtins, `bun:test`).

## Testing

Ports are faked in-memory, so the state machine is tested with no filesystem and no subprocess:
a scripted check runner, a counting config source (proves per-event re-read), a map-backed state
store, an array sensor sink, and a fixed clock. Coverage targets the transitions above plus the
fail-open matrix (every port throwing, in turn, still yields `allow`), the two import-scan tests,
and round-trip tests for config parsing and sensor lines.
