import { describe, expect, test } from "bun:test"
import { loadActiveExtensionsFrom } from "../src/extensions/registry.ts"
import type { Extension } from "../src/extensions/registry.ts"
import { makeHarness } from "./fakes.ts"
import type { GateDecision, GateEvent, GateHost } from "../src/kernel/ports.ts"

const STOP: GateEvent = { kind: "stop-requested", sessionID: "s" }
const ALLOW: GateDecision = { kind: "allow" }

function fakeExtension(over: Partial<Extension> = {}): Extension {
  return {
    name: "known",
    wrapHost: (host: GateHost) => host,
    afterDecision: async () => {},
    ...over,
  }
}

describe("loadActiveExtensionsFrom", () => {
  test("no enabled extensions: wrapHost is identity, afterDecision is a noop", async () => {
    const { host, logger } = makeHarness({ raw: '{"check":"x"}' })
    const ext = await loadActiveExtensionsFrom(host, {})
    expect(ext.wrapHost(host)).toBe(host)
    await expect(ext.afterDecision(STOP, ALLOW)).resolves.toBeUndefined()
    expect(logger.messages).toEqual([])
  })

  test("an enabled but unregistered name: identity + one logger line naming it", async () => {
    const { host, logger } = makeHarness({ raw: '{"check":"x","extensions":{"ghost":true}}' })
    const ext = await loadActiveExtensionsFrom(host, {})
    expect(ext.wrapHost(host)).toBe(host)
    await ext.afterDecision(STOP, ALLOW)
    expect(logger.messages).toHaveLength(1)
    expect(logger.messages[0]).toContain("ghost")
  })

  test("a registered extension's wrapHost is applied when its name is enabled", async () => {
    const { host } = makeHarness({ raw: '{"check":"x","extensions":{"known":true}}' })
    const wrapped: GateHost = { ...host, info: { ...host.info, app: "wrapped" } }
    const known = fakeExtension({ wrapHost: () => wrapped })
    const ext = await loadActiveExtensionsFrom(host, { known })
    expect(ext.wrapHost(host)).toBe(wrapped)
  })

  test("a registered extension's afterDecision that throws is swallowed and logged; the promise still resolves", async () => {
    const { host, logger } = makeHarness({ raw: '{"check":"x","extensions":{"known":true}}' })
    const known = fakeExtension({
      afterDecision: async () => {
        throw new Error("boom")
      },
    })
    const ext = await loadActiveExtensionsFrom(host, { known })
    await expect(ext.afterDecision(STOP, ALLOW)).resolves.toBeUndefined()
    expect(logger.messages).toHaveLength(1)
    expect(logger.messages[0]).toContain("known")
    expect(logger.messages[0]).toContain("boom")
  })
})
