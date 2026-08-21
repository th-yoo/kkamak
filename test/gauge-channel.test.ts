// cc-gate-plugin/test/gauge-channel.test.ts
import { describe, test, expect } from "bun:test"
import { channelForClass, CHANNEL_LITERALS, buildChannelPrompt, parseChannelOutput } from "../src/extensions/gauge/channel.ts"

describe("channelForClass", () => {
  test("deterministic classes map without a model", () => {
    expect(channelForClass("A1")).toBe("exempt")
    expect(channelForClass("B")).toBe("C1")
    expect(channelForClass("C")).toBe("C1")
  })
  test("A2 and D need model refinement (null)", () => {
    expect(channelForClass("A2")).toBeNull()
    expect(channelForClass("D")).toBeNull()
  })
  test("channel literal set is the spec's ladder", () => {
    expect(CHANNEL_LITERALS).toEqual(["C1", "C2", "C3", "C4"])
  })
})

describe("buildChannelPrompt", () => {
  test("contains the prompt inside sentinel markers and no class leakage", () => {
    const p = buildChannelPrompt("write a summary of the design")
    expect(p).toContain("<<<PROMPT")
    expect(p).toContain("write a summary of the design")
    expect(p).toContain('"C2"')
    expect(p).toContain('"C4"')
    // blind isolation: builder must not mention gauge classes at all
    expect(p).not.toContain("A1")
    expect(p).not.toContain('"D"')
  })
})

describe("parseChannelOutput", () => {
  test("parses a well-formed refinement", () => {
    expect(parseChannelOutput('{"channel":"C2","reason":"criterion stated"}'))
      .toEqual({ channel: "C2", reason: "criterion stated" })
  })
  test("tolerates fences and prose around the JSON", () => {
    expect(parseChannelOutput('noise ```{"channel":"C4","reason":null}``` more'))
      .toEqual({ channel: "C4", reason: null })
  })
  test("rejects channels outside the refinement set (C1 not refinable)", () => {
    expect(parseChannelOutput('{"channel":"C1","reason":null}')).toBeUndefined()
    expect(parseChannelOutput('{"channel":"X","reason":null}')).toBeUndefined()
    expect(parseChannelOutput("not json")).toBeUndefined()
  })
})
