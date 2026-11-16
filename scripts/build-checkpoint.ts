import { mkdir } from "node:fs/promises"
import { dirname, resolve } from "node:path"

/** One implementation is used by the local client and the remote Node runtime. */
export async function buildCheckpointRuntime(): Promise<string> {
  const root = resolve(import.meta.dir, "..")
  const result = await Bun.build({
    entrypoints: [resolve(root, "packages/client/src/checkpoint.ts")],
    target: "node",
    format: "esm",
    minify: { whitespace: true, syntax: true, identifiers: false },
    // The invocation below uses the exported identifiers after bundling.
    footer: `
let input = "";
for await (const chunk of process.stdin) input += chunk;
try {
  const request = JSON.parse(input);
  let result;
  if (request.action === "capture") {
    result = await captureCheckpoint(request);
    if (request.remote) await pushCheckpoint(request.directory, result, request.remote);
  } else if (request.action === "restore") {
    result = await restoreCheckpoint(request);
  } else {
    throw new Error("Unknown checkpoint action");
  }
  process.stdout.write(JSON.stringify(result));
} catch (error) {
  process.stderr.write(String(error instanceof Error ? error.message : error) + "\\n");
  process.exitCode = 1;
}
`,
  })
  if (!result.success) throw new AggregateError(result.logs, "Could not build checkpoint runtime")
  const path = resolve(root, "packages/server/src/remote/checkpoint-runtime.generated.txt")
  await mkdir(dirname(path), { recursive: true })
  await Bun.write(path, result.outputs[0]!)
  return path
}

if (import.meta.main) console.log(await buildCheckpointRuntime())
