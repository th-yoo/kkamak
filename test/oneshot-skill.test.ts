import { describe, expect, test } from "bun:test"
import fs from "node:fs"
import path from "node:path"

const SKILL = path.join(import.meta.dir, "..", "skills", "oneshot", "SKILL.md")

describe("skills/oneshot/SKILL.md", () => {
  test("exists and has YAML frontmatter with a name and description", () => {
    const text = fs.readFileSync(SKILL, "utf8")
    expect(text.startsWith("---\n")).toBe(true)
    expect(text).toMatch(/^name:\s*oneshot\s*$/m)
    expect(text).toMatch(/^description:.+/m)
  })

  test("never tells Claude to write a literal ${CLAUDE_PLUGIN_ROOT} token into a script", () => {
    const text = fs.readFileSync(SKILL, "utf8")
    // The confirmed-broken pattern (rev 1/6): a literal token meant for a
    // spawned subshell to expand at its own runtime. The doc MAY mention
    // the token when explaining why NOT to use it, so this only fails if
    // it appears inside a fenced shell code block (where it would actually
    // be executed if copied verbatim).
    const codeBlocks = [...text.matchAll(/```(?:bash|sh)?\n([\s\S]*?)```/g)].map((m) => m[1]!)
    for (const block of codeBlocks) {
      expect(block).not.toContain("${CLAUDE_PLUGIN_ROOT}")
    }
  })

  test("references template.sh by relative path rather than inlining its content", () => {
    const text = fs.readFileSync(SKILL, "utf8")
    expect(text).toContain("template.sh")
    // No duplicated retry-loop source: the distinctive loop line from
    // template.sh should not also appear verbatim in SKILL.md.
    const template = fs.readFileSync(path.join(import.meta.dir, "..", "skills", "oneshot", "template.sh"), "utf8")
    const distinctiveLine = template.split("\n").find((l) => l.includes("MAX_ATTEMPTS"))!
    expect(text).not.toContain(distinctiveLine)
  })

  test("mentions the Base directory line as the path-resolution mechanism", () => {
    const text = fs.readFileSync(SKILL, "utf8")
    expect(text).toContain("Base directory for this skill")
  })

  test("mentions rounds + 1 as the attempt bound, matching the gate's own semantics", () => {
    const text = fs.readFileSync(SKILL, "utf8")
    expect(text.toLowerCase()).toMatch(/rounds.*\+.*1|rounds.*plus.*one/)
  })
})
