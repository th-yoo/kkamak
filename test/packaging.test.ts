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

  // The adapter's comments name the package on purpose — to say it must not be
  // imported — so this scans import statements, not prose.
  test("the opencode adapter does not import the opencode SDK", () => {
    const dir = path.join(ROOT, "src/adapters/opencode")
    for (const name of fs.readdirSync(dir)) {
      const source = fs.readFileSync(path.join(dir, name), "utf8")
      const specifiers = [...source.matchAll(/(?:from|import|require\()\s*["'`]([^"'`]+)["'`]/g)]
      expect(specifiers.map((m) => m[1])).not.toContain("@opencode-ai/plugin")
      for (const [, specifier] of specifiers) {
        expect(specifier).not.toStartWith("@opencode-ai")
      }
    }
  })
})
