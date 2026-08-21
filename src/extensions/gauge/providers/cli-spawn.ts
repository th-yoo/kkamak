// cli-spawn.ts — kkamak's ONE shipped SendPromptProvider (K3). Cold-spawns
// the `claude` CLI headlessly per call: no daemon, no SDK, no keep-alive.
// Registers under CLI_SPAWN_PROVIDER_ID; the extensions registry itself
// stays empty until a later task actually wires gauge in.
import type { SendOutcome, SendPromptOptions, SendPromptProvider } from "../send-prompt.ts"

const DEFAULT_TIMEOUT_MS = 60_000

interface ClaudeResultEvent {
  type: string
  is_error?: boolean
  result?: string
}

/** Argv for a `claude -p` headless, single-turn call (binary name/path is
 * the caller's job — see makeCliSpawnProvider). Model and prompt always
 * come from the caller (SendPromptOptions), never hardcoded.
 * --output-format json (not stream-json): a single terminal JSON object is
 * all a one-shot text-out call needs — the {type:"result", is_error,
 * result} shape matches opencode-plugin's bench claude-code driver's own
 * result-event schema (bench/drivers/claude-code.ts), read there as
 * evidence for this port even though that driver itself runs full agentic
 * sessions, a different use case from gauge's bare-model probe.
 *
 * Isolation mapping (WarmIsolation -> CLI flags) has no direct repo
 * precedent — nothing in either repo cold-spawns `claude -p` under a
 * no-tools/strict-mcp isolation profile yet. --append-system-prompt and
 * --strict-mcp-config are documented Claude Code CLI flags, applied here
 * on best-available knowledge rather than a pinned citation. --tools
 * (below) was confirmed directly against the installed CLI's own --help
 * text (K3 review finding, fix round 1): `--tools ""` is the documented
 * disable-all-tools form; a bare `--disallowedTools "*"` — this file's
 * first draft — relies on undocumented wildcard semantics the CLI's help
 * never claims (--disallowedTools takes concrete names/patterns, e.g.
 * "Bash(git *) Edit", never a wildcard; a nonexistent literal tool named
 * "*" would plausibly deny nothing, leaving default tools available).
 * Documented flag beats undocumented wildcard, but neither is a LIVE
 * one-call measurement yet — still worth confirming end-to-end before
 * this provider is ever actually wired into the registry. */
function buildArgs(prompt: string, opts: SendPromptOptions): string[] {
  const args = ["-p", prompt, "--output-format", "json", "--model", opts.model, "--strict-mcp-config"]
  if (opts.isolation.systemPrompt) args.push("--append-system-prompt", opts.isolation.systemPrompt)
  // WarmIsolation.tools is always [] (gauge/reasoning isolation never
  // grants tools) — the CLI's own --help documents `--tools ""` as the
  // disable-all-tools form; a nonempty tools list (not currently reachable
  // from any shipped WarmIsolation value) passes the names through.
  args.push("--tools", opts.isolation.tools.join(" "))
  return args
}

/**
 * Builds a SendPromptProvider bound to a specific binary name or path.
 * `binary` is the test seam: production always gets "claude" (resolved off
 * PATH by Bun.spawn); a test passes an absolute path to a stub script,
 * indistinguishable to this function from the real CLI.
 *
 * Contract (K3): resolves a SendOutcome, never throws, never blocks the
 * gate.
 * - Missing binary -> `no-call`. Bun.spawn throws SYNCHRONOUSLY when the
 *   executable can't be found (confirmed empirically) — unlike
 *   check-runner.ts's SpawnCheckRunner, which runs `shell: true` and so
 *   sees a missing command as the SHELL's own nonzero exit, this call has
 *   no shell mediating it, so a missing binary never starts a process at
 *   all: nothing was sent.
 * - Timeout / nonzero exit -> `call-consumed`. The process genuinely
 *   started in both cases, so whether prompt bytes reached the model
 *   before it died or was killed is unprovable from out here — the same
 *   conservative policy send-prompt.ts's own `sendPrompt()` already
 *   applies to a provider that throws.
 */
export function makeCliSpawnProvider(binary = "claude"): SendPromptProvider {
  return (prompt, opts) =>
    new Promise<SendOutcome>((resolve) => {
      const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS
      let settled = false
      const finish = (outcome: SendOutcome): void => {
        if (settled) return
        settled = true
        resolve(outcome)
      }

      let proc: ReturnType<typeof Bun.spawn>
      try {
        proc = Bun.spawn([binary, ...buildArgs(prompt, opts)], {
          stdout: "pipe",
          stderr: "pipe",
          stdin: "ignore",
        })
      } catch {
        finish({ ok: false, kind: "no-call" })
        return
      }

      const timer = setTimeout(() => {
        proc.kill("SIGKILL")
        finish({ ok: false, kind: "call-consumed" })
      }, timeoutMs)

      void (async () => {
        const stdoutText = await new Response(proc.stdout as ReadableStream<Uint8Array>).text()
        const code = await proc.exited
        clearTimeout(timer)
        if (settled) return // the timeout branch already resolved

        if (code !== 0) {
          finish({ ok: false, kind: "call-consumed" })
          return
        }
        let parsed: unknown
        try {
          parsed = JSON.parse(stdoutText)
        } catch {
          finish({ ok: false, kind: "call-consumed" })
          return
        }
        const event = parsed as ClaudeResultEvent
        if (event.type !== "result" || event.is_error || typeof event.result !== "string") {
          finish({ ok: false, kind: "call-consumed" })
          return
        }
        finish({ ok: true, text: event.result, model: opts.model, canonicalModel: opts.model })
      })()
    })
}

/** kkamak's registered provider id for this transport. */
export const CLI_SPAWN_PROVIDER_ID = "cli-spawn"

/** Production provider, bound to the real "claude" binary off PATH. */
export const cliSpawnProvider: SendPromptProvider = makeCliSpawnProvider()
