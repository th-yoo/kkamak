# Kernel Review Remediation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the three defects an independent review found in the delivered kernel, the first of which lets a full disk wedge a session forever.

**Architecture:** Three independent fixes to existing files. Task 1 changes `src/kernel/gate.ts` behaviour; Tasks 2 and 3 only strengthen tests. No new modules, no contract changes to `src/kernel/ports.ts`.

**Tech Stack:** TypeScript on Bun.

## Global Constraints

- **Test command:** `bun test`. Typecheck: `bunx tsc --noEmit`. Both must pass before every commit.
- **Zero runtime dependencies.** Only `node:*` builtins and relative imports.
- **Do not change `src/kernel/ports.ts`.** All three fixes are possible without touching the adapter contract, and adapters are being written against it.
- **Do not weaken an existing assertion to make anything pass.** If an existing test looks wrong, say so in your task report instead of quietly editing it.
- The reviewer's full findings are reproduced inline per task. Trust them but verify each with a failing test first — that is step 1 of every task.

---

### Task 1: A block that cannot be recorded must not block (CRITICAL)

**The defect.** `src/kernel/gate.ts` block branch computes `round = state.round + 1` from the just-loaded state, returns the `block` decision, and persists via `persist()`, which deliberately swallows save errors. `src/runtime/file-state-store.ts` writes to a temp file and renames, so a failed save leaves the *previous* record intact. Therefore while saves keep failing (ENOSPC, read-only state directory), `load()` keeps returning the same stale `round`, every `stop-requested` recomputes the same `state.round < config.rounds` comparison, and the gate returns `block` forever. It can never reach the exhaustion branch, because `state.round` never durably increases. Unlike a crashing check runner, which increments `errorStreak` and disarms after three, save failures are counted nowhere.

**The fix.** A block is only safe if we can record that we blocked; a block we cannot record is a block we cannot bound. So when persisting a block fails, downgrade the decision to `allow`. Do not attempt to count save failures — the counter would live in the state we just failed to write.

Only the block branch can wedge. The other branches are already safe and must not be changed: a failed reset after a pass or an exhaustion leaves stale state that at worst re-runs the check next stop and allows again; a failed arm on `file-edited` simply leaves the gate disarmed; a failed reset on `new-user-prompt` leaves the cycle open but still bounded by the rounds budget.

**Files:**
- Modify: `src/kernel/gate.ts` (the `persist` helper and the block branch of `onStopRequested`)
- Test: `test/gate.test.ts` (add a describe block)

**Interfaces:**
- Consumes: existing `GateHost`, `GateState` from `src/kernel/ports.ts` — unchanged.
- Produces: `persist()` returns `boolean` (true when the save succeeded). Internal to `gate.ts`; nothing outside imports it.

- [ ] **Step 1: Write the failing test**

Append to `test/gate.test.ts`. Note the helper: the session must be armed *durably* before saves start failing, otherwise arming fails too and the stop never reaches the block branch.

```ts
describe("a block that cannot be recorded is not a block", () => {
  /** Arms the session durably, then makes every subsequent save fail. */
  function armedThenReadOnly() {
    const h = makeHarness({ fallback: FAIL })
    h.store.save(SESSION, { ...INITIAL_STATE, edited: true })
    h.host.state = {
      load: (id) => h.store.load(id),
      save: () => {
        throw new Error("ENOSPC")
      },
    }
    return h
  }

  test("downgrades to allow when the round cannot be persisted", async () => {
    const h = armedThenReadOnly()
    const gate = createGate(h.host)
    const decision = await gate.handle(stop)
    expect(decision.kind).toBe("allow")
    expect((decision as { notice?: string }).notice).toBeString()
  })

  // The actual wedge: the round never advances on disk, so a naive
  // implementation recomputes the same block decision forever.
  test("cannot wedge a session, however many times the agent retries", async () => {
    const h = armedThenReadOnly()
    const gate = createGate(h.host)
    for (let attempt = 0; attempt < 5; attempt++) {
      expect((await gate.handle(stop)).kind).toBe("allow")
    }
  })

  test("still blocks normally once the round can be persisted", async () => {
    const h = makeHarness({ fallback: FAIL })
    const gate = createGate(h.host)
    await gate.handle(edit)
    expect(await gate.handle(stop)).toMatchObject({ kind: "block", round: 1 })
  })

  test("says why it let the turn through", async () => {
    const h = armedThenReadOnly()
    const gate = createGate(h.host)
    const decision = await gate.handle(stop)
    expect((decision as { notice: string }).notice.toLowerCase()).toContain("could not")
  })

  test("logs the persist failure", async () => {
    const h = armedThenReadOnly()
    const gate = createGate(h.host)
    await gate.handle(stop)
    expect(h.logger.messages.join("\n")).toContain("ENOSPC")
  })
})
```

