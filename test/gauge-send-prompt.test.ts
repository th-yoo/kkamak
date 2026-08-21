import { describe, expect, test } from "bun:test"
import {
  GAUGE_ISOLATION, REASONING_ISOLATION, registerProvider, resolveProvider, sendPrompt,
} from "../src/extensions/gauge/send-prompt.ts"
import type { SendOutcome, SendPromptOptions } from "../src/extensions/gauge/send-prompt.ts"

describe("sendPrompt dispatch", () => {
  test("reaches the registered provider with the exact prompt and opts", async () => {
    let seenPrompt: string | undefined
    let seenOpts: SendPromptOptions | undefined
    registerProvider("fake-dispatch", async (prompt, opts) => {
      seenPrompt = prompt
      seenOpts = opts
      return { ok: true, text: "hi", model: "m", canonicalModel: "m" }
    })
    const opts: SendPromptOptions = {
      model: "m", isolation: REASONING_ISOLATION, provider: "fake-dispatch", timeoutMs: 1234,
    }
    await sendPrompt("the exact prompt", opts)
    expect(seenPrompt).toBe("the exact prompt")
    expect(seenOpts).toEqual(opts)
  })

  test("an ok outcome passes through unchanged", async () => {
    const outcome: SendOutcome = { ok: true, text: "answer", model: "m1", canonicalModel: "m1-20260101" }
    registerProvider("fake-ok", async () => outcome)
    const result = await sendPrompt("p", { model: "m1", isolation: REASONING_ISOLATION, provider: "fake-ok" })
    expect(result).toEqual(outcome)
  })

  test("a no-call outcome passes through unchanged", async () => {
    registerProvider("fake-no-call", async () => ({ ok: false, kind: "no-call" }))
    const result = await sendPrompt("p", { model: "m1", isolation: REASONING_ISOLATION, provider: "fake-no-call" })
    expect(result).toEqual({ ok: false, kind: "no-call" })
  })

  test("a call-consumed outcome passes through unchanged", async () => {
    registerProvider("fake-call-consumed", async () => ({ ok: false, kind: "call-consumed" }))
    const result = await sendPrompt("p", { model: "m1", isolation: REASONING_ISOLATION, provider: "fake-call-consumed" })
    expect(result).toEqual({ ok: false, kind: "call-consumed" })
  })

  test("an unknown provider id resolves to no-call, never a throw", async () => {
    const result = await sendPrompt("p", { model: "m1", isolation: REASONING_ISOLATION, provider: "no-such-provider" })
    expect(result).toEqual({ ok: false, kind: "no-call" })
  })

  test("a provider that throws is caught and converted to call-consumed", async () => {
    registerProvider("fake-throws", async () => {
      throw new Error("boom")
    })
    const result = await sendPrompt("p", { model: "m1", isolation: REASONING_ISOLATION, provider: "fake-throws" })
    expect(result).toEqual({ ok: false, kind: "call-consumed" })
  })

  test("a provider that throws synchronously (not via rejected promise) is also caught", async () => {
    // A well-typed provider is declared `async`, so a real TypeScript
    // implementation can never throw synchronously — every throw inside an
    // async function becomes a rejected promise. The cast below exists only
    // to simulate a provider that VIOLATES that type contract (a plain,
    // non-async function slipped past the type system somehow), so this
    // test still pins `sendPrompt`'s defense-in-depth for that case.
    registerProvider("fake-throws-sync", (() => {
      throw new Error("sync boom")
    }) as unknown as Parameters<typeof registerProvider>[1])
    const result = await sendPrompt("p", { model: "m1", isolation: REASONING_ISOLATION, provider: "fake-throws-sync" })
    expect(result).toEqual({ ok: false, kind: "call-consumed" })
  })
})

describe("resolveProvider", () => {
  test("returns the registered provider function for a known id", () => {
    const provider = async (): Promise<SendOutcome> => ({ ok: true, text: "x", model: "m", canonicalModel: "m" })
    registerProvider("fake-resolve-known", provider)
    expect(resolveProvider("fake-resolve-known")).toBe(provider)
  })

  test("returns undefined for an unknown id", () => {
    expect(resolveProvider("no-such-provider-ever-registered")).toBeUndefined()
  })
})

describe("REASONING_ISOLATION", () => {
  test("has a non-empty systemPrompt", () => {
    expect(REASONING_ISOLATION.systemPrompt.length).toBeGreaterThan(0)
  })
  test("has no tools", () => {
    expect(REASONING_ISOLATION.tools).toEqual([])
  })
  test("has no setting sources and no auto-memory, matching the GAUGE_ISOLATION shell", () => {
    expect(REASONING_ISOLATION.settingSources).toEqual([])
    expect(REASONING_ISOLATION.settings.autoMemoryEnabled).toBe(false)
  })
  test("has a title distinct from GAUGE_ISOLATION's", () => {
    expect(REASONING_ISOLATION.title).not.toBe(GAUGE_ISOLATION.title)
    expect(REASONING_ISOLATION.title.length).toBeGreaterThan(0)
  })
})

// The per-session SDK-option slice. GAUGE_ISOLATION must stay byte-identical
// to the option literal inlined in agent-transport.ts's agentSdkCall
// (agent-transport.ts:119-132 is the authority) — that equality is what a
// later node's test proves against the live call site; this only locks the
// value declared here.
describe("WarmIsolation / GAUGE_ISOLATION (§6d/§6e gauge isolation set)", () => {
  test("matches the agent-transport.ts option literal field-for-field", () => {
    expect(GAUGE_ISOLATION).toEqual({
      systemPrompt: "",
      settingSources: [],
      settings: { autoMemoryEnabled: false },
      persistSession: false,
      strictMcpConfig: true,
      tools: [],
      title: "kkamak-gauge",
      thinking: { type: "disabled" },
    })
  })
  test("is as-const-safe to spread into an SDK options literal", () => {
    const options = { ...GAUGE_ISOLATION, model: "claude-haiku-4-5", cwd: "/x", env: {} }
    expect(options.title).toBe("kkamak-gauge")
    expect(options.model).toBe("claude-haiku-4-5")
    expect(options.thinking).toEqual({ type: "disabled" })
  })
})
