import fs from "node:fs"
import path from "node:path"

/**
 * Append-only NDJSON, one call per line. `file` is an already-resolved
 * absolute path — callers own path construction, this just writes.
 */
export function appendNdjsonLine(file: string, obj: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.appendFileSync(file, `${JSON.stringify(obj)}\n`)
}
