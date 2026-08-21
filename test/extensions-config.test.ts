import { describe, expect, test } from "bun:test"
import { parseEnabledExtensions } from "../src/extensions/config.ts"

describe("parseEnabledExtensions", () => {
  test("missing raw → []", () => expect(parseEnabledExtensions(undefined)).toEqual([]))
  test("no extensions key → []", () =>
    expect(parseEnabledExtensions('{"check":"bun test"}')).toEqual([]))
  test("literal true enables; anything else does not", () =>
    expect(parseEnabledExtensions(
      '{"check":"x","extensions":{"gauge":true,"a":1,"b":"true","c":false}}',
    )).toEqual(["gauge"]))
  test("malformed JSON → [] (never throws)", () =>
    expect(parseEnabledExtensions('{oops')).toEqual([]))
  test("extensions not an object → []", () =>
    expect(parseEnabledExtensions('{"check":"x","extensions":["gauge"]}')).toEqual([]))
})
