import { describe, expect, test } from "bun:test"
import { INITIAL_STATE, isGateState, isInitialState } from "../src/kernel/state.ts"
import type { GateState } from "../src/kernel/ports.ts"

describe("INITIAL_STATE", () => {
  test("is fully stood down", () => {
    expect(INITIAL_STATE).toEqual({
      v: 1,
      edited: false,
      gating: false,
      round: 0,
      outcomes: [],
      cycleStartedAt: 0,
      errorStreak: 0,
      disarmed: false,
      updatedAt: 0,
    })
  })

  test("is recognised as initial", () => {
    expect(isInitialState(INITIAL_STATE)).toBe(true)
  })

  test("updatedAt does not affect initial-equivalence", () => {
    expect(isInitialState({ ...INITIAL_STATE, updatedAt: 999 })).toBe(true)
  })

  test.each([
    ["edited", { edited: true }],
    ["gating", { gating: true }],
    ["round", { round: 1 }],
    ["outcomes", { outcomes: ["failed" as const] }],
    ["cycleStartedAt", { cycleStartedAt: 5 }],
    ["errorStreak", { errorStreak: 1 }],
    ["disarmed", { disarmed: true }],
  ])("is not initial once %s is set", (_label, patch) => {
    expect(isInitialState({ ...INITIAL_STATE, ...patch })).toBe(false)
  })
})

describe("isGateState", () => {
  test("accepts a well-formed state", () => {
    expect(isGateState(INITIAL_STATE)).toBe(true)
  })

  test("accepts a state carrying real cycle data", () => {
    const s: GateState = {
      ...INITIAL_STATE,
      edited: true,
      gating: true,
      round: 2,
      outcomes: ["failed", "failed"],
      cycleStartedAt: 100,
    }
    expect(isGateState(s)).toBe(true)
  })

  // A rejected shape reads back as fresh initial state in the store, so a
  // tampered or half-written file can never break a hook.
  test.each([
    ["null", null],
    ["undefined", undefined],
    ["a number", 7],
    ["a string", "state"],
    ["an array", []],
    ["an unknown version", { ...INITIAL_STATE, v: 2 }],
    ["a missing field", { v: 1, edited: false }],
    ["a wrong-typed boolean", { ...INITIAL_STATE, edited: "yes" }],
    ["a wrong-typed number", { ...INITIAL_STATE, round: "1" }],
    ["a non-array outcomes", { ...INITIAL_STATE, outcomes: "failed" }],
    ["an unknown outcome string", { ...INITIAL_STATE, outcomes: ["exploded"] }],
    ["a non-string outcome", { ...INITIAL_STATE, outcomes: [1] }],
    ["a missing disarmed flag", { ...INITIAL_STATE, disarmed: undefined }],
  ])("rejects %s", (_label, value) => {
    expect(isGateState(value)).toBe(false)
  })
})
