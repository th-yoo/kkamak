import os from "node:os"
import type { Clock, Logger } from "../kernel/ports.ts"

export const SystemClock: Clock = {
  now: () => Date.now(),
}

/** Best-effort. A machine that will not name itself is not worth failing over. */
export function systemHostname(): string {
  try {
    return os.hostname() || "unknown"
  } catch {
    return "unknown"
  }
}

/**
 * Diagnostics go to stderr, which every harness treats as log output rather
 * than as part of a hook's protocol response on stdout. Never throws — the
 * kernel logs from inside its own error handlers.
 */
export const StderrLogger: Logger = {
  log(message: string): void {
    try {
      process.stderr.write(`${message}\n`)
    } catch {
      // Nothing left to report with.
    }
  },
}
