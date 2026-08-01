// test/init-cli.test.ts — integration tests that spawn the real init CLI
// (`bun src/cli/init-cli.ts [flags]`) against hermetic tmp repos. The CLI is
// the token-free half of `/kkamak:init`: it never calls a model, it only
// detects a check command and writes gate.json.
import { test, expect } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { DEFAULT_ROUNDS, parseGateConfig } from "../src/kernel/config.ts"

const INIT_CLI = path.join(import.meta.dir, "..", "src", "cli", "init-cli.ts")

interface RunResult {
  stdout: string
  stderr: string
  exitCode: number
}

async function runInit(opts: { cwd: string; args?: string[] }): Promise<RunResult> {
  const proc = Bun.spawn(["bun", INIT_CLI, ...(opts.args ?? [])], {
    cwd: opts.cwd,
    stdout: "pipe",
    stderr: "pipe",
    env: process.env as Record<string, string>,
  })
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout as ReadableStream<Uint8Array>).text(),
    new Response(proc.stderr as ReadableStream<Uint8Array>).text(),
    proc.exited,
  ])
  return { stdout, stderr, exitCode }
}

function mkRepo(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "kkamak-init-cli-"))
}

function rmRepo(repo: string): void {
  fs.rmSync(repo, { recursive: true, force: true })
}

function writePkg(repo: string, pkg: Record<string, unknown>): void {
  fs.writeFileSync(path.join(repo, "package.json"), JSON.stringify(pkg))
}

function readGate(repo: string): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(path.join(repo, "gate.json"), "utf-8")) as Record<string, unknown>
}

function readGitignore(repo: string): string {
  return fs.readFileSync(path.join(repo, ".gitignore"), "utf-8")
}

test("detects package.json scripts.test -> writes gate.json running npm test", async () => {
  const repo = mkRepo()
  try {
    writePkg(repo, { name: "x", scripts: { test: "vitest run" } })
    const r = await runInit({ cwd: repo })
    expect(r.exitCode).toBe(0)
    expect(readGate(repo).check).toBe("npm test")
  } finally {
    rmRepo(repo)
  }
})

// The whole point of the CLI is a file the gate can actually consume; a
// gate.json that this repo's own parser rejects is worse than none.
test("what it writes parses under the kernel's own config parser", async () => {
  const repo = mkRepo()
  try {
    const r = await runInit({ cwd: repo, args: ["--check", "make check"] })
    expect(r.exitCode).toBe(0)
    const parsed = parseGateConfig(fs.readFileSync(path.join(repo, "gate.json"), "utf-8"))
    expect(parsed).toBeDefined()
    expect(parsed!.check).toBe("make check")
    expect(parsed!.rounds).toBe(DEFAULT_ROUNDS)
  } finally {
    rmRepo(repo)
  }
})

test("no scripts.test but bun.lock present -> detects bun test", async () => {
  const repo = mkRepo()
  try {
    fs.writeFileSync(path.join(repo, "bun.lock"), "")
    const r = await runInit({ cwd: repo })
    expect(r.exitCode).toBe(0)
    expect(readGate(repo).check).toBe("bun test")
  } finally {
    rmRepo(repo)
  }
})

test("no scripts.test but @types/bun devDependency -> detects bun test", async () => {
  const repo = mkRepo()
  try {
    writePkg(repo, { name: "x", devDependencies: { "@types/bun": "latest" } })
    const r = await runInit({ cwd: repo })
    expect(r.exitCode).toBe(0)
    expect(readGate(repo).check).toBe("bun test")
  } finally {
    rmRepo(repo)
  }
})

test("nothing detected and no --check -> refuses, prints the flag, writes nothing", async () => {
  const repo = mkRepo()
  try {
    const r = await runInit({ cwd: repo })
    expect(r.exitCode).not.toBe(0)
    expect((r.stdout + r.stderr).toLowerCase()).toContain("--check")
    expect(fs.existsSync(path.join(repo, "gate.json"))).toBe(false)
  } finally {
    rmRepo(repo)
  }
})

