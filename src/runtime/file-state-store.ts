import { createHash } from "node:crypto"
import fs from "node:fs"
import path from "node:path"
import { INITIAL_STATE, isGateState, isInitialState } from "../kernel/state.ts"
import type { GateState, StateStore } from "../kernel/ports.ts"

/**
 * One JSON record per session.
 *
 * load() never throws: absent, corrupt, wrong-shaped and future-versioned
 * records all read back as fresh initial state, so a half-written or tampered
 * file cannot break a hook.
 *
 * save() is allowed to throw. The kernel already treats a persist failure as
 * fail-open and logs it, and swallowing the error here would hide a full disk.
 */
export class FileStateStore implements StateStore {
  constructor(private readonly dir: string) {}

  load(sessionId: string): GateState {
    let raw: string
    try {
      raw = fs.readFileSync(this.recordPath(sessionId), "utf8")
    } catch {
      return { ...INITIAL_STATE }
    }

    try {
      const parsed: unknown = JSON.parse(raw)
      return isGateState(parsed) ? parsed : { ...INITIAL_STATE }
    } catch {
      return { ...INITIAL_STATE }
    }
  }

  save(sessionId: string, state: GateState): void {
    const stamped: GateState = { ...state, updatedAt: Date.now() }
    const file = this.recordPath(sessionId)

    // Absent already means initial, so writing an equivalent-to-empty record
    // would only litter the directory.
    if (isInitialState(stamped)) {
      fs.rmSync(file, { force: true })
      return
    }

    fs.mkdirSync(this.dir, { recursive: true })
    // Same-directory temp plus rename, so a concurrent reader — or a process
    // killed mid-write — never observes a torn record.
    const tmp = `${file}.${process.pid}.tmp`
    fs.writeFileSync(tmp, `${JSON.stringify(stamped, null, 2)}\n`)
    fs.renameSync(tmp, file)
  }

  private recordPath(sessionId: string): string {
    return path.join(this.dir, `${recordName(sessionId)}.json`)
  }
}

/**
 * Session ids come from the harness, so they are untrusted: a readable
 * sanitised stem keeps the directory browsable, and a hash of the original id
 * keeps two ids that sanitise alike (`a/b` and `a:b`) from colliding.
 */
export function recordName(sessionId: string): string {
  const stem = sessionId.replace(/[^A-Za-z0-9._-]/g, "_").replace(/^\.+/, "_").slice(0, 64) || "_"
  const digest = createHash("sha256").update(sessionId).digest("hex").slice(0, 12)
  return `${stem}-${digest}`
}
