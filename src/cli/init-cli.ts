#!/usr/bin/env bun
/**
 * init-cli.ts — token-free `gate.json` initializer.
 *
 *   bun src/cli/init-cli.ts [--check <cmd>] [--force] [--dry-run]
 *
 * The `/kkamak:init` slash command walks a user through the same decision
 * with a model in the loop; this does the common case — detect a check
 * command, write a two-field gate.json — for no tokens at all. Detection
 * order matches the command's exactly. Makefile, pyproject.toml and justfile
 * are deliberately not scanned by either.
 */
import fs from "node:fs"
import path from "node:path"
import { DEFAULT_ROUNDS } from "../kernel/config.ts"

const GITIGNORE_LINE = ".km/"

interface ParsedArgs {
  checkOverride: string | undefined
  force: boolean
  dryRun: boolean
}

/** Pure argv parser. Unknown flags are ignored. */
export function parseArgs(argv: string[]): ParsedArgs {
  let checkOverride: string | undefined
  let force = false
  let dryRun = false
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === "--check") {
      checkOverride = argv[i + 1]
      i++
    } else if (a === "--force") {
      force = true
    } else if (a === "--dry-run") {
      dryRun = true
    }
  }
  return { checkOverride, force, dryRun }
}

/**
 * Detects a check command at `cwd`:
 *   1. package.json `scripts.test` (non-empty) -> "npm test"
 *   2. else bun.lock, or `@types/bun` in either dependency map -> "bun test"
 *   3. else undefined — the caller must supply --check or refuse.
 */
export function detectCheckCommand(cwd: string): string | undefined {
  let pkg: Record<string, unknown> | undefined
  try {
    pkg = JSON.parse(fs.readFileSync(path.join(cwd, "package.json"), "utf-8")) as Record<string, unknown>
  } catch {
    pkg = undefined
  }

  const scripts = pkg?.scripts as Record<string, unknown> | undefined
  if (typeof scripts?.test === "string" && scripts.test.trim().length > 0) return "npm test"

  if (fs.existsSync(path.join(cwd, "bun.lock"))) return "bun test"

  const deps = pkg?.dependencies as Record<string, unknown> | undefined
  const devDeps = pkg?.devDependencies as Record<string, unknown> | undefined
  if ((deps && "@types/bun" in deps) || (devDeps && "@types/bun" in devDeps)) return "bun test"

  return undefined
}

/** Pure: the gate.json object to write. Everything else takes its default. */
export function buildGateConfig(check: string): Record<string, unknown> {
  return { check, rounds: DEFAULT_ROUNDS }
}

/**
 * Appends `.km/` to <cwd>/.gitignore unless an exact trimmed line already
 * says so; creates the file when missing.
 */
export function ensureGitignoreHasKm(cwd: string): void {
  const giPath = path.join(cwd, ".gitignore")
  let existing = ""
  try {
    existing = fs.readFileSync(giPath, "utf-8")
  } catch {
    existing = ""
  }
  if (existing.split("\n").some((l) => l.trim() === GITIGNORE_LINE)) return
  const separator = existing.length > 0 && !existing.endsWith("\n") ? "\n" : ""
  fs.writeFileSync(giPath, `${existing}${separator}${GITIGNORE_LINE}\n`)
}

const TEMPLATE = JSON.stringify({ check: "<your verification command here>", rounds: DEFAULT_ROUNDS }, null, 2)

function main(): void {
  const cwd = process.cwd()
  const args = parseArgs(process.argv.slice(2))
  const gatePath = path.join(cwd, "gate.json")

  // Checked before --dry-run so a preview never implies a clobber is coming.
  if (fs.existsSync(gatePath) && !args.force) {
    console.error(`init-cli: ${gatePath} already exists — refusing to overwrite. Pass --force to overwrite.`)
    process.exit(1)
  }

  const check = args.checkOverride ?? detectCheckCommand(cwd)
  if (!check) {
    console.error("init-cli: no check command detected in package.json (scripts.test) or bun.lock/@types/bun.")
    console.error("Pass --check '<your verification command>' to set one explicitly. Template:")
    console.error(TEMPLATE)
    console.error("Usage: bun src/cli/init-cli.ts --check '<cmd>' [--force] [--dry-run]")
    process.exit(1)
  }

  const json = JSON.stringify(buildGateConfig(check), null, 2) + "\n"

  if (args.dryRun) {
    console.log("Would write gate.json (dry run — nothing written):")
    console.log(json)
    return
  }

  fs.writeFileSync(gatePath, json)
  ensureGitignoreHasKm(cwd)
  console.log(`gate.json written at ${gatePath}:`)
  console.log(json)
}

if (import.meta.main) main()
