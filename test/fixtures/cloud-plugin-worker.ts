import { installPackage } from "../../packages/server/src/plugin-manager/package-installer"
import { withRegistry } from "./cloud-plugin-registry"
export default {
  async fetch(request: Request) {
    if (new URL(request.url).pathname === "/ready") return new Response("ready")
    try { return Response.json(await withRegistry(() => installPackage({ package: "fixture-plugin", scope: "project", projectID: "repo-one" }))) }
    catch (error) { return Response.json({ error: String(error), stack: error instanceof Error ? error.stack : undefined }, { status: 500 }) }
  },
}
