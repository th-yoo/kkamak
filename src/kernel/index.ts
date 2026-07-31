// Public surface of the kernel. A harness adapter should need nothing else.
export type {
  Clock,
  CheckResult,
  CheckRunner,
  ConfigSource,
  Gate,
  GateConfig,
  GateDecision,
  GateEvent,
  GateHost,
  GateState,
  HostInfo,
  Logger,
  RoundOutcome,
  SensorLine,
  SensorSink,
  StateStore,
} from "./ports.ts"

export { createGate, ERROR_STREAK_LIMIT, HYGIENE_MARKER } from "./gate.ts"
export {
  DEFAULT_CHECK_TIMEOUT_MS,
  DEFAULT_MARKER,
  DEFAULT_ROUNDS,
  DEFAULT_SENSOR_PATH,
  parseGateConfig,
} from "./config.ts"
export { INITIAL_STATE, isGateState, isInitialState, normalizeGateState } from "./state.ts"
export { buildSensorLine, OPTIONAL_SENSOR_FIELDS, SENSOR_FIELDS, type SensorArgs } from "./sensor.ts"
