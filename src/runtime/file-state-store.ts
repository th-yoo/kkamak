import { createHash } from "node:crypto"
import fs from "node:fs"
import path from "node:path"
import { INITIAL_STATE, isGateState, isInitialState, normalizeGateState } from "../kernel/state.ts"
import type { GateState, StateStore } from "../kernel/ports.ts"

/**
 * One JSON record per session.
 *
 * load() never throws: absent, corrupt, wrong-shaped and future-versioned
 * records all read back as fresh initial state, so a half-written or tampered
 * file cannot break a hook.
 *
 * save() is allowed to throw: for a full disk or a permissions error, same as
 * before, and now also for a lost optimistic-concurrency race (see
 * StateStore.save's doc comment and docs/known-issues.md #8) — the kernel
 * already treats any persist failure as fail-open and logs it, and
 * swallowing the error here would hide either cause.
 */
export class FileStateStore implements StateStore {
  constructor(private readonly dir: string) {}

  load(sessionID: string): GateState {
    return this.readRecord(this.recordPath(sessionID))
  }

  save(sessionID: string, state: GateState, expectedUpdatedAt: number): void {
    const file = this.recordPath(sessionID)

    // Compare-and-swap: re-read what is actually on disk right before
    // committing. A check can run for minutes (checkTimeoutMs), so a caller
    // sitting on a `load()` from before that wait started is exactly the
    // stale writer this guards against — it must not blindly overwrite
    // whatever landed while it waited. This does not close every window (a
    // second process could still land a write between this read and the
    // rename below); it closes the one this store can close without an OS
    // lock, which is the one that matters here — see docs/known-issues.md #8
    // for the write-up and why a full advisory lock was left for later.
    const current = this.readRecord(file)
    if (current.updatedAt !== expectedUpdatedAt) {
      throw new Error(
        `stale write refused for session ${sessionID}: expected updatedAt ` +
          `${expectedUpdatedAt}, found ${current.updatedAt} on disk — a newer write landed first`,
      )
    }

    // Monotonic, not just "now": two saves inside one save() burst (or a
    // clock that hasn't ticked a full ms) must never stamp the same
    // updatedAt, or the very next compare-and-swap above would be fooled by
    // its own prior write.
    const updatedAt = Math.max(Date.now(), current.updatedAt + 1)
    const stamped: GateState = { ...state, updatedAt }

    // Awkward case 1: absent entirely. `current` from readRecord() above is
    // then `{...INITIAL_STATE}` (updatedAt 0), which is exactly what
    // `expectedUpdatedAt === 0` just matched against — the sentinel for "no
    // record existed at load time" and "no record exists now" are the same
    // value on purpose, so a first-ever save needs no special case here.

    // Awkward case 2: the state being saved is itself initial-equivalent.
    // Absent already means initial, so writing an equivalent-to-empty record
    // would only litter the directory — delete instead. This now happens
    // only after the compare-and-swap above has already confirmed nothing
    // newer landed, so a stale reset can no longer delete a concurrent
    // writer's real progress out from under it.
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

  private readRecord(file: string): GateState {
    let raw: string
    try {
      raw = fs.readFileSync(file, "utf8")
    } catch {
      return { ...INITIAL_STATE }
    }

    try {
      const parsed: unknown = JSON.parse(raw)
      return isGateState(parsed) ? normalizeGateState(parsed) : { ...INITIAL_STATE }
    } catch {
      return { ...INITIAL_STATE }
    }
  }

  private recordPath(sessionID: string): string {
    return path.join(this.dir, `${recordName(sessionID)}.json`)
  }
}

/**
 * Session ids come from the harness, so they are untrusted: a readable
 * sanitised stem keeps the directory browsable, and a hash of the original id
 * keeps two ids that sanitise alike (`a/b` and `a:b`) from colliding.
 */
export function recordName(sessionID: string): string {
  const stem = sessionID.replace(/[^A-Za-z0-9._-]/g, "_").replace(/^\.+/, "_").slice(0, 64) || "_"
  const digest = createHash("sha256").update(sessionID).digest("hex").slice(0, 12)
  return `${stem}-${digest}`
}
