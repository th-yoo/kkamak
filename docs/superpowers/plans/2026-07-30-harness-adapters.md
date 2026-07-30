# kkamak Harness Adapters Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Drive the completed kernel from both Claude Code and opencode, so a session in either harness cannot claim "done" until the configured check passes.

**Architecture:** Each adapter translates its harness's native events into the kernel's three `GateEvent`s, wires a `GateHost` from `src/runtime`, and translates `GateDecision` back into its harness's delivery mechanism. The kernel is already written and must not be modified. The two harnesses differ fundamentally in how a block is delivered — Claude Code's `Stop` hook is synchronous and can refuse, while opencode's `session.idle` event cannot — so delivery is entirely the adapter's business and the kernel contract stays untouched.

**Tech Stack:** TypeScript on Bun. Claude Code adapter is a CLI reading hook JSON on stdin. opencode adapter is a plugin module exporting a `Plugin` function. No runtime dependencies.

## Global Constraints

- **Zero runtime dependencies.** `package.json` must keep an empty `dependencies`. Only `node:*` builtins and relative imports. `test/imports.test.ts` enforces this and must stay green.
- **Never modify `src/kernel/`.** The kernel is complete and reviewed. If an adapter seems to need a kernel change, stop and raise it instead of editing.
- **No import may escape the package root** (`/home/th-yoo/z2/kkamak`). Installation copies this directory out of the repo.
- **`@opencode-ai/plugin` types must NOT be imported.** It is not a dependency of this package and would break the installed plugin. Declare the minimal structural types the adapter needs locally, in `src/adapters/opencode/opencode-types.ts`.
- **Fail-open is absolute.** Every adapter entry point wraps its whole body in try/catch and, on any error, allows the session through with no output. A broken hook must never break a user's session.
- **Config is read per event by the kernel.** Adapters must not read or parse `gate.json` themselves.
- **Test command:** `bun test`. Typecheck: `bunx tsc --noEmit`. Both must pass before every commit.
- **Repo root** for `createNodeHost({ root, app })` is the directory containing `gate.json`. Claude Code supplies `cwd` in the hook payload; opencode supplies `worktree` in `PluginInput`.
- **`app` values are exactly** `"claude-code"` and `"opencode"`. These land in the sensor record; do not vary them.

---

## Key finding from research: the delivery asymmetry

Read this before starting. It is the reason Task 3 is shaped differently from Task 2.

**Claude Code** exposes a `Stop` hook that runs synchronously before the turn ends and can refuse it. Refusing is either exit code 2 with the reason on stderr, or exit 0 with `{"decision":"block","reason":"…"}` on stdout.

**opencode has no blocking stop hook.** Verified against the local checkout at `/home/th-yoo/z2/opencode/packages/plugin/src/index.ts`: the `Hooks` interface has no stop-like member, and `event?: (input: { event: Event }) => Promise<void>` returns void with no mutable output parameter. The relevant event is `session.idle`, shape confirmed in `packages/sdk/js/src/gen/types.gen.ts`:

```ts
export type EventSessionIdle = {
  type: "session.idle"
  properties: { sessionID: string }
}
```

So in opencode a "block" cannot refuse anything. It is delivered by *continuing* the session: the adapter injects a new user message carrying the evidence via the SDK client, which makes the agent keep working. `client.session.promptAsync(...)` is used rather than `client.session.prompt(...)` because `prompt` waits for the assistant to finish and we are calling it from inside an event handler, which would deadlock.

**The self-prompt trap.** That injected message will itself fire the `chat.message` hook, which this adapter maps to `new-user-prompt` — the event that *preempts an open gate cycle*. Left alone, the adapter would cancel the very cycle it just opened, and the gate would never reach round 2. The injected text therefore carries a marker that the `chat.message` handler recognises and ignores. Task 3 tests this explicitly; it is the single most likely bug in the whole step.

---

## File Structure

- `src/adapters/shared/framing.ts` — turns a `GateDecision` into user-facing text. Shared so both harnesses say the same thing. Owns evidence truncation.
- `src/adapters/claude-code/hook-input.ts` — parses and validates Claude Code hook JSON. Pure; no I/O.
- `src/adapters/claude-code/emit.ts` — maps a `GateDecision` to a Claude Code stdout/stderr/exit-code plan. Pure.
- `src/adapters/claude-code/hook-cli.ts` — the executable entry point. Reads stdin, wires the host, calls the kernel, emits.
- `src/adapters/opencode/opencode-types.ts` — minimal local structural types for the opencode plugin surface.
- `src/adapters/opencode/plugin.ts` — the opencode plugin module.
- `hooks/hooks.json`, `.claude-plugin/plugin.json` — Claude Code plugin manifests.
- `test/framing.test.ts`, `test/claude-code-adapter.test.ts`, `test/opencode-adapter.test.ts`, `test/packaging.test.ts` — tests.

---

### Task 1: Shared decision framing

The kernel returns raw check output as `evidence`. A human-facing message has to wrap it, and both harnesses should say the same thing.

**Files:**
- Create: `src/adapters/shared/framing.ts`
- Test: `test/framing.test.ts`

**Interfaces:**
- Consumes: `GateDecision` from `../../kernel/ports.ts`.
- Produces: `MAX_EVIDENCE_BYTES: number`, `composeBlockMessage(decision: Extract<GateDecision, {kind:"block"}>): string`, `truncateEvidence(evidence: string): string`.

- [ ] **Step 1: Write the failing test**

