// Installation copies this package directory out of the repo, so an import
// that escapes the package root — or a runtime dependency from node_modules —
// breaks the installed plugin while passing tests in place. These scans are the
// only thing standing between "green in the repo" and "broken once installed".
import { describe, expect, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

const PACKAGE_ROOT = path.resolve(import.meta.dir, "..")
const KERNEL_DIR = path.join(PACKAGE_ROOT, "src", "kernel")
const SKILLS_DIR = path.join(PACKAGE_ROOT, "skills")
const EXTENSIONS_DIR = path.join(PACKAGE_ROOT, "src", "extensions")

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
export function importsIn(file: string): ImportRef[] {
  const source = fs.readFileSync(file, "utf8")
  // The gap between the keyword and "from" allows a quote ONLY inside a
  // balanced {...} brace group — a real import/export clause can legally
  // carry a quoted identifier there (ES2022 arbitrary module namespace
  // names, e.g. exporting a quoted string literal under an `as` alias, a
  // real tsc-valid re-export shape — but a
  // bare quote OUTSIDE any brace group is never part of the clause itself.
  // An earlier version excluded quotes entirely, which stopped a real
  // false-positive (bridging into a ported prompt string's prose that
  // happens to end a line in the word "from") but also blinded the scan to
  // the quoted-namespace case above (K2 review finding). This form catches
  // both: the brace-group alternative lets a quote through only when it is
  // properly enclosed, so it can never reach past a stray top-level quote
  // to bridge into unrelated string content.
  const pattern =
    /(?:\b(?:import|export)\b(?:[^"'`{}]|\{[^}]*\})*?\bfrom\s*|\bimport\s*|\brequire\s*)\(?\s*["']([^"']+)["']/g
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
  ...(fs.existsSync(SKILLS_DIR) ? sourceFiles(SKILLS_DIR) : []),
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
  quotedNamespaceReexportFixtures: [string, string][]
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

describe("skills isolation", () => {
  const guardedSources = [
    ...sourceFiles(path.join(PACKAGE_ROOT, "src", "kernel")),
    ...sourceFiles(path.join(PACKAGE_ROOT, "src", "adapters")),
    ...sourceFiles(path.join(PACKAGE_ROOT, "src", "runtime")),
  ]

  test("kernel, adapters and runtime import nothing from skills/", () => {
    const offenders = guardedSources
      .flatMap(importsIn)
      .filter(({ specifier }) => isRelative(specifier))
      .map(({ file, specifier }) => ({ file, resolved: path.resolve(path.dirname(file), specifier) }))
      .filter(({ resolved }) => resolved === SKILLS_DIR || resolved.startsWith(SKILLS_DIR + path.sep))
      .map(({ file }) => rel(file))

    expect(offenders).toEqual([])
  })

  // Built, not assumed: prove the guard actually flags a violation before
  // trusting the empty-offenders result above.
  test("the guard would catch a real violation", () => {
    const fakeFrom = path.join(PACKAGE_ROOT, "src", "kernel", "gate.ts")
    const resolved = path.resolve(path.dirname(fakeFrom), "../../skills/oneshot/run-once.ts")
    expect(resolved === SKILLS_DIR || resolved.startsWith(SKILLS_DIR + path.sep)).toBe(true)
  })
})

describe("extensions isolation", () => {
  test("kernel imports nothing from extensions/", () => {
    const offenders = sourceFiles(KERNEL_DIR)
      .flatMap(importsIn)
      .filter(({ specifier }) => isRelative(specifier))
      .map(({ file, specifier }) => ({ file, resolved: path.resolve(path.dirname(file), specifier) }))
      .filter(({ resolved }) => resolved === EXTENSIONS_DIR || resolved.startsWith(EXTENSIONS_DIR + path.sep))
      .map(({ file }) => rel(file))

    expect(offenders).toEqual([])
  })

  // adapters/ and runtime/ MAY depend on the extension seam's public
  // surface (registry.ts) — hook-cli.ts wires it in — but never reach past
  // it into extensions/config.ts or any future internal module there.
  test("adapters/ and runtime/ import from extensions/ only via a specifier ending extensions/registry.ts", () => {
    const guarded = [
      ...sourceFiles(path.join(PACKAGE_ROOT, "src", "adapters")),
      ...sourceFiles(path.join(PACKAGE_ROOT, "src", "runtime")),
    ]
    const offenders = guarded
      .flatMap(importsIn)
      .filter(({ specifier }) => isRelative(specifier))
      .map(({ file, specifier }) => ({ file, specifier, resolved: path.resolve(path.dirname(file), specifier) }))
      .filter(({ resolved }) => resolved === EXTENSIONS_DIR || resolved.startsWith(EXTENSIONS_DIR + path.sep))
      .filter(({ specifier }) => !specifier.endsWith("extensions/registry.ts"))
      .map(({ file, specifier }) => `${rel(file)} -> ${specifier}`)

    expect(offenders).toEqual([])
  })

  // Built, not assumed: prove the guard actually flags a violation before
  // trusting the empty-offenders results above. kernel/'s rule has no
  // registry.ts exception, unlike adapters/runtime's — so even the
  // "allowed elsewhere" specifier must still be flagged when it comes from
  // kernel/.
  test("the guard would catch a real violation", () => {
    const fakeFrom = path.join(PACKAGE_ROOT, "src", "kernel", "gate.ts")
    const resolved = path.resolve(path.dirname(fakeFrom), "../extensions/registry.ts")
    expect(resolved === EXTENSIONS_DIR || resolved.startsWith(EXTENSIONS_DIR + path.sep)).toBe(true)
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

  // ES2022 arbitrary module namespace identifiers — re-exporting a quoted
  // string literal under an alias — are real, tsc-valid syntax (confirmed
  // against tsc). A prior fix (K2 review) narrowed importsIn()'s import/
  // export-to-"from"
  // gap to exclude quote characters entirely, to stop it bridging across an
  // unrelated export into a ported prompt string's prose — but that also
  // blinded it to a quoted specifier legitimately living INSIDE the export
  // clause's own brace group. The guard must catch this real class.
  // Fixture text lives in import-scan-fixtures.json, not inline here, for
  // the same reason the computed-call fixtures above do (see that const's
  // own comment): a literal re-export-shaped string with a quoted brace
  // group embedded directly in this .ts file would itself be scanned as if it
  // were a real import of this file, self-inflicting the exact false-
  // positive class this fix exists to avoid.
  test.each(callFixtures.quotedNamespaceReexportFixtures)(
    "extracts the specifier from %s (ES2022 arbitrary module namespace, tsc-valid)",
    (_label, source) => {
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "imports-scan-test-"))
      try {
        const file = path.join(tmp, "reexport.ts")
        fs.writeFileSync(file, source)
        const refs = importsIn(file)
        expect(refs.map((r) => r.specifier)).toContain("../../../escapes.ts")
      } finally {
        fs.rmSync(tmp, { recursive: true, force: true })
      }
    },
  )

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

describe("known holes", () => {
  // KNOWN-HOLE(KI-9) — known-issues #9 addendum (0.8.0, extension-seam work):
  // COMPUTED_CALL_PATTERN is a text regex with no comment-awareness either
  // (the same root cause as the from-based scanner above). Two reword-to-pass
  // events on record: src/extensions/registry.ts (a comment illustrating the
  // forbidden `import(`./${name}.ts`)` shape) and
  // src/extensions/gauge/providers/cli-spawn.ts (a comment reading
  // "Self-registration on import (round-3 review...", where `import (` alone
  // — no computed specifier anywhere nearby — was enough to match). Both were
  // resolved by rewording the comment, not by fixing the scanner. (The
  // sibling `importsIn()`/`from`-based false positive that #9's main body
  // describes — the file-state-store.ts "old and merely / slow" prose — no
  // longer reproduces: the K2 quoted-namespace fix's quote-exclusion in the
  // import/export-to-"from" gap closed that specific bridging shape as a side
  // effect. This marker pins the addendum's still-open instance instead.)
  // Unskip when comments are stripped before the regex or a real parser
  // lands.
  test.skip("KNOWN-HOLE(KI-9): a comment describing a forbidden import(...) shape is not flagged as a computed call", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "imports-scan-test-"))
    try {
      const file = path.join(tmp, "prose.ts")
      // Recorded prose shape (known-issues.md #9 addendum, cli-spawn.ts
      // incident): a comment describing/forbidding a computed-import pattern
      // trips COMPUTED_CALL_PATTERN even with no real computed call anywhere
      // in the file.
      fs.writeFileSync(
        file,
        [
          "// Self-registration on import (round-3 review...) happens in the constructor.",
          "export const x = 1",
          "",
        ].join("\n"),
      )
      const source = fs.readFileSync(file, "utf8")
      const matches = [...source.matchAll(new RegExp(COMPUTED_CALL_PATTERN, "g"))]
      expect(matches).toEqual([]) // DESIRED: prose in a comment yields zero computed-call matches
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true })
    }
  })
})
