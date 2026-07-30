import fs from "node:fs"
import path from "node:path"
import type { ConfigSource } from "../kernel/ports.ts"

export const CONFIG_FILENAME = "gate.json"

/**
 * Reads gate.json from the repo root on every call and caches nothing. The
 * kernel's escape hatch — edit or delete the file and the next turn obeys it —
 * only works if this really does hit the filesystem each time.
 */
export class FileConfigSource implements ConfigSource {
  constructor(private readonly root: string) {}

  read(): string | undefined {
    try {
      return fs.readFileSync(path.join(this.root, CONFIG_FILENAME), "utf8")
    } catch {
      // Absent, unreadable, or not a file. All mean "no gate configured".
      return undefined
    }
  }
}