```ts
// test/framing.test.ts
import { describe, expect, test } from "bun:test"
import { composeBlockMessage, MAX_EVIDENCE_BYTES, truncateEvidence } from "../src/adapters/shared/framing.ts"

const block = (over: Partial<{ evidence: string; round: number; roundsMax: number }> = {}) =>
  ({ kind: "block" as const, evidence: "2 tests failed", round: 1, roundsMax: 2, ...over })

describe("composeBlockMessage", () => {
  test("says the work is not done", () => {
    expect(composeBlockMessage(block()).toLowerCase()).toContain("not done")
  })

  test("includes the check output verbatim", () => {
    expect(composeBlockMessage(block({ evidence: "FAIL src/a.test.ts" }))).toContain("FAIL src/a.test.ts")
  })

  test("states which round this is", () => {
    const message = composeBlockMessage(block({ round: 2, roundsMax: 3 }))
    expect(message).toContain("2")
    expect(message).toContain("3")
  })

  // The agent must fix the failure, not run the check itself — a second
  // concurrent run of the suite is wasted work and confuses the transcript.
  test("tells the agent not to run the check itself", () => {
    expect(composeBlockMessage(block()).toLowerCase()).toContain("do not run it yourself")
  })

  test("names the repository as the source of the check, not the assistant", () => {
    expect(composeBlockMessage(block()).toLowerCase()).toContain("gate.json")
  })

  test("truncates oversized evidence and says so", () => {
    const message = composeBlockMessage(block({ evidence: "x".repeat(MAX_EVIDENCE_BYTES * 2) }))
    expect(message.length).toBeLessThan(MAX_EVIDENCE_BYTES * 1.5)
    expect(message.toLowerCase()).toContain("truncated")
  })
})

describe("truncateEvidence", () => {
  test("leaves short evidence alone", () => {
    expect(truncateEvidence("short")).toBe("short")
  })

  test("keeps the tail, where a test runner puts its summary", () => {
    const evidence = `${"a".repeat(MAX_EVIDENCE_BYTES)}THE-SUMMARY`
    expect(truncateEvidence(evidence)).toContain("THE-SUMMARY")
  })

  test("caps the result", () => {
    const out = truncateEvidence("x".repeat(MAX_EVIDENCE_BYTES * 3))
    expect(out.length).toBeLessThanOrEqual(MAX_EVIDENCE_BYTES + 200)
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test test/framing.test.ts`
Expected: FAIL with `Cannot find module '../src/adapters/shared/framing.ts'`

- [ ] **Step 3: Write the implementation**

```ts
// src/adapters/shared/framing.ts
import type { GateDecision } from "../../kernel/ports.ts"

/** Hook payloads are size-limited, and a giant paste buries the useful part. */
export const MAX_EVIDENCE_BYTES = 16_000

type BlockDecision = Extract<GateDecision, { kind: "block" }>

/** Keeps the tail: a test runner's summary is at the end of its output. */
export function truncateEvidence(evidence: string): string {
  if (evidence.length <= MAX_EVIDENCE_BYTES) return evidence
  return `…output truncated, showing the last ${MAX_EVIDENCE_BYTES} characters…\n${evidence.slice(-MAX_EVIDENCE_BYTES)}`
}

export function composeBlockMessage(decision: BlockDecision): string {
  return [
    "not done: the repository's completion check failed.",
    "",
    truncateEvidence(decision.evidence),
    "",
    `This check is configured by the repository in gate.json and the gate runs it automatically when you finish, so do not run it yourself. Fix the failures above and end your turn. (Attempt ${decision.round} of ${decision.roundsMax}; after that the gate gives up and lets the turn through.)`,
  ].join("\n")
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `bun test test/framing.test.ts && bunx tsc --noEmit`
Expected: PASS, no type errors.

- [ ] **Step 5: Commit**

```bash
git add src/adapters/shared/framing.ts test/framing.test.ts
git commit -m "feat(adapters): shared block-message framing"
```

---

### Task 2: Claude Code adapter

**Files:**
- Create: `src/adapters/claude-code/hook-input.ts`
- Create: `src/adapters/claude-code/emit.ts`
- Create: `src/adapters/claude-code/hook-cli.ts`
- Create: `hooks/hooks.json`
- Create: `.claude-plugin/plugin.json`
- Test: `test/claude-code-adapter.test.ts`

**Interfaces:**
- Consumes: `createGate`, `GateDecision`, `GateEvent` from `../../kernel/index.ts`; `createNodeHost` from `../../runtime/index.ts`; `composeBlockMessage` from `../shared/framing.ts`.
- Produces:
  - `EDIT_TOOLS: readonly string[]` — `["Edit", "MultiEdit", "Write", "NotebookEdit"]`
  - `HOOK_EVENTS: readonly string[]` — `["PostToolUse", "UserPromptSubmit", "Stop"]`
  - `parseHookInput(raw: string, eventName: string): ParsedHookInput | undefined`
  - `type ParsedHookInput = { event: GateEvent; root: string }`
  - `type EmitPlan = { stdout?: Record<string, unknown>; stderr?: string; exitCode: 0 | 2 }`
  - `planEmit(decision: GateDecision): EmitPlan`

Background on the harness contract, so you do not have to go looking: Claude Code runs a hook as a subprocess and writes a JSON object to its stdin. Every payload carries `session_id`, `cwd`, and `hook_event_name`. `PostToolUse` additionally carries `tool_name`. A hook allows the action by exiting 0 with no stdout. A `Stop` hook refuses by exiting 0 and printing `{"decision":"block","reason":"…"}`. An informational message is `{"systemMessage":"…"}`. Manifests live at `.claude-plugin/plugin.json` and `hooks/hooks.json`, and `${CLAUDE_PLUGIN_ROOT}` expands to the installed plugin directory.

Note on `stop_hook_active`: Claude Code sets this to `true` on a `Stop` payload when the turn is already continuing because of a previous block. Deliberately ignore it — the kernel's own rounds budget is what guarantees termination, and honouring the flag would cap the gate at a single block regardless of the configured `rounds`. Add a comment saying so, or a future reader will "fix" it.

- [ ] **Step 1: Write the failing test**

```ts
// test/claude-code-adapter.test.ts
import { describe, expect, test } from "bun:test"
import { EDIT_TOOLS, HOOK_EVENTS, parseHookInput } from "../src/adapters/claude-code/hook-input.ts"
import { planEmit } from "../src/adapters/claude-code/emit.ts"