`INITIAL_STATE` must be imported in `test/gate.test.ts`. Add it to the existing imports:

```ts
import { INITIAL_STATE } from "../src/kernel/state.ts"
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test test/gate.test.ts`
Expected: the first, second and fourth tests FAIL, reporting a `block` where `allow` was expected. That failure IS the reviewer's bug reproduced. The third and fifth may already pass. If the first test passes before you change anything, stop and report — the bug is not what the review described.

- [ ] **Step 3: Make `persist` report success**

In `src/kernel/gate.ts`, change the helper:

```ts
/**
 * Returns false when the state could not be written. Callers that issued a
 * decision already do not care; the block branch does, because a block it
 * cannot record is a block it cannot bound.
 */
function persist(host: GateHost, sessionId: string, state: GateState): boolean {
  try {
    host.state.save(sessionId, state)
    return true
  } catch (err) {
    note(host, `could not persist state for ${sessionId}: ${describe(err)}`)
    return false
  }
}
```

`withPersist` keeps working unchanged (it ignores the return value).

- [ ] **Step 4: Downgrade an unrecordable block**

In `onStopRequested`, replace the block branch so it persists first and checks the result:

```ts
  // rounds is a budget of blocks: `rounds + 1` failing checks ends the cycle.
  if (state.round < config.rounds) {
    const round = state.round + 1
    const recorded = persist(host, sessionId, {
      ...state,
      gating: true,
      round,
      outcomes,
      cycleStartedAt: startedAt,
      // A real verdict, pass or fail, proves the runner works.
      errorStreak: 0,
    })

    // A block we cannot record is a block we cannot bound: the round would
    // never advance on disk, so every later stop would recompute this same
    // decision and the session could never get through. Allow instead.
    if (!recorded) {
      return {
        kind: "allow",
        notice:
          "kkamak: the check failed, but the gate could not record the attempt" +
          " and so cannot bound its retries — stop allowed; check that .km/ is writable",
      }
    }

    return { kind: "block", evidence: evidenceFrom(result), round, roundsMax: config.rounds }
  }
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `bun test && bunx tsc --noEmit`
Expected: the whole suite PASSES, including the pre-existing "a throwing state save does not change the decision" test — read that test before you start, because your change deliberately alters what it asserts. It currently expects a `block` when save throws. That expectation is now wrong: it encodes the bug. Update it to expect `allow` and rename it to say what it now means, e.g. "a throwing state save downgrades a block rather than issuing one it cannot bound". Note this change prominently in your task report.

- [ ] **Step 6: Update the spec**

`docs/superpowers/specs/2026-07-30-kkamak-kernel-design.md`, in the "Error handling — fail-open everywhere" section, currently says port failures are contained individually and "a throwing `state.save` or `sensor.append` must not change the decision that was already computed". That is no longer true for `state.save` on the block path. Amend that bullet to say a failed `state.save` downgrades a block to allow, with the one-line reason, and leave the `sensor.append` half as is.

- [ ] **Step 7: Commit**

```bash
git add src/kernel/gate.ts test/gate.test.ts docs/superpowers/specs/2026-07-30-kkamak-kernel-design.md
git commit -m "fix(kernel): never issue a block that cannot be recorded"
```

---

### Task 2: Prove the import scan actually detects violations

**The defect.** `test/imports.test.ts` proves the current tree is clean but never proves its own detection logic works. The offender-collection algorithm — `path.resolve(path.dirname(file), specifier)` plus a prefix comparison against `KERNEL_DIR`/`PACKAGE_ROOT` — is only ever run against the live tree, which has no violations, so `expect(offenders).toEqual([])` passes trivially. A bug that always produced `[]` would be indistinguishable from a correct scanner. Two concrete blind spots also exist: a computed `require(x)` produces no regex match at all and so never enters `allImports`, and a concatenated `import("./" + x)` is captured as the harmless literal `"./"` while the real runtime value goes unchecked.

**The fix.** Extract the classification logic into named exported functions, test them against synthetic fixtures that MUST be flagged, and close the two blind spots.

**Files:**
- Modify: `test/imports.test.ts`

**Interfaces:**
- Produces (module-local, used only by this test file): `classifyImport(fromFile: string, specifier: string, boundary: string): "ok" | "escapes" | "bare"`, and a `COMPUTED_CALL_PATTERN` used by the computed-specifier scan.

- [ ] **Step 1: Write the failing test**

Add a describe block to `test/imports.test.ts`. These fixtures are synthetic paths — no files are created.

```ts
describe("the scan detects violations it is meant to catch", () => {
  const KERNEL_FILE = path.join(KERNEL_DIR, "gate.ts")

  test.each([
    ["a sibling inside the boundary", "./config.ts", "ok"],
    ["a node builtin", "node:fs", "bare"],
    ["a bare package", "lodash", "bare"],
    ["an escape to a sibling layer", "../runtime/index.ts", "escapes"],
    ["an escape above the package", "../../../elsewhere.ts", "escapes"],
  ])("classifies %s", (_label, specifier, expected) => {
    expect(classifyImport(KERNEL_FILE, specifier, KERNEL_DIR)).toBe(expected)
  })

  test("flags an escape from the package root, not just from the kernel", () => {
    expect(classifyImport(path.join(PACKAGE_ROOT, "src/runtime/x.ts"), "../../outside.ts", PACKAGE_ROOT))
      .toBe("escapes")
  })

  test("treats the boundary directory itself as inside it", () => {
    expect(classifyImport(path.join(KERNEL_DIR, "sub/x.ts"), "..", KERNEL_DIR)).toBe("ok")
  })

  // Guards against a near-miss prefix comparison: a sibling directory whose
  // name merely starts with the boundary's name must count as an escape.
  test("is not fooled by a directory whose name shares the boundary's prefix", () => {
    expect(classifyImport(KERNEL_FILE, "../kernel-extras/x.ts", KERNEL_DIR)).toBe("escapes")
  })

  test.each([
    ["a computed require", "require(computedPath)"],
    ["a computed dynamic import", "import(computedPath)"],
    ["a concatenated dynamic import", 'import("./" + externalPath)'],
    ["a template dynamic import", "import(`./${name}.ts`)"],
  ])("flags %s as an unresolvable specifier", (_label, source) => {
    expect(source).toMatch(COMPUTED_CALL_PATTERN)
  })

  test.each([
    ['a literal import', 'import x from "./a.ts"'],
    ['a literal require', 'require("node:fs")'],
    ['a literal dynamic import', 'const m = await import("./b.ts")'],
  ])("does not flag %s", (_label, source) => {
    expect(source).not.toMatch(COMPUTED_CALL_PATTERN)
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test test/imports.test.ts`
Expected: FAIL — `classifyImport` and `COMPUTED_CALL_PATTERN` are not defined.

- [ ] **Step 3: Extract the classifier and use it**

Add to `test/imports.test.ts`, above the describe blocks:

```ts
/**
 * Classification for one import, against a boundary directory. Exported and
 * fixture-tested below so the scans over the real tree cannot pass vacuously.
 */
export function classifyImport(
  fromFile: string,
  specifier: string,
  boundary: string,
): "ok" | "escapes" | "bare" {
  if (!isRelative(specifier) && specifier !== "..") return "bare"
  const resolved = path.resolve(path.dirname(fromFile), specifier)
  // path.sep matters: a sibling named `kernel-extras` must not pass a bare
  // startsWith check against a `kernel` boundary.
  const inside = resolved === boundary || resolved.startsWith(boundary + path.sep)
  return inside ? "ok" : "escapes"
}

/**
 * A call whose specifier is not a single literal string: a computed value, a
 * concatenation, or a template. None can be checked statically, so none are
 * allowed. Matches `require(` too — the previous scan looked only at `import(`.
 */
export const COMPUTED_CALL_PATTERN =
  /\b(?:import|require)\s*\(\s*(?:[^"'`\s)]|(?:"[^"]*"|'[^']*'|`[^`]*`)\s*\+|`[^`]*\$\{)/
```

Now rewrite the three real-tree scans to use `classifyImport`, so the fixture tests above actually cover the code that runs against `src/`:

- "the kernel imports nothing but its own siblings": offenders are imports in `kernelSources` where `classifyImport(file, specifier, KERNEL_DIR) !== "ok"`.
- "no import escapes the package root": offenders are imports in `allImports` where `classifyImport(file, specifier, PACKAGE_ROOT) === "escapes"`.
- "no import depends on a package that installation would leave behind": offenders are imports where `classifyImport(...) === "bare"` and `!isBareAllowed(specifier)`.

Replace the old "no dynamic import uses a computed specifier" test body to scan every source with `COMPUTED_CALL_PATTERN` instead of its old narrow regex, keeping the existing skip of this file itself (it necessarily contains the patterns as literals).

- [ ] **Step 4: Run the tests to verify they pass**

Run: `bun test test/imports.test.ts && bunx tsc --noEmit`
Expected: PASS. If a real-tree scan now reports an offender, do NOT relax the classifier — report the offender, because it means the old scan was missing a genuine violation.

- [ ] **Step 5: Commit**

```bash
git add test/imports.test.ts
git commit -m "test: prove the import scan flags real violations"
```

---

### Task 3: Fix the vacuous clock test

**The defect.** `test/gate.test.ts`'s "a throwing clock allows" never calls `edit`, so the session is unarmed and `onStopRequested` returns at its first line before `clock.now()` is ever reached. The test would pass even if the clock were not guarded at all, and it duplicates the coverage of "an unedited session stops freely". No test covers a clock that throws during an *armed* cycle, which is where `startedAt = host.clock.now()` actually runs.

**Files:**
- Modify: `test/gate.test.ts`

- [ ] **Step 1: Write the failing test**

Replace the existing "a throwing clock allows" test with these two. Keep them in the same `describe("fail-open: …")` block.

```ts
  // Must arm first: an unedited session returns before the clock is ever read,
  // so without the edit this test passes whether or not the clock is guarded.
  test("a clock that throws while starting a cycle allows", async () => {
    const h = makeHarness({ fallback: FAIL })
    const gate = createGate(h.host)
    await gate.handle(edit)
    h.host.clock = {
      now: () => {
        throw new Error("no clock")
      },
    }
    expect(await gate.handle(stop)).toEqual({ kind: "allow" })
  })

  test("a clock that throws while a cycle is open allows", async () => {
    const h = makeHarness({ fallback: FAIL })
    const gate = createGate(h.host)
    await gate.handle(edit)
    expect(await gate.handle(stop)).toMatchObject({ kind: "block" })
    h.host.clock = {
      now: () => {
        throw new Error("no clock")
      },
    }
    expect(await gate.handle(stop)).toEqual({ kind: "allow" })
  })
```

- [ ] **Step 2: Run the tests**

Run: `bun test test/gate.test.ts`
Expected: PASS — the kernel's outer catch-all already handles this, so these tests confirm real behaviour rather than driving a change. Before concluding that, prove they are not vacuous the way the old one was: temporarily comment out the `try`/`catch` in `createGate`'s `handle`, re-run, and confirm both tests FAIL. Then restore it. Report both observations.

- [ ] **Step 3: Commit**

```bash
git add test/gate.test.ts
git commit -m "test: cover a throwing clock on the armed path"
```

---

## Self-review

**Coverage of the review.** Finding 1 (critical, unbounded block loop) is Task 1. Finding 2 (import scan cannot prove itself, plus the computed-`require` and concatenated-`import` blind spots) is Task 2. Finding 3 (vacuous clock test) is Task 3.

**Deliberately not addressed, and why.** The reviewer flagged, below its own confidence bar, that `FileStateStore.save()` has no locking, so two hooks firing for one session near-simultaneously would lose an update. That is left alone on purpose: whether concurrent events for a single session id can occur depends entirely on the harness adapters' invocation model, which is not yet written. Task 1 also softens the consequence — a lost update can no longer wedge a session, only drop a round. Revisit once the adapters exist and the real invocation model is known. The reviewer's other unscored note, that the no-I/O token scan would not catch `new Date()`, is speculative with no current instance; if Task 2's author wants to add `new Date` to the banned-token list it is a one-word change, but it is not required.

**Placeholders.** None. Every step carries its actual code.

**Type consistency.** `persist` is the only signature that changes, from `void` to `boolean`; its two call sites in `gate.ts` (`withPersist` and the block branch) are both accounted for. `classifyImport` and `COMPUTED_CALL_PATTERN` are new and local to the test file.
