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
  test("a client that cannot inject does not throw out of the hook", async () => {
    writeConfig("exit 1")
    const hooks = await createKkamakPlugin({
      client: { session: { promptAsync: async () => { throw new Error("offline") } } } as never,
      worktree: dir,
    })
    await hooks["tool.execute.after"]!({ tool: "write", sessionID: "s1", callID: "c1", args: {} }, { title: "", output: "", metadata: {} })
    await expect(
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
    await expect(hooks.event!({ event: {} as never })).resolves.toBeUndefined()
  })
})
