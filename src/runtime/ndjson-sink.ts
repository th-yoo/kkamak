import fs from "node:fs"
import path from "node:path"
import type { SensorLine, SensorSink } from "../kernel/ports.ts"

/**
 * Append-only newline-delimited JSON. One line per completed gate cycle, which
 * is the record the self-improvement loop reads back.
 *
 * Throwing is fine: the kernel contains a sink failure and keeps the decision
 * it already made, so a full disk costs an observation rather than a session.
 */
export class NdjsonSensorSink implements SensorSink {
  constructor(private readonly root: string) {}

  append(line: SensorLine, relativePath: string): void {
    const file = this.resolveInsideRoot(relativePath)
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.appendFileSync(file, `${JSON.stringify(line)}\n`)
  }

  /** `sensor` is user configuration, so it must not be able to write anywhere. */
  private resolveInsideRoot(relativePath: string): string {
    const root = path.resolve(this.root)
    const file = path.resolve(root, relativePath)
    if (file !== root && !file.startsWith(root + path.sep)) {
      throw new Error(`kkamak: sensor path escapes the repo root: ${relativePath}`)
    }
    return file
  }
}