const payload = (over: Record<string, unknown> = {}) =>
  JSON.stringify({ session_id: "s-1", cwd: "/repo", hook_event_name: "Stop", ...over })

describe("parseHookInput", () => {
  test("maps Stop to stop-requested", () => {
    const parsed = parseHookInput(payload(), "Stop")
    expect(parsed).toEqual({ event: { kind: "stop-requested", sessionId: "s-1" }, root: "/repo" })
  })

  test("maps UserPromptSubmit to new-user-prompt", () => {
    const parsed = parseHookInput(payload({ hook_event_name: "UserPromptSubmit" }), "UserPromptSubmit")
    expect(parsed?.event.kind).toBe("new-user-prompt")
  })

  test.each(EDIT_TOOLS)("maps PostToolUse on %s to file-edited", (tool) => {
    const parsed = parseHookInput(payload({ tool_name: tool }), "PostToolUse")
    expect(parsed?.event.kind).toBe("file-edited")
  })

  // A non-editing tool must not arm the gate, even if the matcher lets it through.
  test.each(["Read", "Bash", "Grep", "edit", "WRITE"])("ignores PostToolUse on %s", (tool) => {
    expect(parseHookInput(payload({ tool_name: tool }), "PostToolUse")).toBeUndefined()
  })

  test.each([
    ["not JSON", "{oops", "Stop"],
    ["JSON that is not an object", "[]", "Stop"],
    ["a missing session_id", JSON.stringify({ cwd: "/repo" }), "Stop"],
    ["an empty session_id", payload({ session_id: "" }), "Stop"],
    ["a non-string session_id", payload({ session_id: 7 }), "Stop"],
    ["a missing cwd", JSON.stringify({ session_id: "s-1" }), "Stop"],
    ["an unknown event name", payload(), "Frobnicate"],
  ])("returns undefined for %s", (_label, raw, eventName) => {
    expect(parseHookInput(raw, eventName)).toBeUndefined()
  })

  test("declares exactly the three hooks the manifest registers", () => {
    expect([...HOOK_EVENTS].sort()).toEqual(["PostToolUse", "Stop", "UserPromptSubmit"])
  })
})

