// cc-gate-plugin/test/gauge-nudge.test.ts
//
// EXCLUDED from this port (both for hard-constraint reasons stated in the
// K2 dispatch, not silently dropped):
// - "parseGateConfig: channelNudge flag" (3 tests): tests cc-gate-plugin's
//   own src/config.ts, not a gauge/ file at all. kkamak's kernel/config.ts
//   deliberately does not (and per the divergence map's GateConfig ruling,
//   should not) parse channelNudge — "the extension's own config layer
//   supplies these, not kkamak core GateConfig." Porting these would mean
//   modifying src/kernel/, which K2's constraints explicitly forbid
//   ("src/kernel/ untouched").
// - "hook-cli UserPromptSubmit nudge wiring" (2 tests): integration tests
//   against the lab's hook-cli.ts UserPromptSubmit branch — wiring/
//   registration, explicitly K4's job per the K2 dispatch ("The registry
//   stays EMPTY this task (gauge registers in K4)").
import { describe, test, expect } from "bun:test"
import { shouldConsiderPrompt, buildNudgeContext, decideNudge } from "../src/extensions/gauge/nudge.ts"

describe("shouldConsiderPrompt (spec §5 prefilter, frozen at first firing)", () => {
  test("short prompts and slash commands never trigger", () => {
    expect(shouldConsiderPrompt("hi")).toBe(false)
    expect(shouldConsiderPrompt("/compact")).toBe(false)
    expect(shouldConsiderPrompt("/goal " + "x".repeat(200))).toBe(false)
  })
  test("long task-shaped prompts pass the prefilter", () => {
    expect(shouldConsiderPrompt("please improve the overall quality of the data layer and make everything nicer across the app somehow".padEnd(120, "."))).toBe(true)
  })
})

describe("buildNudgeContext", () => {
  test("nudge asks for a measurable exit and names the channel ladder, never blocks", () => {
    const t = buildNudgeContext("C4")
    expect(t).toContain("measurable")
    expect(t).toContain("verifiable")
    expect(t.toLowerCase()).not.toContain("refuse")
    expect(t.toLowerCase()).not.toContain("block")
  })
})

// ── T5b: decideNudge — the whole armed path over an injected transport.
// bun test NEVER makes a real model call: every transport below is a stub,
// and the spy counter proves the flag-off path never even reaches one.
const LONG_PROMPT =
  "please improve the overall quality of the data layer and make everything nicer across the app somehow".padEnd(120, ".")

describe("decideNudge (armed path, injected transport)", () => {
  test("flag off (false / absent cfg): transport is NEVER called, nothing returned", async () => {
    let calls = 0
    const transport = async () => {
      calls++
      return '{"channel":"C4","reason":null}'
    }
    expect(await decideNudge({ transport }, LONG_PROMPT, { channelNudge: false })).toBeUndefined()
    expect(await decideNudge({ transport }, LONG_PROMPT, {})).toBeUndefined()
    expect(await decideNudge({ transport }, LONG_PROMPT, undefined)).toBeUndefined()
    expect(calls).toBe(0)
  })

  test("armed but prefilter miss (short / slash prompt): transport never called", async () => {
    let calls = 0
    const transport = async () => {
      calls++
      return '{"channel":"C4","reason":null}'
    }
    expect(await decideNudge({ transport }, "hi", { channelNudge: true })).toBeUndefined()
    expect(await decideNudge({ transport }, "/goal " + "x".repeat(200), { channelNudge: true })).toBeUndefined()
    expect(calls).toBe(0)
  })

  test("C4 verdict returns the nudge context; transport got the built channel prompt", async () => {
    let seen: string | undefined
    const transport = async (messageText: string) => {
      seen = messageText
      return '{"channel":"C4","reason":"no criterion"}'
    }
    const out = await decideNudge({ transport }, LONG_PROMPT, { channelNudge: true })
    expect(out).toBe(buildNudgeContext("C4"))
    expect(seen).toContain("<<<PROMPT")
    expect(seen).toContain(LONG_PROMPT)
  })

  test("C2/C3 verdicts return nothing (only the C4 tail nudges)", async () => {
    expect(
      await decideNudge({ transport: async () => '{"channel":"C2","reason":"criterion stated"}' }, LONG_PROMPT, { channelNudge: true }),
    ).toBeUndefined()
    expect(
      await decideNudge({ transport: async () => '{"channel":"C3","reason":null}' }, LONG_PROMPT, { channelNudge: true }),
    ).toBeUndefined()
  })

  test("malformed / empty transport output returns nothing (fail-open)", async () => {
    expect(await decideNudge({ transport: async () => "not json at all" }, LONG_PROMPT, { channelNudge: true })).toBeUndefined()
    expect(await decideNudge({ transport: async () => undefined }, LONG_PROMPT, { channelNudge: true })).toBeUndefined()
  })

  test("transport throw returns nothing (fail-open)", async () => {
    const transport = async (): Promise<string | undefined> => {
      throw new Error("connection refused")
    }
    expect(await decideNudge({ transport }, LONG_PROMPT, { channelNudge: true })).toBeUndefined()
  })

  test("timeout returns nothing (spec §5 budget; shrunk for test)", async () => {
    const never = () => new Promise<string | undefined>(() => {})
    expect(await decideNudge({ transport: never, timeoutMs: 10 }, LONG_PROMPT, { channelNudge: true })).toBeUndefined()
  })
})
