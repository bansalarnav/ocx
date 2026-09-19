import { describe, expect, test } from "bun:test"
import { resolve } from "node:path"
import { parseArguments } from "../packages/client/src/options"

describe("ocx config options", () => {
  test("resolves a config path", () => {
    expect(parseArguments(["--config", "opencode.json", "https://example.com"], {}).config)
      .toBe(resolve("opencode.json"))
  })

  test("supports clearing saved config", () => {
    expect(parseArguments(["--clear-config", "https://example.com"], {}).config).toBeNull()
    expect(parseArguments(
      ["--clear-config", "https://example.com"],
      { OCX_CONFIG: "opencode.json" },
    ).config).toBeNull()
  })

  test("does not allow sync and clear together", () => {
    expect(() => parseArguments([
      "--config", "opencode.json", "--clear-config", "https://example.com",
    ], {})).toThrow("cannot be combined")
  })
})
