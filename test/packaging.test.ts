// test/packaging.test.ts
import { describe, expect, test } from "bun:test"
import fs from "node:fs"
import path from "node:path"
import { EDIT_TOOLS, HOOK_EVENTS } from "../src/adapters/claude-code/hook-input.ts"
import { KERNEL_VERSION } from "../src/kernel/sensor.ts"

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

  // KERNEL_VERSION is a literal (sensor.ts stays I/O-free) rather than read
  // from package.json at runtime, so it can silently drift on a version
  // bump. This guards it the same way the plugin.json check above does.
  test("sensor.ts's KERNEL_VERSION matches package.json", () => {
    expect(read("package.json").version).toBe(KERNEL_VERSION)
  })

  // Without a marketplace manifest `claude plugin install` has nothing to
  // resolve — the checkout is loadable only via --plugin-dir. This repo is its
  // own marketplace, so the manifest sits beside plugin.json.
  test("marketplace.json declares a name and an owner", () => {
    const marketplace = read(".claude-plugin/marketplace.json")
    expect(marketplace.name).toBe("kkamak")
    expect(String((marketplace.owner as Record<string, unknown>).name).length).toBeGreaterThan(0)
  })

  test("marketplace.json lists this plugin at the repo root", () => {
    const marketplace = read(".claude-plugin/marketplace.json") as { plugins: Record<string, unknown>[] }
    const entry = marketplace.plugins.find((p) => p.name === read(".claude-plugin/plugin.json").name)
    expect(entry).toBeDefined()
    // "./" is the repo root: the marketplace and the plugin it serves are the
    // same checkout, so a source pointing anywhere else cannot resolve.
    expect(entry!.source).toBe("./")
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
  // Nothing imports these, so the transitive-closure walk below can never
  // reach them — they need their own existence assertion.
  test("the manifests installation relies on are present", () => {
    for (const rel of [
      ".claude-plugin/plugin.json",
      ".claude-plugin/marketplace.json",
      "hooks/hooks.json",
      "package.json",
    ]) {
      expect(fs.existsSync(path.join(ROOT, rel))).toBe(true)
    }
  })

  const ENTRYPOINTS = ["src/adapters/claude-code/hook-cli.ts", "src/adapters/opencode/plugin.ts"]

  // Installation copies this directory out of the repo, so the only files
  // that matter are the ones actually reachable by relative import from an
  // entrypoint. A curated list drifts silently when a module is deleted or a
  // helper is renamed; walking the real closure cannot.
  function closure(): Set<string> {
    const seen = new Set<string>()
    const queue = [...ENTRYPOINTS]
    while (queue.length) {
      const rel = queue.pop()!
      if (seen.has(rel)) continue
      seen.add(rel)
      const src = fs.readFileSync(path.join(ROOT, rel), "utf8")
      for (const [, spec] of src.matchAll(/from\s+"(\.[^"]+)"/g)) {
        queue.push(path.relative(ROOT, path.resolve(path.dirname(path.join(ROOT, rel)), spec!)))
      }
    }
    return seen
  }

  test("every file the adapters import is present", () => {
    const files = closure()
    // Observed closure size is 18 (2 entrypoints + 16 transitively imported
    // files: both adapters' own helpers, shared framing, and every kernel and
    // runtime module). A closure that silently resolved to just the two
    // entrypoints — e.g. because the regex stopped matching — must fail here,
    // not pass vacuously.
    expect(files.size).toBeGreaterThanOrEqual(18)
    for (const rel of [
      "src/adapters/claude-code/emit.ts",
      "src/adapters/claude-code/hook-input.ts",
      "src/adapters/opencode/opencode-types.ts",
      "src/adapters/shared/framing.ts",
      "src/kernel/gate.ts",
      "src/runtime/file-state-store.ts",
    ]) {
      expect(files.has(rel)).toBe(true)
    }
    for (const rel of files) {
      expect(rel.startsWith("..")).toBe(false) // never escapes the package root
      expect(fs.existsSync(path.join(ROOT, rel))).toBe(true)
    }
  })

  // The adapter's comments name the package on purpose — to say it must not be
  // imported — so this scans import statements, not prose. Beyond the usual
  // clause form, the regex also matches a bare dynamic-import call with no
  // introducing keyword and no space before the specifier, plus a require
  // call — either of which could otherwise slip an SDK dependency in unseen.
  test("the opencode adapter does not import the opencode SDK", () => {
    const dir = path.join(ROOT, "src/adapters/opencode")
    for (const name of fs.readdirSync(dir)) {
      const source = fs.readFileSync(path.join(dir, name), "utf8")
      const specifiers = [
        ...source.matchAll(/(?:\bfrom\s+|\bimport\s*\(?\s*|\brequire\s*\()["'`]([^"'`]+)["'`]/g),
      ]
      expect(specifiers.map((m) => m[1])).not.toContain("@opencode-ai/plugin")
      for (const [, specifier] of specifiers) {
        expect(specifier).not.toStartWith("@opencode-ai")
      }
    }
  })
})
