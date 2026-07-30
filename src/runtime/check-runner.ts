import { spawn } from "node:child_process"
import type { CheckResult, CheckRunner } from "../kernel/ports.ts"

/** Exit code convention for a killed-on-timeout command, as used by timeout(1). */
export const TIMEOUT_EXIT_CODE = 124

/**
 * Runs the configured check in a shell, merging stdout and stderr because test
 * runners report failures on stderr and that output is the evidence the gate
 * exists to deliver.
 *
 * Only a genuine spawn failure rejects. A missing command, a nonzero exit and a
 * timeout are all verdicts, reported as a nonzero code — the kernel treats a
 * rejection as an internal error that counts toward disarming the session, so
 * misreporting a failing check as one would eventually switch the gate off.
 */
export class SpawnCheckRunner implements CheckRunner {
  constructor(private readonly cwd: string) {}

  run(command: string, timeoutMs: number): Promise<CheckResult> {
    return new Promise<CheckResult>((resolve, reject) => {
      let child
      try {
        child = spawn(command, {
          cwd: this.cwd,
          shell: true,
          // Its own process group, so a timeout kills the whole tree rather
          // than orphaning the grandchildren a test runner spawns.
          detached: true,
          stdio: ["ignore", "pipe", "pipe"],
        })
      } catch (err) {
        reject(err instanceof Error ? err : new Error(String(err)))
        return
      }

      const chunks: string[] = []
      let settled = false
      let timedOut = false

      child.stdout?.setEncoding("utf8")
      child.stderr?.setEncoding("utf8")
      child.stdout?.on("data", (c: string) => chunks.push(c))
      child.stderr?.on("data", (c: string) => chunks.push(c))

      const timer = setTimeout(() => {
        timedOut = true
        killTree(child.pid)
      }, timeoutMs)

      const finish = (result: CheckResult) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        resolve(result)
      }

      child.on("error", (err) => {
        // A shell was requested, so this is a failure to start the shell
        // itself, not a bad command — a genuine internal error.
        if (settled) return
        settled = true
        clearTimeout(timer)
        reject(err)
      })

      child.on("close", (code, signal) => {
        // Partial output is kept: it is often the most useful part of a
        // timed-out run.
        const output = chunks.join("")
        if (timedOut) {
          finish({
            code: TIMEOUT_EXIT_CODE,
            output: `${output}\nkkamak: check timed out after ${timeoutMs}ms and was killed`,
          })
          return
        }
        finish({ code: code ?? (signal ? TIMEOUT_EXIT_CODE : 1), output })
      })
    })
  }
}

function killTree(pid: number | undefined): void {
  if (pid === undefined) return
  try {
    // Negative pid targets the process group created by `detached: true`.
    process.kill(-pid, "SIGKILL")
  } catch {
    try {
      process.kill(pid, "SIGKILL")
    } catch {
      // Already gone.
    }
  }
}
