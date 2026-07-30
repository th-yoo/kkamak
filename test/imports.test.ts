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

/**
 * Classification for one import, against a boundary directory. Exported and
 * fixture-tested below so the scans over the real tree cannot pass vacuously.
 */
export function classifyImport(
  fromFile: string,
  specifier: string,
  boundary: string,
): "ok" | "escapes" | "bare" {
  if (!isRelative(specifier) && specifier !== "..") return "bare"
  const resolved = path.resolve(path.dirname(fromFile), specifier)
  // path.sep matters: a sibling named `kernel-extras` must not pass a bare
  // startsWith check against a `kernel` boundary.
  const inside = resolved === boundary || resolved.startsWith(boundary + path.sep)
  return inside ? "ok" : "escapes"
}

/**
 * A call whose specifier is not a single literal string: a computed value, a
 * concatenation, or a template. None can be checked statically, so none are
 * allowed. Matches `require(` too — the previous scan looked only at `import(`.
 */
export const COMPUTED_CALL_PATTERN =
  /\b(?:import|require)\s*\(\s*(?:[^"'`\s)]|(?:"[^"]*"|'[^']*'|`[^`]*`)\s*\+|`[^`]*\$\{)/

const allSources = [
  ...sourceFiles(path.join(PACKAGE_ROOT, "src")),
  ...sourceFiles(path.join(PACKAGE_ROOT, "test")),
]
const allImports = allSources.flatMap(importsIn)
const kernelSources = sourceFiles(KERNEL_DIR)

// Fixture strings that must contain realistic import/require call syntax (to
// prove COMPUTED_CALL_PATTERN both flags and does not flag the right shapes)
// live in a .json file rather than inline here: sourceFiles() only scans
// .ts/.tsx/.mts/.cts/.js/.mjs/.cjs, so a .json fixture never enters
// allSources/allImports and cannot pollute the real-tree scans above with
// matches against this file's own text. (A prior version kept these inline
// and instead filtered this file's own matches out of allImports by identity;
// that filter was broader than the problem — it would also have hidden a
// genuine violation in this file's real code. Keeping the fixture text out of
// the scanned corpus in the first place removes the exclusion entirely.)
const callFixtures = JSON.parse(
  fs.readFileSync(path.join(PACKAGE_ROOT, "test", "import-scan-fixtures.json"), "utf8"),
) as {
  computedCallsThatShouldBeFlagged: [string, string][]
  literalCallsThatShouldNotBeFlagged: [string, string][]
}

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
      .filter(({ file, specifier }) => classifyImport(file, specifier, KERNEL_DIR) !== "ok")
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
      .filter(({ file, specifier }) => classifyImport(file, specifier, PACKAGE_ROOT) === "escapes")
      .map(({ file, specifier }) => `${rel(file)} -> ${specifier}`)

    expect(offenders).toEqual([])
  })

  test("no import depends on a package that installation would leave behind", () => {
    const offenders = allImports
      .filter(
        ({ file, specifier }) =>
          classifyImport(file, specifier, PACKAGE_ROOT) === "bare" && !isBareAllowed(specifier),
      )
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
      for (const match of source.matchAll(new RegExp(COMPUTED_CALL_PATTERN, "g"))) {
        offenders.push(`${rel(file)}: ${match[0]}…`)
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

describe("the scan detects violations it is meant to catch", () => {
  const KERNEL_FILE = path.join(KERNEL_DIR, "gate.ts")

  test.each([
    ["a sibling inside the boundary", "./config.ts", "ok"],
    ["a node builtin", "node:fs", "bare"],
    ["a bare package", "lodash", "bare"],
    ["an escape to a sibling layer", "../runtime/index.ts", "escapes"],
    ["an escape above the package", "../../../elsewhere.ts", "escapes"],
  ] as const)("classifies %s", (_label, specifier, expected) => {
    expect(classifyImport(KERNEL_FILE, specifier, KERNEL_DIR)).toBe(expected)
  })

  test("flags an escape from the package root, not just from the kernel", () => {
    // src/runtime/x.ts sits two directories below PACKAGE_ROOT, so it takes
    // three ".." segments to actually leave PACKAGE_ROOT (two would only
    // land back at PACKAGE_ROOT itself, which is still inside it).
    expect(classifyImport(path.join(PACKAGE_ROOT, "src/runtime/x.ts"), "../../../outside.ts", PACKAGE_ROOT))
      .toBe("escapes")
  })

  test("treats the boundary directory itself as inside it", () => {
    expect(classifyImport(path.join(KERNEL_DIR, "sub/x.ts"), "..", KERNEL_DIR)).toBe("ok")
  })

  // Guards against a near-miss prefix comparison: a sibling directory whose
  // name merely starts with the boundary's name must count as an escape.
  test("is not fooled by a directory whose name shares the boundary's prefix", () => {
    expect(classifyImport(KERNEL_FILE, "../kernel-extras/x.ts", KERNEL_DIR)).toBe("escapes")
  })

  test.each(callFixtures.computedCallsThatShouldBeFlagged)(
    "flags %s as an unresolvable specifier",
    (_label, source) => {
      expect(source).toMatch(COMPUTED_CALL_PATTERN)
    },
  )

  test.each(callFixtures.literalCallsThatShouldNotBeFlagged)(
    "does not flag %s",
    (_label, source) => {
      expect(source).not.toMatch(COMPUTED_CALL_PATTERN)
    },
  )
})
