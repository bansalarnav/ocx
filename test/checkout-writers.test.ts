import { expect, test } from "bun:test"
import { CheckoutWriters } from "../packages/server/src/remote/writers"

test("shared checkout writers wait for the conversation family, allow subagents, and cancel without blocking other checkouts", async () => {
  const queue = new CheckoutWriters()
  const signal = new AbortController().signal
  const active = async () => new Set(["first", "child", "second"])
  await queue.acquire("checkout", "first", "first", active, signal)
  await queue.acquire("checkout", "first", "child", active, signal)
  let admitted = false
  const next = queue.acquire("checkout", "second", "second", active, signal).then(() => { admitted = true })
  await new Promise(resolve => setImmediate(resolve))
  expect(admitted).toBe(false)
  await queue.acquire("other-checkout", "independent", "independent", active, signal)
  const canceled = new AbortController()
  const waiting = queue.acquire("checkout", "canceled", "canceled", active, canceled.signal)
  canceled.abort(new Error("Canceled"))
  await expect(waiting).rejects.toThrow("Canceled")
  queue.release("first")
  await new Promise(resolve => setImmediate(resolve))
  expect(admitted).toBe(false)
  queue.release("child")
  await next
  expect(admitted).toBe(true)
  queue.release("second")
  await queue.acquire("checkout", "third", "third", active, signal)
})

test("an execution that ended without an idle hook cannot leave a stale checkout writer", async () => {
  const queue = new CheckoutWriters()
  await queue.acquire("checkout", "failed", "failed", async () => new Set(), new AbortController().signal)
  await queue.acquire("checkout", "next", "next", async () => new Set(), new AbortController().signal)
  queue.release("next")
})
