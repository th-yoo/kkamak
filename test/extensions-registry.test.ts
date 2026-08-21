import { describe, expect, test } from "bun:test"
import { loadActiveExtensionsFrom } from "../src/extensions/registry.ts"
import type { Extension, ExtensionContext } from "../src/extensions/registry.ts"
import { makeHarness } from "./fakes.ts"
import type { GateDecision, GateEvent, GateHost } from "../src/kernel/ports.ts"

const STOP: GateEvent = { kind: "stop-requested", sessionID: "s" }
const ALLOW: GateDecision = { kind: "allow" }
const CTX: ExtensionContext = { root: "/repo" }

function fakeExtension(over: Partial<Extension> = {}): Extension {
  return {
    name: "known",
    wrapHost: (host: GateHost) => host,
    afterDecision: async () => {},
    ...over,
  }
}

// K4 review Q6: EXTENSIONS is now a Record<string, () => Promise<Extension>>
// (lazy-loaded) rather than a Record<string, Extension> — every test
// registration below wraps its fake in a loader to match.

describe("loadActiveExtensionsFrom", () => {
  test("no enabled extensions: wrapHost is identity, afterDecision is a noop", async () => {
    const { host, logger } = makeHarness({ raw: '{"check":"x"}' })
    const ext = await loadActiveExtensionsFrom(host, {}, CTX)
    expect(ext.wrapHost(host)).toBe(host)
    await expect(ext.afterDecision(STOP, ALLOW)).resolves.toBeUndefined()
    expect(logger.messages).toEqual([])
  })

  test("an enabled but unregistered name: identity + one logger line naming it", async () => {
    const { host, logger } = makeHarness({ raw: '{"check":"x","extensions":{"ghost":true}}' })
    const ext = await loadActiveExtensionsFrom(host, {}, CTX)
    expect(ext.wrapHost(host)).toBe(host)
    await ext.afterDecision(STOP, ALLOW)
    expect(logger.messages).toHaveLength(1)
    expect(logger.messages[0]).toContain("ghost")
  })

  test("a registered extension's wrapHost is applied when its name is enabled", async () => {
    const { host } = makeHarness({ raw: '{"check":"x","extensions":{"known":true}}' })
    const wrapped: GateHost = { ...host, info: { ...host.info, app: "wrapped" } }
    const known = fakeExtension({ wrapHost: () => wrapped })
    const ext = await loadActiveExtensionsFrom(host, { known: async () => known }, CTX)
    expect(ext.wrapHost(host)).toBe(wrapped)
  })

  test("a registered extension's afterDecision that throws is swallowed and logged; the promise still resolves", async () => {
    const { host, logger } = makeHarness({ raw: '{"check":"x","extensions":{"known":true}}' })
    const known = fakeExtension({
      afterDecision: async () => {
        throw new Error("boom")
      },
    })
    const ext = await loadActiveExtensionsFrom(host, { known: async () => known }, CTX)
    await expect(ext.afterDecision(STOP, ALLOW)).resolves.toBeUndefined()
    expect(logger.messages).toHaveLength(1)
    expect(logger.messages[0]).toContain("known")
    expect(logger.messages[0]).toContain("boom")
  })

  // K4 ruling R12: ctx (root, prompt) is bound at load time and threaded
  // verbatim to every active extension's wrapHost/afterDecision calls —
  // this is the seam gauge's shadowEvaluateAtStop (needs root) and
  // maybeSpawnGauge (needs prompt) both depend on.
  test("ctx is passed through to a registered extension's wrapHost and afterDecision verbatim", async () => {
    const { host } = makeHarness({ raw: '{"check":"x","extensions":{"known":true}}' })
    const ctx: ExtensionContext = { root: "/my/repo", prompt: "fix the bug" }
    let seenWrapCtx: ExtensionContext | undefined
    let seenAfterCtx: ExtensionContext | undefined
    const known = fakeExtension({
      wrapHost: (h, c) => {
        seenWrapCtx = c
        return h
      },
      afterDecision: async (_e, _d, _h, c) => {
        seenAfterCtx = c
      },
    })
    const ext = await loadActiveExtensionsFrom(host, { known: async () => known }, ctx)
    ext.wrapHost(host)
    await ext.afterDecision(STOP, ALLOW)
    expect(seenWrapCtx).toEqual(ctx)
    expect(seenAfterCtx).toEqual(ctx)
  })

  // K4 review Q6: the registry is lazy now — a loader that itself throws
  // (a broken dynamic import, a module that fails to evaluate) must not
  // take the whole hook down. Same "log and exclude" treatment as an
  // unregistered name.
  test("a loader that throws is logged and the extension is excluded from active (not enabled-but-broken silently)", async () => {
    const { host, logger } = makeHarness({ raw: '{"check":"x","extensions":{"broken":true}}' })
    const ext = await loadActiveExtensionsFrom(
      host,
      {
        broken: async () => {
          throw new Error("module explosion")
        },
      },
      CTX,
    )
    expect(ext.wrapHost(host)).toBe(host) // never loaded -> never applied
    await expect(ext.afterDecision(STOP, ALLOW)).resolves.toBeUndefined()
    expect(logger.messages).toHaveLength(1)
    expect(logger.messages[0]).toContain("broken")
    expect(logger.messages[0]).toContain("module explosion")
  })

  test("the loader is called only for enabled names, not for every registered name", async () => {
    const { host } = makeHarness({ raw: '{"check":"x","extensions":{"known":true}}' })
    let unusedLoaderCalled = false
    await loadActiveExtensionsFrom(
      host,
      {
        known: async () => fakeExtension(),
        unused: async () => {
          unusedLoaderCalled = true
          return fakeExtension({ name: "unused" })
        },
      },
      CTX,
    )
    expect(unusedLoaderCalled).toBe(false)
  })
})
