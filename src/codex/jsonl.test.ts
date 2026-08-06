import { expect, test } from "bun:test"
import { parseJsonl } from "./jsonl"

test("parseJsonl preserves durable rows, ignores a torn tail, and rejects middle corruption", () => {
  expect(parseJsonl('{"a":1}\n{"b":2', "snapshot.jsonl")).toEqual([{ a: 1 }])
  expect(() => parseJsonl('{"a":1}\ninvalid\n{"b":2}', "snapshot.jsonl"))
    .toThrow("invalid JSONL row 2")
})
