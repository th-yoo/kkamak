import { test, expect } from "bun:test"
import { isTaskShaped } from "../src/extensions/gauge/classifier.ts"

// Pre-reg §2.1: task-shaped iff (imperative action verb OR file-path mention)
// AND not question-only. Conservative: under-trigger preferred.

test("imperative action verbs classify as task-shaped", () => {
  expect(isTaskShaped("fix the auth middleware token expiry")).toBe(true)
  expect(isTaskShaped("Implement retry logic for the fetcher")).toBe(true)
  expect(isTaskShaped("add a --verbose flag")).toBe(true)
  expect(isTaskShaped("refactor session handling")).toBe(true)
  expect(isTaskShaped("create hello.txt with hello")).toBe(true)
  expect(isTaskShaped("update the README install section")).toBe(true)
  expect(isTaskShaped("remove the dead code path in stop.ts")).toBe(true)
  expect(isTaskShaped("rename foo to bar everywhere")).toBe(true)
  expect(isTaskShaped("write tests for the parser")).toBe(true)
  expect(isTaskShaped("build the docker image")).toBe(true)
  expect(isTaskShaped("migrate configs to v2")).toBe(true)
})

test("file-path mention alone classifies as task-shaped", () => {
  expect(isTaskShaped("the bug lives in src/core/stop.ts somewhere")).toBe(true)
  expect(isTaskShaped("gate.json needs a new field")).toBe(true)
})

test("question-only prompts are NOT task-shaped even with verb-like words", () => {
  expect(isTaskShaped("how do I test cc kkamak?")).toBe(false)
  expect(isTaskShaped("what does the classifier do?")).toBe(false)
  expect(isTaskShaped("is it practical for daily usage?")).toBe(false)
})

test("question ending in ? WITH imperative verb stays task-shaped", () => {
  expect(isTaskShaped("can you fix src/config.ts?")).toBe(true)
})

test("chatter / short / slash-command prompts are NOT task-shaped", () => {
  expect(isTaskShaped("thanks")).toBe(false)
  expect(isTaskShaped("ok")).toBe(false)
  expect(isTaskShaped("")).toBe(false)
  expect(isTaskShaped("   ")).toBe(false)
  expect(isTaskShaped("/model")).toBe(false)
  expect(isTaskShaped("/kkamak:init please")).toBe(false)
})

test("verb must be word-anchored: no substring false positives", () => {
  expect(isTaskShaped("the prefix additions were nice")).toBe(false)
  expect(isTaskShaped("I readded nothing")).toBe(false)
})

test("plain discussion prose is NOT task-shaped", () => {
  expect(isTaskShaped("I think the design is sound overall")).toBe(false)
  expect(isTaskShaped("yesterday we talked about naming")).toBe(false)
})
