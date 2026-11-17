import { gzipSync } from "node:zlib"
// Build real npm tarballs. Tests use the production tar extractor, dependency resolver, bundler and VM.
const tarball = (files: Record<string, string>) => gzipSync(Buffer.concat([
  ...Object.entries(files).flatMap(([name, source]) => {
    const header = Buffer.alloc(512)
    header.write(`package/${name}`)
    header.write("0000644\0", 100); header.write("0000000\0", 108); header.write("0000000\0", 116)
    header.write(Buffer.byteLength(source).toString(8).padStart(11, "0") + "\0", 124)
    header.fill(32, 148, 156); header.write("0", 156); header.write("ustar\0", 257)
    header.write([...header].reduce((a, b) => a + b, 0).toString(8).padStart(6, "0") + "\0 ", 148)
    const body = Buffer.from(source)
    return [header, body, Buffer.alloc((512 - body.length % 512) % 512)]
  }), Buffer.alloc(1024),
]))
const source = `import {Plugin} from '@opencode/plugin'; import {answer} from 'fixture-dep'; export default Plugin.define({id:'ordinary', async setup(ctx) { await ctx.tool.transform(tools => tools.add({name:'answer', description:'answer', input:{type:'object',properties:{}}, async execute() {await ctx.storage.set("answer",answer); return {content:String(await ctx.storage.get("answer"))}}})); }});`
const packages: Record<string, Record<string, string>> = {
  "fixture-plugin": { "package.json": JSON.stringify({ name: "fixture-plugin", version: "1.2.3", exports: { "./server": "./server.js", "./tui": "./tui.js" }, dependencies: { "fixture-dep": "1.0.0" }, scripts: { install: "exit 1" } }), "server.js": source, "tui.js": "export default {id:'ordinary',setup(){}}" },
  "fixture-dep": { "package.json": JSON.stringify({ name: "fixture-dep", version: "1.0.0", main: "index.js" }), "index.js": "export const answer=42" },
}
const realFetch = globalThis.fetch
export const withRegistry = async <T>(run: () => Promise<T>) => {
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    const path = new URL(String(url)).pathname.slice(1)
    const name = decodeURIComponent(path.replace(/\.tgz$/, ""))
    const files = packages[name]
    if (!files) throw new Error(`Unexpected network access: ${url}`)
    if (path.endsWith(".tgz")) return new Response(tarball(files))
    const manifest = JSON.parse(files["package.json"]!)
    return Response.json({ "dist-tags": { latest: manifest.version }, versions: { [manifest.version]: { ...manifest, dist: { tarball: `https://registry.npmjs.org/${name}.tgz` } } } })
  }) as typeof fetch
  try { return await run() } finally { globalThis.fetch = realFetch }
}
