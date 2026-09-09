import type { WorkerShellLoader } from "@cloudflare/computer/backends/worker-shell"
import yq from "@cloudflare/computer/shell/yq"

// The bundled YAML dependency requires these built-ins through createRequire,
// which cannot find them in a Dynamic Worker's user module registry. Static
// built-in imports resolve through workerd's native module registry instead.
export const workerYq = Object.fromEntries(Object.entries(yq).map(([name, module]) => [name, {
  js: `import ocxProcess from 'node:process';\nimport * as ocxBuffer from 'node:buffer';\n${module.js.replaceAll('m("process")', 'ocxProcess').replaceAll('m("buffer")', 'ocxBuffer')}`,
}]))

// Computer 0.2.1 puts cancellation controllers on each WorkerEntrypoint instance.
// workerd constructs another instance for killExec, so it cannot find the running
// command. Share controllers within this workspace's shell isolate instead.
// Keep the compatibility patch checked so a dependency update cannot silently
// restore the broken cancellation behavior.
export function shellLoader(loader: WorkerLoader): WorkerShellLoader {
  return {
    get(name, getCode) {
      return loader.get(`ocx-shell-v1:${name}`, async () => {
        const code = await getCode()
        const entry = code.modules[code.mainModule]
        const source = typeof entry === "string" ? entry : entry?.js
        const field = "#executions = /* @__PURE__ */ new Map();"
        if (!source || source.split(field).length !== 2) throw new Error("Computer shell changed; review its cancellation adapter")
        return {
          ...code,
          modules: { ...code.modules, [code.mainModule]: {
            js: `const ocxExecutions = new Map();\n${source.replace(field, "#executions = ocxExecutions;")}`,
          } },
          limits: { cpuMs: 30000 },
          globalOutbound: code.globalOutbound as Fetcher | null | undefined,
        }
      })
    },
  }
}
