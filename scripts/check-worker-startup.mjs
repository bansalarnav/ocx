// Build first: bun run build
// Then: node scripts/check-worker-startup.mjs [bundle directory]
// Runs the real bundle with isolated, disposable local storage and test credentials.
import assert from "node:assert/strict"
import { readdirSync, readFileSync } from "node:fs"
import { createRequire } from "node:module"
import { resolve } from "node:path"

const require = createRequire(import.meta.url)
const wranglerRequire = createRequire(require.resolve("wrangler/package.json"))
const { Miniflare, convertV4MiniflareOptions } = wranglerRequire("miniflare")
const directory = resolve(process.argv[2] ?? "dist/worker")
const files = readdirSync(directory).filter(file => /\.(js|wasm|txt)$/.test(file))
// Miniflare treats the first module as the entrypoint.
files.sort((a, b) => Number(b === "bootstrap.js") - Number(a === "bootstrap.js"))
assert.equal(files[0], "bootstrap.js", "Build the bootstrap entrypoint before running this check")
const options = convertV4MiniflareOptions({
  name: "startup-test",
  modulesRoot: directory,
  modules: files.map(file => ({
    type: file.endsWith(".wasm") ? "CompiledWasm" : file.endsWith(".txt") ? "Text" : "ESModule",
    path: resolve(directory, file),
    contents: readFileSync(resolve(directory, file)),
  })),
  compatibilityDate: "2026-08-26",
  compatibilityFlags: ["nodejs_compat"],
  bindings: { OPENCODE_PASSWORD: "startup-test-password" },
  durableObjects: { OPENCODE: { className: "OpenCodeDO", useSQLite: true } },
  durableObjectsPersist: false,
})
const worker = new Miniflare(options)
const authorization = `Basic ${btoa("opencode:startup-test-password")}`
const waitFor = async predicate => {
  const deadline = Date.now() + 5_000
  while (!predicate()) {
    assert.ok(Date.now() < deadline, "Timed out waiting for a WebSocket event")
    await new Promise(resolve => setTimeout(resolve, 10))
  }
}

try {
  await worker.ready
  assert.equal((await worker.dispatchFetch("https://test/api/ocx/workspaces")).status, 401)
  const response = await worker.dispatchFetch("https://test/api/ocx/workspaces", { headers: { authorization } })
  assert.equal(response.status, 200, await response.clone().text())
  assert.deepEqual(await response.json(), { workspaces: [] })

  const upgrade = await worker.dispatchFetch("https://test/api/ocx/transport", {
    headers: { authorization, upgrade: "websocket", "sec-websocket-protocol": "ocx.v2" },
  })
  assert.equal(upgrade.status, 101)
  const socket = upgrade.webSocket
  socket.accept()
  const frames = []
  socket.addEventListener("message", event => frames.push(JSON.parse(event.data)))
  const subscribe = id => socket.send(JSON.stringify({ type: "subscribe", id, channel: "plugins" }))
  subscribe("first")
  await waitFor(() => frames.some(frame => frame.type === "subscribed" && frame.id === "first"))

  await worker.unsafeEvictDurableObject("startup-test", "OpenCodeDO", { name: "default", webSockets: "hibernate" })
  subscribe("second")
  await waitFor(() => frames.some(frame => frame.type === "subscribed" && frame.id === "second"))

  // Duplicate ID rejection proves the original subscription survived hibernation.
  let closed
  socket.addEventListener("close", event => { closed = event }, { once: true })
  subscribe("first")
  await waitFor(() => closed !== undefined)
  assert.equal(closed.code, 1002)
  console.log("PASS: startup, HTTP auth/API, WebSocket subscribe, hibernation wake, attachment recovery, close")
} finally {
  await worker.dispose()
}
