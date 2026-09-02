import { describe, expect, test } from "bun:test"
import { globPattern } from "../src/plugin-manager/manager"

describe("plugin workspace globbing", () => {
  test("double-star patterns include files at the workspace root", () => {
    expect(globPattern("**/*").test("tui.tsx")).toBe(true)
    expect(globPattern("**/*.tsx").test("tui.tsx")).toBe(true)
    expect(globPattern("**/*.tsx").test("src/tui.tsx")).toBe(true)
  })
})
