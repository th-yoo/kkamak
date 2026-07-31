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
import { HYGIENE_MARKER } from "../src/kernel/index.ts"

let dir: string

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "kkamak-oc-"))
})

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true })
})

function writeConfig(check: string, rounds = 2, marker = false): void {
  fs.writeFileSync(path.join(dir, "gate.json"), JSON.stringify({ check, rounds, marker }))
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

  // The adapter only ever injects the marker as a leading prefix. A human who
  // merely quotes it mid-message must not be mistaken for the adapter's own
  // continuation prompt.
  test("a human message that quotes the marker mid-sentence is not self-injected", async () => {
    const text = "someone pasted [kkamak-gate] into chat"
    expect(isInjectedMessage(text)).toBe(false)

    // And it must actually reach the kernel: it should cancel the open cycle,
    // just like any other real human message.
    const { hooks, client } = await plugin("exit 1", 2)
    await hooks["tool.execute.after"]!({ tool: "write", sessionID: "s1", callID: "c1", args: {} }, { title: "", output: "", metadata: {} })
    await hooks.event!({ event: { type: "session.idle", properties: { sessionID: "s1" } } })

    await hooks["chat.message"]!({ sessionID: "s1" }, { message: {} as never, parts: [{ type: "text", text }] as never })

    await hooks.event!({ event: { type: "session.idle", properties: { sessionID: "s1" } } })
    expect(client.prompts).toHaveLength(1) // stood down; no second block
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

// Lesson 1 from live dogfood: a queued human message can consume the turn
// boundary, so session.idle never arrives and the edits go unmeasured. The
// adapter's job is to deliver chat.message so the kernel can say so.
describe("skipped stop boundary", () => {
  test("a human message on an armed session records a skippedStop line", async () => {
    const { hooks, client } = await plugin("exit 1", 2)
    await hooks["tool.execute.after"]!({ tool: "write", sessionID: "s1", callID: "c1", args: {} }, { title: "", output: "", metadata: {} })
    await hooks["chat.message"]!(
      { sessionID: "s1" },
      { message: {} as never, parts: [{ type: "text", text: "actually, also rename it" }] as never },
    )

    const lines = fs.readFileSync(path.join(dir, ".km", "gate-outcomes.ndjson"), "utf8").trim().split("\n")
    expect(lines).toHaveLength(1)
    expect(JSON.parse(lines[0]!)).toMatchObject({ skippedStop: true, rounds: [], app: "opencode" })
    expect(client.prompts).toHaveLength(0)

    // Still armed: the next idle measures the edit.
    await hooks.event!({ event: { type: "session.idle", properties: { sessionID: "s1" } } })
    expect(client.prompts).toHaveLength(1)
  })

  // The adapter's own continuation prompt is not a skipped boundary — it must
  // not reach the kernel at all, so it records nothing.
  test("its own injected prompt records no skippedStop line", async () => {
    const { hooks } = await plugin("exit 1", 2)
    await hooks["tool.execute.after"]!({ tool: "write", sessionID: "s1", callID: "c1", args: {} }, { title: "", output: "", metadata: {} })
    await hooks["chat.message"]!(
      { sessionID: "s1" },
      { message: {} as never, parts: [{ type: "text", text: `${INJECTED_MARKER} not done` }] as never },
    )
    expect(fs.existsSync(path.join(dir, ".km", "gate-outcomes.ndjson"))).toBe(false)
  })
})

describe("fail-open", () => {
  test("a client that cannot inject does not throw out of the hook, and logs why", async () => {
    writeConfig("exit 1")
    const logged: string[] = []
    const hooks = await createKkamakPlugin({
      client: { session: { promptAsync: async () => { throw new Error("offline") } } } as never,
      worktree: dir,
      log: (line) => logged.push(line),
    })
    await hooks["tool.execute.after"]!({ tool: "write", sessionID: "s1", callID: "c1", args: {} }, { title: "", output: "", metadata: {} })
    await expect(
      hooks.event!({ event: { type: "session.idle", properties: { sessionID: "s1" } } }),
    ).resolves.toBeUndefined()
    expect(logged.some((l) => l.includes("session.idle failed") && l.includes("offline"))).toBe(true)
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
    await expect(hooks.event!({ event: {} as never })).resolves.toBeUndefined()
  })
})

// An "allow" decision can still carry a notice (gate exhausted, gate disarmed,
// an unwritable .km/) that the human needs to see. It must never be silently
// dropped, but it also must not be injected as a continuation message — a
// notice is diagnostic, not a reason to keep the session going.
describe("notices on non-block decisions", () => {
  test("a notice from an exhausted gate is logged, not injected as a continuation", async () => {
    writeConfig("exit 1", 0) // rounds: 0 -> the very first failure exhausts the gate
    const client = fakeClient()
    const logged: string[] = []
    const hooks = await createKkamakPlugin({ client: client as never, worktree: dir, log: (line) => logged.push(line) })

    await hooks["tool.execute.after"]!({ tool: "write", sessionID: "s1", callID: "c1", args: {} }, { title: "", output: "", metadata: {} })
    await hooks.event!({ event: { type: "session.idle", properties: { sessionID: "s1" } } })

    expect(client.prompts).toHaveLength(0)
    expect(logged.some((l) => l.includes("gate exhausted"))).toBe(true)
  })
})

// Symmetric with the Claude Code adapter's delivery split (emit.ts's
// planEmit): notice and marker are separate channels. notice is diagnostic
// (log only, per the describe block above); marker is meant for the agent's
// own context, so it can only reach the model by continuing the session —
// same injection mechanism a block uses, never the log.
describe("hygiene marker delivery", () => {
  test("injects a continuation prompt carrying the hygiene notice", async () => {
    writeConfig("exit 0", 2, true) // marker:true, clean accept
    const client = fakeClient()
    const logged: string[] = []
    const hooks = await createKkamakPlugin({ client: client as never, worktree: dir, log: (line) => logged.push(line) })

    await hooks["tool.execute.after"]!({ tool: "write", sessionID: "s1", callID: "c1", args: {} }, { title: "", output: "", metadata: {} })
    await hooks.event!({ event: { type: "session.idle", properties: { sessionID: "s1" } } })

    expect(client.prompts).toHaveLength(1)
    expect(client.prompts[0]!.id).toBe("s1")
    expect(client.prompts[0]!.text).toContain(INJECTED_MARKER)
    expect(client.prompts[0]!.text).toContain(HYGIENE_MARKER)
    // Never logged — only injected, the opposite channel from a notice.
    expect(logged.some((l) => l.includes(HYGIENE_MARKER))).toBe(false)
  })

  test("off by default: a clean accept injects nothing", async () => {
    const { hooks, client } = await plugin("exit 0") // marker defaults false via writeConfig
    await hooks["tool.execute.after"]!({ tool: "write", sessionID: "s1", callID: "c1", args: {} }, { title: "", output: "", metadata: {} })
    await hooks.event!({ event: { type: "session.idle", properties: { sessionID: "s1" } } })
    expect(client.prompts).toHaveLength(0)
  })

  test("never fires on exhaustion, even with the toggle on", async () => {
    writeConfig("exit 1", 0, true) // marker:true, rounds:0 -> exhausts on the first failure
    const client = fakeClient()
    const logged: string[] = []
    const hooks = await createKkamakPlugin({ client: client as never, worktree: dir, log: (line) => logged.push(line) })

    await hooks["tool.execute.after"]!({ tool: "write", sessionID: "s1", callID: "c1", args: {} }, { title: "", output: "", metadata: {} })
    await hooks.event!({ event: { type: "session.idle", properties: { sessionID: "s1" } } })

    expect(client.prompts).toHaveLength(0)
    expect(logged.some((l) => l.includes("gate exhausted"))).toBe(true)
  })

  // The injected marker text lands after state has already reset to
  // INITIAL_STATE (the accept branch resets before returning), so replaying
  // it back through chat.message must be inert either way — this pins that
  // down rather than assuming it.
  test("its own injected marker prompt records nothing if replayed", async () => {
    writeConfig("exit 0", 2, true)
    const client = fakeClient()
    const hooks = await createKkamakPlugin({ client: client as never, worktree: dir })

    await hooks["tool.execute.after"]!({ tool: "write", sessionID: "s1", callID: "c1", args: {} }, { title: "", output: "", metadata: {} })
    await hooks.event!({ event: { type: "session.idle", properties: { sessionID: "s1" } } })
    expect(client.prompts).toHaveLength(1)

    await hooks["chat.message"]!(
      { sessionID: "s1" },
      { message: {} as never, parts: [{ type: "text", text: client.prompts[0]!.text }] as never },
    )

    const lines = fs.readFileSync(path.join(dir, ".km", "gate-outcomes.ndjson"), "utf8").trim().split("\n")
    expect(lines).toHaveLength(1) // only the original accept line
  })
})