describe("planEmit", () => {
  test("a plain allow is silent and exits 0", () => {
    expect(planEmit({ kind: "allow" })).toEqual({ exitCode: 0 })
  })

  test("an allow with a notice reports it as a system message", () => {
    const plan = planEmit({ kind: "allow", notice: "gate exhausted" })
    expect(plan.exitCode).toBe(0)
    expect(plan.stdout).toEqual({ systemMessage: "gate exhausted" })
  })

  test("a block refuses the stop with the framed evidence as the reason", () => {
    const plan = planEmit({ kind: "block", evidence: "2 tests failed", round: 1, roundsMax: 2 })
    expect(plan.exitCode).toBe(0)
    expect(plan.stdout?.decision).toBe("block")
    expect(String(plan.stdout?.reason)).toContain("2 tests failed")
    expect(String(plan.stdout?.reason).toLowerCase()).toContain("not done")
  })

  test("emits JSON that survives a round trip", () => {
    const plan = planEmit({ kind: "block", evidence: "x", round: 1, roundsMax: 2 })
    expect(() => JSON.parse(JSON.stringify(plan.stdout))).not.toThrow()
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test test/claude-code-adapter.test.ts`
Expected: FAIL, module not found.

- [ ] **Step 3: Write `hook-input.ts`**

```ts
// src/adapters/claude-code/hook-input.ts
import type { GateEvent } from "../../kernel/ports.ts"

/** Claude Code tool names that count as editing a file, matched exactly. */
export const EDIT_TOOLS = ["Edit", "MultiEdit", "Write", "NotebookEdit"] as const

export const HOOK_EVENTS = ["PostToolUse", "UserPromptSubmit", "Stop"] as const

export interface ParsedHookInput {
  event: GateEvent
  root: string
}

/**
 * Returns undefined for anything unrecognised, which the CLI treats as "do
 * nothing, exit 0". An unparseable payload is not worth failing a session over.
 */
export function parseHookInput(raw: string, eventName: string): ParsedHookInput | undefined {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return undefined
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return undefined

  const record = parsed as Record<string, unknown>
  const sessionId = record.session_id
  const root = record.cwd
  if (typeof sessionId !== "string" || !sessionId) return undefined
  if (typeof root !== "string" || !root) return undefined

  switch (eventName) {
    case "Stop":
      return { event: { kind: "stop-requested", sessionId }, root }
    case "UserPromptSubmit":
      return { event: { kind: "new-user-prompt", sessionId }, root }
    case "PostToolUse": {
      const tool = record.tool_name
      if (typeof tool !== "string") return undefined
      if (!(EDIT_TOOLS as readonly string[]).includes(tool)) return undefined
      return { event: { kind: "file-edited", sessionId }, root }
    }
    default:
      return undefined
  }
}
```

- [ ] **Step 4: Write `emit.ts`**

```ts
// src/adapters/claude-code/emit.ts
import { composeBlockMessage } from "../shared/framing.ts"
import type { GateDecision } from "../../kernel/ports.ts"

export interface EmitPlan {
  stdout?: Record<string, unknown>
  stderr?: string
  exitCode: 0 | 2
}

/**
 * Blocks use the JSON form rather than exit-2-with-stderr: exit 2 is
 * indistinguishable from the hook itself crashing, and a crashing gate should
 * never look like an intentional refusal.
 */
export function planEmit(decision: GateDecision): EmitPlan {
  if (decision.kind === "block") {
    return {
      stdout: { decision: "block", reason: composeBlockMessage(decision) },
      exitCode: 0,
    }
  }
  if (decision.notice) {
    return { stdout: { systemMessage: decision.notice }, exitCode: 0 }
  }
  return { exitCode: 0 }
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `bun test test/claude-code-adapter.test.ts && bunx tsc --noEmit`
Expected: PASS.

- [ ] **Step 6: Write the CLI entry point**

No unit test for this file: it is I/O wiring over units already covered, and Task 4's packaging test asserts it exists and is referenced by the manifest.

```ts
// src/adapters/claude-code/hook-cli.ts
#!/usr/bin/env bun
/**
 * `bun hook-cli.ts <EventName>` — reads the Claude Code hook payload on stdin,
 * drives the kernel, and emits the decision.
 *
 * PRIME DIRECTIVE: a broken hook must never break a user's session. Every path
 * either stays silent and exits 0, or emits a decision the kernel asked for.
 */
import { createGate } from "../../kernel/index.ts"
import { createNodeHost } from "../../runtime/index.ts"
import { planEmit } from "./emit.ts"
import { parseHookInput } from "./hook-input.ts"

const APP = "claude-code"

async function readStdin(): Promise<string> {
  const chunks: Uint8Array[] = []
  for await (const chunk of process.stdin) chunks.push(chunk as Uint8Array)
  return Buffer.concat(chunks).toString("utf8")
}

async function main(): Promise<void> {
  const eventName = process.argv[2] ?? ""
  const parsed = parseHookInput(await readStdin(), eventName)
  if (!parsed) return

  const gate = createGate(createNodeHost({ root: parsed.root, app: APP }))
  const plan = planEmit(await gate.handle(parsed.event))

  if (plan.stdout) process.stdout.write(`${JSON.stringify(plan.stdout)}\n`)
  if (plan.stderr) process.stderr.write(plan.stderr)
  if (plan.exitCode !== 0) process.exit(plan.exitCode)
}

main().catch((err) => {
  // Silent on stdout: anything printed there is protocol. Exit 0 so a crash in
  // the gate is never mistaken for an intentional block.
  try {
    process.stderr.write(`kkamak: hook failed, allowing the session through: ${String(err)}\n`)
  } catch {
    // Nothing left to report with.
  }
  process.exit(0)
})
```

- [ ] **Step 7: Write the manifests**

```json
// .claude-plugin/plugin.json
{
  "name": "kkamak",
  "version": "0.3.0",
  "description": "kkamak completion gate — Claude Code cannot say done until your check passes"
}
```

```json
// hooks/hooks.json
{
  "hooks": {
    "Stop": [
      { "hooks": [{ "type": "command", "command": "bun \"${CLAUDE_PLUGIN_ROOT}/src/adapters/claude-code/hook-cli.ts\" Stop", "timeout": 600 }] }
    ],
    "PostToolUse": [
      { "matcher": "Edit|MultiEdit|Write|NotebookEdit", "hooks": [{ "type": "command", "command": "bun \"${CLAUDE_PLUGIN_ROOT}/src/adapters/claude-code/hook-cli.ts\" PostToolUse", "timeout": 30 }] }
    ],
    "UserPromptSubmit": [
      { "hooks": [{ "type": "command", "command": "bun \"${CLAUDE_PLUGIN_ROOT}/src/adapters/claude-code/hook-cli.ts\" UserPromptSubmit", "timeout": 30 }] }
    ]
  }
}
```

The `Stop` timeout is 600 seconds because it runs the user's whole check; the other two are bookkeeping only and get 30.

- [ ] **Step 8: Verify end to end by hand**

```bash
cd /tmp && rm -rf km-e2e && mkdir km-e2e && cd km-e2e
echo '{"check":"exit 1","rounds":1}' > gate.json
R=/home/th-yoo/z2/kkamak
echo '{"session_id":"e2e","cwd":"/tmp/km-e2e","hook_event_name":"PostToolUse","tool_name":"Write"}' | bun $R/src/adapters/claude-code/hook-cli.ts PostToolUse
echo '{"session_id":"e2e","cwd":"/tmp/km-e2e","hook_event_name":"Stop"}' | bun $R/src/adapters/claude-code/hook-cli.ts Stop
```

Expected: the first command prints nothing. The second prints one line of JSON containing `"decision":"block"`. Run the `Stop` command twice more: the third prints `systemMessage` with the exhausted notice, and `/tmp/km-e2e/.km/gate-outcomes.ndjson` then holds one line with `"gateExhausted":true` and `"app":"claude-code"`. Paste the actual output into your task report.

- [ ] **Step 9: Commit**

```bash
git add src/adapters/claude-code test/claude-code-adapter.test.ts hooks .claude-plugin
git commit -m "feat(adapters): Claude Code hook adapter"
```

---

### Task 3: opencode adapter

Read the "delivery asymmetry" section above first. This adapter cannot refuse anything; a block is delivered by injecting a continuation prompt.

**Files:**
- Create: `src/adapters/opencode/opencode-types.ts`
- Create: `src/adapters/opencode/plugin.ts`
- Test: `test/opencode-adapter.test.ts`

**Interfaces:**
- Consumes: `createGate` from `../../kernel/index.ts`; `createNodeHost` from `../../runtime/index.ts`; `composeBlockMessage` from `../shared/framing.ts`.
- Produces:
  - `EDIT_TOOLS: readonly string[]` — `["edit", "write", "patch", "multiedit"]`
  - `INJECTED_MARKER: string` — `"[kkamak-gate]"`
  - `isInjectedMessage(text: string): boolean`
  - `createKkamakPlugin(deps: PluginDeps): Promise<KkamakHooks>` — the testable core, taking its collaborators explicitly
  - `KkamakPlugin` — the default export shaped as opencode's `Plugin`

Design note: opencode identifies a tool by a lowercase id (`edit`, `write`, `patch`), unlike Claude Code's capitalised names. Match case-insensitively and keep the list in `EDIT_TOOLS` so the packaging test can assert a single source of truth. If a session's tool set turns out to differ, widen the list rather than loosening the match.

- [ ] **Step 1: Write the failing test**

```ts
// test/opencode-adapter.test.ts
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import {
  createKkamakPlugin,
  EDIT_TOOLS,
  INJECTED_MARKER,
  isInjectedMessage,
} from "../src/adapters/opencode/plugin.ts"

let dir: string

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "kkamak-oc-"))
})

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true })
})

function writeConfig(check: string, rounds = 2): void {
  fs.writeFileSync(path.join(dir, "gate.json"), JSON.stringify({ check, rounds }))
}

/** Records every prompt the adapter injects. */
function fakeClient() {
  const prompts: { id: string; text: string }[] = []
  return {
    prompts,
    session: {
      promptAsync: async (options: { path: { id: string }; body: { parts: { type: string; text: string }[] } }) => {
        prompts.push({ id: options.path.id, text: options.body.parts.map((p) => p.text).join("") })
        return { data: {} }
      },
    },
  }
}

async function plugin(check = "exit 1", rounds = 2) {
  writeConfig(check, rounds)
  const client = fakeClient()
  const hooks = await createKkamakPlugin({ client: client as never, worktree: dir })
  return { hooks, client }
}

describe("tool mapping", () => {
  test.each(EDIT_TOOLS)("an %s tool call arms the gate", async (tool) => {
    const { hooks, client } = await plugin()
    await hooks["tool.execute.after"]!({ tool, sessionID: "s1", callID: "c1", args: {} }, { title: "", output: "", metadata: {} })
    await hooks.event!({ event: { type: "session.idle", properties: { sessionID: "s1" } } })
    expect(client.prompts).toHaveLength(1)
  })

  test("tool ids are matched case-insensitively", async () => {
    const { hooks, client } = await plugin()
    await hooks["tool.execute.after"]!({ tool: "Edit", sessionID: "s1", callID: "c1", args: {} }, { title: "", output: "", metadata: {} })
    await hooks.event!({ event: { type: "session.idle", properties: { sessionID: "s1" } } })
    expect(client.prompts).toHaveLength(1)
  })

  test("a read-only tool does not arm the gate", async () => {
    const { hooks, client } = await plugin()
    await hooks["tool.execute.after"]!({ tool: "read", sessionID: "s1", callID: "c1", args: {} }, { title: "", output: "", metadata: {} })
    await hooks.event!({ event: { type: "session.idle", properties: { sessionID: "s1" } } })
    expect(client.prompts).toHaveLength(0)
  })
})

describe("block delivery", () => {
  test("injects a continuation prompt carrying the evidence", async () => {
    writeConfig("echo THE-FAILURE; exit 1")
    const client = fakeClient()
    const hooks = await createKkamakPlugin({ client: client as never, worktree: dir })

    await hooks["tool.execute.after"]!({ tool: "write", sessionID: "s1", callID: "c1", args: {} }, { title: "", output: "", metadata: {} })
    await hooks.event!({ event: { type: "session.idle", properties: { sessionID: "s1" } } })

    expect(client.prompts).toHaveLength(1)
    expect(client.prompts[0]!.id).toBe("s1")
    expect(client.prompts[0]!.text).toContain("THE-FAILURE")
    expect(client.prompts[0]!.text).toContain(INJECTED_MARKER)
  })

  test("a passing check injects nothing", async () => {
    const { hooks, client } = await plugin("exit 0")
    await hooks["tool.execute.after"]!({ tool: "write", sessionID: "s1", callID: "c1", args: {} }, { title: "", output: "", metadata: {} })
    await hooks.event!({ event: { type: "session.idle", properties: { sessionID: "s1" } } })
    expect(client.prompts).toHaveLength(0)
  })

  test("writes a sensor line tagged as opencode", async () => {
    const { hooks } = await plugin("exit 0")
    await hooks["tool.execute.after"]!({ tool: "write", sessionID: "s1", callID: "c1", args: {} }, { title: "", output: "", metadata: {} })
    await hooks.event!({ event: { type: "session.idle", properties: { sessionID: "s1" } } })

    const line = JSON.parse(
      fs.readFileSync(path.join(dir, ".km", "gate-outcomes.ndjson"), "utf8").trim(),
    ) as { app: string; accepted: boolean }
    expect(line.app).toBe("opencode")
    expect(line.accepted).toBe(true)
  })

  test("ignores events other than session.idle", async () => {
    const { hooks, client } = await plugin()
    await hooks["tool.execute.after"]!({ tool: "write", sessionID: "s1", callID: "c1", args: {} }, { title: "", output: "", metadata: {} })
    await hooks.event!({ event: { type: "session.updated", properties: { sessionID: "s1" } } as never })
    expect(client.prompts).toHaveLength(0)
  })
})

// The single most likely bug in this adapter: the injected prompt fires
// chat.message, which preempts the very cycle it just opened.
describe("the self-prompt trap", () => {
  test("recognises its own injected text", () => {
    expect(isInjectedMessage(`${INJECTED_MARKER} not done: …`)).toBe(true)
    expect(isInjectedMessage("please add a test")).toBe(false)
  })

  test("its own injected prompt does not cancel the open cycle", async () => {
    const { hooks, client } = await plugin("exit 1", 2)
    await hooks["tool.execute.after"]!({ tool: "write", sessionID: "s1", callID: "c1", args: {} }, { title: "", output: "", metadata: {} })
    await hooks.event!({ event: { type: "session.idle", properties: { sessionID: "s1" } } })
    expect(client.prompts).toHaveLength(1)

    // Replay opencode's own callback for the message the adapter just injected.
    await hooks["chat.message"]!(
      { sessionID: "s1" },
      { message: {} as never, parts: [{ type: "text", text: client.prompts[0]!.text }] as never },
    )

    // The cycle must still be open, so idling again blocks a second time.
    await hooks.event!({ event: { type: "session.idle", properties: { sessionID: "s1" } } })
    expect(client.prompts).toHaveLength(2)
  })

  test("a real human message does cancel the open cycle", async () => {
    const { hooks, client } = await plugin("exit 1", 2)
    await hooks["tool.execute.after"]!({ tool: "write", sessionID: "s1", callID: "c1", args: {} }, { title: "", output: "", metadata: {} })
    await hooks.event!({ event: { type: "session.idle", properties: { sessionID: "s1" } } })

    await hooks["chat.message"]!(
      { sessionID: "s1" },
      { message: {} as never, parts: [{ type: "text", text: "never mind, do something else" }] as never },
    )

    await hooks.event!({ event: { type: "session.idle", properties: { sessionID: "s1" } } })
    expect(client.prompts).toHaveLength(1) // stood down; no second block
  })
})

describe("fail-open", () => {
  test("a client that cannot inject does not throw out of the hook", async () => {
    writeConfig("exit 1")
    const hooks = await createKkamakPlugin({
      client: { session: { promptAsync: async () => { throw new Error("offline") } } } as never,
      worktree: dir,
    })
    await hooks["tool.execute.after"]!({ tool: "write", sessionID: "s1", callID: "c1", args: {} }, { title: "", output: "", metadata: {} })
    expect(
      hooks.event!({ event: { type: "session.idle", properties: { sessionID: "s1" } } }),
    ).resolves.toBeUndefined()
  })

  test("a repo with no gate.json is inert", async () => {
    const client = fakeClient()
    const hooks = await createKkamakPlugin({ client: client as never, worktree: dir })
    await hooks["tool.execute.after"]!({ tool: "write", sessionID: "s1", callID: "c1", args: {} }, { title: "", output: "", metadata: {} })
    await hooks.event!({ event: { type: "session.idle", properties: { sessionID: "s1" } } })
    expect(client.prompts).toHaveLength(0)
    expect(fs.existsSync(path.join(dir, ".km"))).toBe(false)
  })

  test("a malformed event does not throw", async () => {
    const { hooks } = await plugin()
    expect(hooks.event!({ event: {} as never })).resolves.toBeUndefined()
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test test/opencode-adapter.test.ts`
Expected: FAIL, module not found.

- [ ] **Step 3: Write the local structural types**

`@opencode-ai/plugin` must not be imported — it is not a dependency and would not survive installation. These are the minimal shapes this adapter touches, transcribed from `/home/th-yoo/z2/opencode/packages/plugin/src/index.ts`.

```ts
// src/adapters/opencode/opencode-types.ts
// Minimal structural types for the slice of opencode's plugin surface this
// adapter uses. Deliberately NOT imported from @opencode-ai/plugin: that
// package is not a dependency of this one, and installation copies this
// directory out of the repo.

export interface OpencodeEvent {
  type: string
  properties?: Record<string, unknown>
}

export interface PromptPart {
  type: "text"
  text: string
}

export interface OpencodeClient {
  session: {
    promptAsync(options: {
      path: { id: string }
      body: { parts: PromptPart[] }
    }): Promise<unknown>
  }
}

export interface OpencodePluginInput {
  client: OpencodeClient
  /** Repo root for this session. gate.json and .km/ hang off it. */
  worktree: string
  directory?: string
}

export interface KkamakHooks {
  event?: (input: { event: OpencodeEvent }) => Promise<void>
  "chat.message"?: (
    input: { sessionID: string },
    output: { message: unknown; parts: unknown[] },
  ) => Promise<void>
  "tool.execute.after"?: (
    input: { tool: string; sessionID: string; callID: string; args: unknown },
    output: { title: string; output: string; metadata: unknown },
  ) => Promise<void>
}
```

- [ ] **Step 4: Write the plugin**

```ts
// src/adapters/opencode/plugin.ts
// opencode adapter.
//
// opencode has no blocking stop hook: `session.idle` is fire-and-forget. So a
// kernel "block" is delivered by CONTINUING the session — injecting a user
// message that carries the evidence — rather than by refusing anything.
//
// That injected message fires `chat.message`, which this adapter maps to
// new-user-prompt, the event that preempts an open cycle. It therefore carries
// INJECTED_MARKER so we can tell our own text from a human's and leave the
// cycle alone.
import { createGate } from "../../kernel/index.ts"
import { createNodeHost } from "../../runtime/index.ts"
import { composeBlockMessage } from "../shared/framing.ts"
import type {
  KkamakHooks,
  OpencodeClient,
  OpencodePluginInput,
  PromptPart,
} from "./opencode-types.ts"

const APP = "opencode"

/** opencode tool ids that count as editing a file, matched case-insensitively. */
export const EDIT_TOOLS = ["edit", "write", "patch", "multiedit"] as const

/** Lets the adapter recognise its own injected prompt. */
export const INJECTED_MARKER = "[kkamak-gate]"

export function isInjectedMessage(text: string): boolean {
  return text.includes(INJECTED_MARKER)
}

export interface PluginDeps {
  client: OpencodeClient
  worktree: string
}

function textOf(parts: unknown[]): string {
  return parts
    .map((part) => {
      if (typeof part !== "object" || part === null) return ""
      const record = part as Record<string, unknown>
      return typeof record.text === "string" ? record.text : ""
    })
    .join("")
}

/** Every hook body funnels through here: a thrown error must never escape. */
async function guarded(label: string, body: () => Promise<void>): Promise<void> {
  try {
    await body()
  } catch (err) {
    try {
      process.stderr.write(`kkamak: ${label} failed, allowing the session through: ${String(err)}\n`)
    } catch {
      // Nothing left to report with.
    }
  }
}

export async function createKkamakPlugin(deps: PluginDeps): Promise<KkamakHooks> {
  const gate = createGate(createNodeHost({ root: deps.worktree, app: APP }))

  return {
    "tool.execute.after": (input) =>
      guarded("tool.execute.after", async () => {
        if (!(EDIT_TOOLS as readonly string[]).includes(input.tool.toLowerCase())) return
        await gate.handle({ kind: "file-edited", sessionId: input.sessionID })
      }),

    "chat.message": (input, output) =>
      guarded("chat.message", async () => {
        // Our own continuation prompt must not preempt the cycle it opened.
        if (isInjectedMessage(textOf(output.parts))) return
        await gate.handle({ kind: "new-user-prompt", sessionId: input.sessionID })
      }),

    event: ({ event }) =>
      guarded("session.idle", async () => {
        if (event?.type !== "session.idle") return
        const sessionId = event.properties?.sessionID
        if (typeof sessionId !== "string" || !sessionId) return

        const decision = await gate.handle({ kind: "stop-requested", sessionId })
        if (decision.kind !== "block") return

        const parts: PromptPart[] = [
          { type: "text", text: `${INJECTED_MARKER} ${composeBlockMessage(decision)}` },
        ]
        // promptAsync, not prompt: prompt waits for the assistant to finish and
        // we are inside an event handler, which would deadlock.
        await deps.client.session.promptAsync({ path: { id: sessionId }, body: { parts } })
      }),
  }
}

/** The shape opencode loads. */
export default async function KkamakPlugin(input: OpencodePluginInput): Promise<KkamakHooks> {
  return createKkamakPlugin({ client: input.client, worktree: input.worktree ?? input.directory ?? process.cwd() })
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `bun test test/opencode-adapter.test.ts && bunx tsc --noEmit`
Expected: PASS. If the self-prompt-trap test fails, the marker is not surviving the round trip — check that `textOf` reads the part shape the test builds, and do not "fix" it by removing the preemption behaviour.

- [ ] **Step 6: Commit**

```bash
git add src/adapters/opencode test/opencode-adapter.test.ts
git commit -m "feat(adapters): opencode plugin adapter"
```

---

### Task 4: Packaging and installation guarantees

The manifests are the one part no unit test exercises, and a typo there means the plugin silently never runs.

**Files:**
- Create: `test/packaging.test.ts`
- Modify: `test/imports.test.ts` (only if a scan needs widening; do not weaken it)

**Interfaces:**
- Consumes: `EDIT_TOOLS`, `HOOK_EVENTS` from `../src/adapters/claude-code/hook-input.ts`.
- Produces: nothing; tests only.

- [ ] **Step 1: Write the failing test**

```ts
// test/packaging.test.ts
import { describe, expect, test } from "bun:test"
import fs from "node:fs"
import path from "node:path"
import { EDIT_TOOLS, HOOK_EVENTS } from "../src/adapters/claude-code/hook-input.ts"

const ROOT = path.resolve(import.meta.dir, "..")
const read = (rel: string) => JSON.parse(fs.readFileSync(path.join(ROOT, rel), "utf8")) as Record<string, unknown>

interface HookEntry { type: string; command: string; timeout: number }
interface HookBlock { matcher?: string; hooks: HookEntry[] }

function blocks(): { event: string; block: HookBlock }[] {
  const manifest = read("hooks/hooks.json") as { hooks: Record<string, HookBlock[]> }
  return Object.entries(manifest.hooks).flatMap(([event, list]) => list.map((block) => ({ event, block })))
}

describe("Claude Code plugin manifests", () => {
  test("plugin.json declares a name, version and description", () => {
    const plugin = read(".claude-plugin/plugin.json")
    expect(plugin.name).toBe("kkamak")
    expect(typeof plugin.version).toBe("string")
    expect(String(plugin.description).length).toBeGreaterThan(0)
  })

  test("plugin.json version matches package.json", () => {
    expect(read(".claude-plugin/plugin.json").version).toBe(read("package.json").version)
  })

  test("registers exactly the events the adapter handles", () => {
    const manifest = read("hooks/hooks.json") as { hooks: Record<string, unknown> }
    expect(Object.keys(manifest.hooks).sort()).toEqual([...HOOK_EVENTS].sort())
  })

  test("every hook command points at a file that exists", () => {
    for (const { block } of blocks()) {
      for (const entry of block.hooks) {
        expect(entry.command).toContain("hook-cli.ts")
        const match = /\$\{CLAUDE_PLUGIN_ROOT\}\/([^"]+)/.exec(entry.command)
        expect(match).not.toBeNull()
        expect(fs.existsSync(path.join(ROOT, match![1]!))).toBe(true)
      }
    }
  })

  test("every hook command passes its event name as the argument", () => {
    for (const { event, block } of blocks()) {
      for (const entry of block.hooks) {
        expect(entry.command.trim().endsWith(` ${event}`)).toBe(true)
      }
    }
  })

  // A matcher that drifts from EDIT_TOOLS means the gate silently stops arming.
  test("the PostToolUse matcher is exactly EDIT_TOOLS", () => {
    for (const { block } of blocks().filter((b) => b.event === "PostToolUse")) {
      expect(block.matcher).toBe(EDIT_TOOLS.join("|"))
    }
  })

  test("the Stop hook gets room to run the check; the bookkeeping hooks do not need it", () => {
    for (const { event, block } of blocks()) {
      for (const entry of block.hooks) {
        expect(entry.timeout).toBe(event === "Stop" ? 600 : 30)
      }
    }
  })
})

describe("installation shape", () => {
  test("every file installation must copy is present", () => {
    for (const rel of [
      ".claude-plugin/plugin.json",
      "hooks/hooks.json",
      "package.json",
      "src/kernel/index.ts",
      "src/runtime/index.ts",
      "src/adapters/claude-code/hook-cli.ts",
      "src/adapters/opencode/plugin.ts",
    ]) {
      expect(fs.existsSync(path.join(ROOT, rel))).toBe(true)
    }
  })

  test("the opencode adapter does not import the opencode SDK", () => {
    const dir = path.join(ROOT, "src/adapters/opencode")
    for (const name of fs.readdirSync(dir)) {
      const source = fs.readFileSync(path.join(dir, name), "utf8")
      expect(source).not.toContain("@opencode-ai")
    }
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test test/packaging.test.ts`
Expected: FAIL — this task runs after Tasks 2 and 3, so the failures should be assertion failures on real files, not module-not-found. If you see module-not-found, an earlier task is incomplete; stop and report.

- [ ] **Step 3: Fix whatever the manifests got wrong**

Adjust `hooks/hooks.json`, `.claude-plugin/plugin.json`, or `package.json` until the test passes. Do not weaken an assertion to make it pass — the assertions are the deliverable. If an assertion is genuinely wrong, say so in your task report rather than editing it quietly.

- [ ] **Step 4: Run the whole suite**

Run: `bun test && bunx tsc --noEmit`
Expected: PASS, including the pre-existing `test/imports.test.ts` scans over the new adapter files.

- [ ] **Step 5: Commit**

```bash
git add test/packaging.test.ts hooks .claude-plugin package.json
git commit -m "test: enforce plugin manifest and installation shape"
```

---

### Task 5: README

**Files:**
- Create: `README.md`
- Test: none. Prose.

- [ ] **Step 1: Write it**

Cover, in this order: what kkamak does in two sentences; `gate.json` with every field and its default (`check` required, `rounds` 2, `sensor` `.km/gate-outcomes.ndjson`, `checkTimeoutMs` 300000); that `rounds: 2` means two blocks then the third failure is allowed through; installation for Claude Code and for opencode; that the check should be cheap because it runs every time the agent finishes after an edit; the escape hatch (edit or delete `gate.json`, effective next turn, no restart); that three consecutive internal errors disarm the gate for the session; and where the sensor file lives and one example line.

Keep it under 100 lines. Do not restate the design spec.

- [ ] **Step 2: Verify the claims**

Every default and behaviour you state must match `src/kernel/config.ts` and `src/kernel/gate.ts`. Re-read both and check each claim. A README that lies about defaults is worse than no README.

- [ ] **Step 3: Commit**

```bash
git add README.md
git commit -m "docs: README"
```

---

## Self-review

**Spec coverage.** The kernel spec's "harness adapters are the next step" is what this plan covers. Events in: Task 2 maps all three for Claude Code, Task 3 maps all three for opencode. Decisions out: Task 1 frames them, Task 2 emits them as a Claude Code block, Task 3 delivers them as an injected continuation. Self-containment: Task 4, plus the pre-existing import scans. Fail-open: every hook body is wrapped, and both adapter test files assert it.

**Placeholders.** None. Every code step carries the actual code; every test step carries the actual test.

**Type consistency.** `GateEvent`, `GateDecision`, `GateHost`, `createGate`, `createNodeHost` are used exactly as the kernel exports them. `composeBlockMessage` is defined in Task 1 and consumed by Tasks 2 and 3 with the same signature. `EDIT_TOOLS` is deliberately a different list in each adapter, defined in each and asserted in Task 4 only for Claude Code, whose manifest matcher must agree with it.

**Known open question, to settle during Task 3.** opencode's exact edit-tool ids are taken from the plugin surface, not from an observed session. If Task 3's tool-mapping tests pass but a real opencode session never arms the gate, the ids are wrong — widen `EDIT_TOOLS` from an observed session rather than loosening the match.
