import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { makeCliSpawnProvider } from "../src/extensions/gauge/providers/cli-spawn.ts"
import { GAUGE_ISOLATION } from "../src/extensions/gauge/send-prompt.ts"
import type { SendPromptOptions } from "../src/extensions/gauge/send-prompt.ts"

// Stub binary via an absolute path passed directly to makeCliSpawnProvider
// — that parameter is already the test seam (production always gets
// "claude" resolved off PATH by Bun.spawn), so a stub script's real
// filesystem path is indistinguishable from the CLI to the function under
// test. No PATH manipulation needed.
let dir: string
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), "cli-spawn-test-")) })
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }) })

function writeStub(body: string): string {
  const file = path.join(dir, "claude-stub.sh")
  fs.writeFileSync(file, `#!/usr/bin/env bash\n${body}\n`)
  fs.chmodSync(file, 0o755)
  return file
}

const OPTS: SendPromptOptions = {
  model: "claude-haiku-4-5",
  isolation: GAUGE_ISOLATION,
  provider: "cli-spawn",
}

describe("cli-spawn provider", () => {
  test("a passing stub's stdout comes back as the SendOutcome's text", async () => {
    const stub = writeStub(`echo '{"type":"result","subtype":"success","is_error":false,"result":"stub answer"}'`)
    const provider = makeCliSpawnProvider(stub)
    const outcome = await provider("say hi", OPTS)
    expect(outcome).toEqual({
      ok: true,
      text: "stub answer",
      model: "claude-haiku-4-5",
      canonicalModel: "claude-haiku-4-5",
    })
  })

  test("a hanging stub times out to a failure outcome, resolving under the budget + margin, never rejecting", async () => {
    const stub = writeStub("sleep 30")
    const provider = makeCliSpawnProvider(stub)
    const timeoutMs = 200
    const started = Date.now()
    const outcome = await provider("say hi", { ...OPTS, timeoutMs })
    const elapsed = Date.now() - started
    expect(outcome).toEqual({ ok: false, kind: "call-consumed" })
    expect(elapsed).toBeLessThan(timeoutMs + 5_000) // generous margin for CI/process scheduling
  }, 10_000)

  test("a missing binary resolves to a no-call failure outcome, never throws", async () => {
    const provider = makeCliSpawnProvider(path.join(dir, "definitely-does-not-exist"))
    const outcome = await provider("say hi", OPTS)
    expect(outcome).toEqual({ ok: false, kind: "no-call" })
  })

  test("a nonzero exit resolves to a call-consumed failure outcome", async () => {
    const stub = writeStub("echo 'boom' 1>&2; exit 1")
    const provider = makeCliSpawnProvider(stub)
    const outcome = await provider("say hi", OPTS)
    expect(outcome).toEqual({ ok: false, kind: "call-consumed" })
  })

  test("malformed stdout (not the expected result-event JSON) resolves to call-consumed, not a throw", async () => {
    const stub = writeStub("echo 'not json at all'")
    const provider = makeCliSpawnProvider(stub)
    const outcome = await provider("say hi", OPTS)
    expect(outcome).toEqual({ ok: false, kind: "call-consumed" })
  })

  test("is_error:true in the result event resolves to call-consumed", async () => {
    const stub = writeStub(`echo '{"type":"result","subtype":"error","is_error":true,"result":"auth failed"}'`)
    const provider = makeCliSpawnProvider(stub)
    const outcome = await provider("say hi", OPTS)
    expect(outcome).toEqual({ ok: false, kind: "call-consumed" })
  })

  // K3 review, fix round 1: confirmed against the installed CLI's own
  // --help that `--tools ""` is the documented disable-all-tools form, and
  // that `--disallowedTools "*"` (this file's first draft) is undocumented
  // wildcard usage. This test pins the ACTUAL flag emitted, not just that
  // behavior happens to work regardless — the earlier tests never
  // inspected argv beyond prompt/model position, so this gap was real.
  test("zero-tools isolation emits the documented --tools \"\" form, not --disallowedTools", async () => {
    const stub = writeStub(`
      argv="$*"
      if [[ "$argv" == *"--disallowedTools"* ]]; then echo '{"type":"result","is_error":true,"result":"used undocumented flag"}'; exit 0; fi
      if [[ "$argv" != *'--tools '* ]]; then echo '{"type":"result","is_error":true,"result":"missing --tools"}'; exit 0; fi
      echo '{"type":"result","subtype":"success","is_error":false,"result":"ok"}'
    `)
    const provider = makeCliSpawnProvider(stub)
    const outcome = await provider("say hi", OPTS)
    expect(outcome).toEqual({ ok: true, text: "ok", model: "claude-haiku-4-5", canonicalModel: "claude-haiku-4-5" })
  })

  test("the prompt and model are passed through, never hardcoded", async () => {
    const stub = writeStub(`
      # Args: -p <prompt> --output-format json --model <model> --strict-mcp-config ...
      if [[ "$2" != "custom prompt text" ]]; then echo '{"type":"result","is_error":true,"result":"wrong prompt"}'; exit 0; fi
      echo '{"type":"result","subtype":"success","is_error":false,"result":"ok: '"$6"'"}'
    `)
    const provider = makeCliSpawnProvider(stub)
    const outcome = await provider("custom prompt text", { ...OPTS, model: "claude-opus-5" })
    expect(outcome).toEqual({
      ok: true,
      text: "ok: claude-opus-5",
      model: "claude-opus-5",
      canonicalModel: "claude-opus-5",
    })
  })
})
