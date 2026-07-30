// Node/Bun implementations of the kernel's ports. This layer owns every effect
// — filesystem, subprocess, clock, hostname — and knows nothing about any
// harness. Adapters wire a host from here and hand it to createGate.
import path from "node:path"
import { SpawnCheckRunner } from "./check-runner.ts"
import { FileConfigSource } from "./config-source.ts"
import { FileStateStore } from "./file-state-store.ts"
import { NdjsonSensorSink } from "./ndjson-sink.ts"
import { StderrLogger, SystemClock, systemHostname } from "./system.ts"
import type { GateHost } from "../kernel/ports.ts"

/** Per-session state lives here, relative to the repo root. */
export const STATE_DIR = path.join(".km", "gate")

export interface NodeHostOptions {
  /** Repo root: gate.json, the sensor file and the state directory hang off it. */
  root: string
  /** Harness identity recorded on every sensor line, e.g. "claude-code". */
  app: string
}

export function createNodeHost(options: NodeHostOptions): GateHost {
  const { root, app } = options
  return {
    info: { app, host: systemHostname() },
    config: new FileConfigSource(root),
    state: new FileStateStore(path.join(root, STATE_DIR)),
    sensor: new NdjsonSensorSink(root),
    check: new SpawnCheckRunner(root),
    clock: SystemClock,
    logger: StderrLogger,
  }
}

export { SpawnCheckRunner, TIMEOUT_EXIT_CODE } from "./check-runner.ts"
export { CONFIG_FILENAME, FileConfigSource } from "./config-source.ts"
export { FileStateStore, recordName } from "./file-state-store.ts"
export { NdjsonSensorSink } from "./ndjson-sink.ts"
export { StderrLogger, SystemClock, systemHostname } from "./system.ts"
