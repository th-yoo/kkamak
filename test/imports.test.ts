// Installation copies this package directory out of the repo, so an import
// that escapes the package root — or a runtime dependency from node_modules —
// breaks the installed plugin while passing tests in place. These scans are the
// only thing standing between "green in the repo" and "broken once installed".
import { describe, expect, test } from "bun:test"
import fs from "node:fs"
import path from "node:path"

const PACKAGE_ROOT = path.resolve(import.meta.dir, "..")
const KERNEL_DIR = path.join(PACKAGE_ROOT, "src", "kernel")

/** Specifiers guaranteed to resolve at runtime without being copied along. */
const ALLOWED_BARE = [/^node:/, /^bun:test$/, /^bun$/]

interface ImportRef {
  file: string
  specifier: string
}

function sourceFiles(dir: string): string[] {
  const out: string[] = []
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name.startsWith(".")) continue
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) out.push(...sourceFiles(full))
    else if (/\.(ts|tsx|mts|cts|js|mjs|cjs)$/.test(entry.name)) out.push(full)
  }
  return out
}

/**
 * Matches static `import`/`export ... from`, bare side-effect imports, and
 * dynamic `import(...)` with a literal specifier. A computed dynamic import
 * would slip past this, which is exactly why it is banned below.
 */
function importsIn(file: string): ImportRef[] {
  const source = fs.readFileSync(file, "utf8")
  const pattern =
    /(?:\b(?:import|export)\b[\s\S]*?\bfrom\s*|\bimport\s*|\brequire\s*)\(?\s*["']([^"']+)["']/g
  const refs: ImportRef[] = []
  for (const match of source.matchAll(pattern)) {
    if (match[1]) refs.push({ file, specifier: match[1] })
  }
  return refs
}

function isBareAllowed(specifier: string): boolean {
  return ALLOWED_BARE.some((re) => re.test(specifier))
}

function isRelative(specifier: string): boolean {
  return specifier.startsWith("./") || specifier.startsWith("../")
}

const allSources = [
  ...sourceFiles(path.join(PACKAGE_ROOT, "src")),
  ...sourceFiles(path.join(PACKAGE_ROOT, "test")),
]
const allImports = allSources.flatMap(importsIn)
const kernelSources = sourceFiles(KERNEL_DIR)

function rel(file: string): string {
  return path.relative(PACKAGE_ROOT, file)
}

describe("the scan itself", () => {
  // Guards against the whole file passing vacuously because the traversal or
  // the regex silently stopped matching.
  test("finds the source tree", () => {
    expect(allSources.length).toBeGreaterThan(8)
    expect(kernelSources.length).toBeGreaterThan(4)
  })

  test("finds imports", () => {
    expect(allImports.length).toBeGreaterThan(15)
  })

  test("detects a relative escape", () => {
    expect(isRelative("../../elsewhere.ts")).toBe(true)
  })

  test("detects a disallowed bare specifier", () => {
    expect(isBareAllowed("lodash")).toBe(false)
    expect(isBareAllowed("node:fs")).toBe(true)
  })
})

describe("kernel purity", () => {
  test("the kernel imports nothing but its own siblings", () => {
    const offenders = kernelSources
      .flatMap(importsIn)
      .filter(({ file, specifier }) => {
        if (!isRelative(specifier)) return true // node:*, bare packages: all banned
        const resolved = path.resolve(path.dirname(file), specifier)
        return resolved !== KERNEL_DIR && !resolved.startsWith(KERNEL_DIR + path.sep)
      })
      .map(({ file, specifier }) => `${rel(file)} -> ${specifier}`)

    expect(offenders).toEqual([])
  })

  // The point of the kernel is that it works for both harnesses. A name in
  // here is a leak of harness knowledge into logic that must not have any.
  test("the kernel does not name a harness", () => {
    const offenders: string[] = []
    for (const file of kernelSources) {
      // Comments legitimately mention harnesses when explaining the contract;
      // only executable text is scanned.
      const code = fs
        .readFileSync(file, "utf8")
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/^\s*\/\/.*$/gm, "")
      for (const name of ["claude-code", "claude_code", "opencode", "ClaudeCode", "OpenCode"]) {
        if (code.includes(name)) offenders.push(`${rel(file)}: ${name}`)
      }
    }
    expect(offenders).toEqual([])
  })

  // The kernel must stay a pure state machine: every effect arrives as a port.
  test("the kernel performs no I/O of its own", () => {
    const offenders: string[] = []
    for (const file of kernelSources) {
      const code = fs
        .readFileSync(file, "utf8")
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/^\s*\/\/.*$/gm, "")
      for (const token of ["process.", "Date.now", "Math.random", "fetch(", "globalThis"]) {
        if (code.includes(token)) offenders.push(`${rel(file)}: ${token}`)
      }
    }
    expect(offenders).toEqual([])
  })
})

describe("package containment", () => {
  test("no import escapes the package root", () => {
    const offenders = allImports
      .filter(({ file, specifier }) => {
        if (!isRelative(specifier)) return false // covered by the next test
        const resolved = path.resolve(path.dirname(file), specifier)
        return resolved !== PACKAGE_ROOT && !resolved.startsWith(PACKAGE_ROOT + path.sep)
      })
      .map(({ file, specifier }) => `${rel(file)} -> ${specifier}`)

    expect(offenders).toEqual([])
  })

  test("no import depends on a package that installation would leave behind", () => {
    const offenders = allImports
      .filter(({ specifier }) => !isRelative(specifier) && !isBareAllowed(specifier))
      .map(({ file, specifier }) => `${rel(file)} -> ${specifier}`)

    expect(offenders).toEqual([])
  })

  test("every relative import resolves to a file that exists", () => {
    const missing: string[] = []
    for (const { file, specifier } of allImports) {
      if (!isRelative(specifier)) continue
      const resolved = path.resolve(path.dirname(file), specifier)
      const candidates = [
        resolved,
        `${resolved}.ts`,
        `${resolved}.js`,
        path.join(resolved, "index.ts"),
      ]
      if (!candidates.some((c) => fs.existsSync(c))) missing.push(`${rel(file)} -> ${specifier}`)
    }
    expect(missing).toEqual([])
  })

  // A computed specifier cannot be checked by any of the scans above, so the
  // guarantee only holds if none exist.
  test("no dynamic import uses a computed specifier", () => {
    const offenders: string[] = []
    for (const file of allSources) {
      // This file is skipped because it necessarily contains the scan patterns
      // themselves as literals, which the scan would match.
      if (path.resolve(file) === path.resolve(import.meta.path)) continue
      const source = fs.readFileSync(file, "utf8")
      for (const match of source.matchAll(/\bimport\s*\(\s*([^"'\s)])/g)) {
        offenders.push(`${rel(file)}: import(${match[1]}…`)
      }
    }
    expect(offenders).toEqual([])
  })

  test("the package declares no runtime dependencies", () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(PACKAGE_ROOT, "package.json"), "utf8")) as {
      dependencies?: Record<string, string>
    }
    expect(pkg.dependencies ?? {}).toEqual({})
  })
})