test("--check overrides detection", async () => {
  const repo = mkRepo()
  try {
    writePkg(repo, { name: "x", scripts: { test: "vitest run" } })
    const r = await runInit({ cwd: repo, args: ["--check", "make check"] })
    expect(r.exitCode).toBe(0)
    expect(readGate(repo).check).toBe("make check")
  } finally {
    rmRepo(repo)
  }
})

test("existing gate.json without --force -> refuses and leaves the file untouched", async () => {
  const repo = mkRepo()
  try {
    fs.writeFileSync(path.join(repo, "gate.json"), JSON.stringify({ check: "echo untouched", rounds: 9 }))
    const r = await runInit({ cwd: repo, args: ["--check", "npm test"] })
    expect(r.exitCode).not.toBe(0)
    expect((r.stdout + r.stderr).toLowerCase()).toMatch(/exist|force/)
    expect(readGate(repo).check).toBe("echo untouched")
  } finally {
    rmRepo(repo)
  }
})

test("existing gate.json with --force -> overwrites", async () => {
  const repo = mkRepo()
  try {
    fs.writeFileSync(path.join(repo, "gate.json"), JSON.stringify({ check: "echo old", rounds: 9 }))
    const r = await runInit({ cwd: repo, args: ["--check", "npm test", "--force"] })
    expect(r.exitCode).toBe(0)
    expect(readGate(repo).check).toBe("npm test")
    expect(readGate(repo).rounds).toBe(DEFAULT_ROUNDS)
  } finally {
    rmRepo(repo)
  }
})

test("--dry-run previews without writing gate.json or .gitignore", async () => {
  const repo = mkRepo()
  try {
    const r = await runInit({ cwd: repo, args: ["--check", "npm test", "--dry-run"] })
    expect(r.exitCode).toBe(0)
    expect(r.stdout).toContain("npm test")
    expect(fs.existsSync(path.join(repo, "gate.json"))).toBe(false)
    expect(fs.existsSync(path.join(repo, ".gitignore"))).toBe(false)
  } finally {
    rmRepo(repo)
  }
})

// Preview is not a licence to ignore the overwrite guard: a user checking
// what would happen must not be told it would clobber their config silently.
test("--dry-run over an existing gate.json still refuses", async () => {
  const repo = mkRepo()
  try {
    fs.writeFileSync(path.join(repo, "gate.json"), JSON.stringify({ check: "echo untouched", rounds: 9 }))
    const r = await runInit({ cwd: repo, args: ["--check", "npm test", "--dry-run"] })
    expect(r.exitCode).not.toBe(0)
    expect(readGate(repo).check).toBe("echo untouched")
  } finally {
    rmRepo(repo)
  }
})

test(".gitignore missing -> created carrying .km/", async () => {
  const repo = mkRepo()
  try {
    const r = await runInit({ cwd: repo, args: ["--check", "npm test"] })
    expect(r.exitCode).toBe(0)
    expect(readGitignore(repo).split("\n").map((l) => l.trim())).toContain(".km/")
  } finally {
    rmRepo(repo)
  }
})

test(".gitignore without .km/ -> appended, existing content preserved", async () => {
  const repo = mkRepo()
  try {
    fs.writeFileSync(path.join(repo, ".gitignore"), "node_modules/\n")
    const r = await runInit({ cwd: repo, args: ["--check", "npm test"] })
    expect(r.exitCode).toBe(0)
    const gi = readGitignore(repo)
    expect(gi).toContain("node_modules/")
    expect(gi.split("\n").filter((l) => l.trim() === ".km/").length).toBe(1)
  } finally {
    rmRepo(repo)
  }
})

test(".gitignore already carrying .km/ -> not duplicated", async () => {
  const repo = mkRepo()
  try {
    fs.writeFileSync(path.join(repo, ".gitignore"), "node_modules/\n.km/\n")
    const r = await runInit({ cwd: repo, args: ["--check", "npm test"] })
    expect(r.exitCode).toBe(0)
    expect(readGitignore(repo).split("\n").filter((l) => l.trim() === ".km/").length).toBe(1)
  } finally {
    rmRepo(repo)
  }
})
