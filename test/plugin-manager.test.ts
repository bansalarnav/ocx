import { describe, expect, test } from "bun:test"
import { globPattern, selectedSessionModel } from "../src/plugin-manager/manager"

describe("plugin workspace globbing", () => {
  test("double-star patterns include files at the workspace root", () => {
    expect(globPattern("**/*").test("tui.tsx")).toBe(true)
    expect(globPattern("**/*.tsx").test("tui.tsx")).toBe(true)
    expect(globPattern("**/*.tsx").test("src/tui.tsx")).toBe(true)
  })
})

describe("plugin author model selection", () => {
  test("uses the current chat model, including its variant", () => {
    const model = {
      providerID: "anthropic",
      id: "claude-sonnet",
      variant: "thinking",
    }

    expect(selectedSessionModel({ model })).toBe(model)
  })

  test("fails clearly when the current chat has no model", () => {
    expect(() => selectedSessionModel({})).toThrow("The current chat has no selected model")
  })
})
