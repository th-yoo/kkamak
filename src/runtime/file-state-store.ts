import { createHash } from "node:crypto"
import fs from "node:fs"
import path from "node:path"
import { INITIAL_STATE, isGateState, isInitialState, normalizeGateState } from "../kernel/state.ts"
import type { GateState, StateStore } from "../kernel/ports.ts"

/**
 * How long save() spins trying to acquire the lockfile before giving up and
 * running its critical section unlocked instead (still compare-and-swap
 * protected — see withLock's doc comment). The critical section is a
 * handful of synchronous fs calls with no awaits in it, so real contention
 * should clear in well under this; it exists as a bound, not a target.
 */
const DEFAULT_LOCK_ACQUIRE_TIMEOUT_MS = 500

/**
 * How old a lockfile has to be before it's treated as abandoned by a killed
 * process rather than a live critical section, and reclaimed rather than
 * waited out. Comfortably longer than any real critical section could take.
 */
const DEFAULT_LOCK_STALE_MS = 2_000

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
 *
 * save()'s whole read-modify-write also runs under a best-effort lockfile
 * (see withLock's doc comment): two concurrent save() calls for the same
 * session now serialize instead of racing to land in the gap between one's
 * compare-and-swap read and its rename, closing the window the version
 * check alone could not.
 */
export class FileStateStore implements StateStore {
  constructor(
    private readonly dir: string,
    private readonly lockAcquireTimeoutMs = DEFAULT_LOCK_ACQUIRE_TIMEOUT_MS,
    private readonly lockStaleMs = DEFAULT_LOCK_STALE_MS,
  ) {}

  load(sessionID: string): GateState {
    return this.readRecord(this.recordPath(sessionID))
  }

  save(sessionID: string, state: GateState, expectedUpdatedAt: number): void {
    fs.mkdirSync(this.dir, { recursive: true })
    const file = this.recordPath(sessionID)
    this.withLock(file, () => this.commit(file, sessionID, state, expectedUpdatedAt))
  }

  /**
   * The compare-and-swap read, the decision, and the commit (write or
   * delete) — the whole read-modify-write withLock() holds a lock across,
   * not just the final write.
   */
  private commit(file: string, sessionID: string, state: GateState, expectedUpdatedAt: number): void {
    // Compare-and-swap: re-read what is actually on disk right before
    // committing. A check can run for minutes (checkTimeoutMs), so a caller
    // sitting on a `load()` from before that wait started is exactly the
    // stale writer this guards against — it must not blindly overwrite
    // whatever landed while it waited.
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
    // would only litter the directory — delete instead. This runs under the
    // same lock and after the same compare-and-swap as the write path below,
    // so a stale reset can no longer delete a concurrent writer's real
    // progress out from under it.
    if (isInitialState(stamped)) {
      fs.rmSync(file, { force: true })
      return
    }

    // Same-directory temp plus rename, so a concurrent reader — or a process
    // killed mid-write — never observes a torn record.
    const tmp = `${file}.${process.pid}.tmp`
    fs.writeFileSync(tmp, `${JSON.stringify(stamped, null, 2)}\n`)
    fs.renameSync(tmp, file)
  }

  /**
   * Best-effort mutual exclusion around commit()'s whole read-modify-write,
   * so two concurrent save() calls for the same session can never
   * interleave one's compare-and-swap read with the other's rename — the
   * gap docs/known-issues.md #8 names as still open after the version check
   * alone. Implemented as a lockfile via atomic O_CREAT|O_EXCL create
   * (`"wx"`): Node's fs exposes no real flock syscall without a native
   * addon, and this is the technique effectively every userland Node
   * lockfile library uses instead. Depends on the filesystem honouring
   * O_EXCL atomically — true of local filesystems and modern NFS, not
   * guaranteed on very old NFS, the same caveat a real flock would have
   * there too.
   *
   * Absolute constraint: a lock that cannot be acquired, a stale lock left
   * by a killed process, or a filesystem that rejects the lock operation
   * outright must never wedge a session or block a turn permanently. So:
   * acquisition is bounded (lockAcquireTimeoutMs); a lock is reclaimed
   * rather than waited out only once it is both older than lockStaleMs AND
   * its recorded holder pid is confirmed dead, not on age alone (see
   * reclaimIfStale — age alone would let a merely slow, still-live holder
   * get its lock stolen out from under it); and any acquisition failure —
   * timeout, or the lock write itself failing for a reason other than
   * contention (EACCES, EROFS, an unsupported operation) — falls through
   * to running the critical section unlocked rather than throwing or
   * waiting indefinitely. Unlocked is not unsafe here: commit()'s own
   * compare-and-swap still applies, so a save that runs unlocked is exposed
   * only to the one microscopic race this lock exists to close, not to the
   * much larger one the version check already closes on its own.
   */
  private withLock<T>(file: string, run: () => T): T {
    const lockPath = `${file}.lock`
    const deadline = Date.now() + this.lockAcquireTimeoutMs
    let locked = false

    do {
      try {
        // Atomic create-and-write: the pid is what lets a later, stalled
        // acquire attempt distinguish an abandoned lock from a merely slow
        // one (see reclaimIfStale below), instead of guessing by age alone.
        fs.writeFileSync(lockPath, String(process.pid), { flag: "wx" })
        locked = true
      } catch (err) {
        if (errorCode(err) !== "EEXIST") break // locking unavailable here — degrade now
        this.reclaimIfStale(lockPath)
      }
    } while (!locked && Date.now() < deadline)

    if (!locked) return run()

    try {
      return run()
    } finally {
      fs.rmSync(lockPath, { force: true })
    }
  }

  /**
   * Reclaims a lock only when BOTH hold: it is older than lockStaleMs, AND
   * the pid recorded in it (at acquire time, above) no longer exists
   * (`process.kill(pid, 0)` throws ESRCH). Age alone is not enough — a
   * holder can be merely slow rather than dead (a disk stall, scheduler
   * preemption, a throttled cgroup, all realistic under WSL2), and stealing
   * a live holder's lock lets two commit() calls run concurrently, both
   * reading the same pre-write value and both passing their own
   * compare-and-swap: the exact lost update this lock exists to prevent,
   * now masked by an apparently successful lock cycle instead of surfaced
   * as a conflict. If the pid cannot be read or parsed, the lock is left
   * alone rather than guessed at — that failure mode falls back to the
   * bounded acquire timeout in withLock, which is what actually keeps this
   * from wedging a session either way, not this staleness check.
   */
  private reclaimIfStale(lockPath: string): void {
    try {
      const age = Date.now() - fs.statSync(lockPath).mtimeMs
      if (age <= this.lockStaleMs) return

      const holder = Number.parseInt(fs.readFileSync(lockPath, "utf8"), 10)
      if (Number.isNaN(holder) || isProcessAlive(holder)) return

      fs.rmSync(lockPath, { force: true })
    } catch {
      // Gone already, or unreadable — either way the next loop iteration's
      // own open attempt settles it.
    }
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

/** Avoids depending on the ambient NodeJS.ErrnoException type. */
function errorCode(err: unknown): string | undefined {
  return typeof err === "object" && err !== null && "code" in err ? String((err as { code: unknown }).code) : undefined
}

/**
 * True if `pid` exists, or if it exists but signalling it is not permitted
 * (a different user's process — still alive, just unconfirmable further).
 * False only on a confirmed ESRCH: no such process. Signal 0 sends nothing;
 * it only probes for existence and permission.
 */
function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    return errorCode(err) !== "ESRCH"
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
