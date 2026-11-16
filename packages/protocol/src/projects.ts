import type { Workspace } from "./workspaces"

export const projectPrefix = "/api/ocx/projects"

/** Credentials and transport are not part of a repository's identity. */
export function repositoryIdentity(remote: string): { id: string; name: string; source: string } | undefined {
  const ssh = remote.match(/^(?:[^/@:]+@)?([^/:]+):(.+)$/)
  if (!remote.includes("://") && ssh && !remote.startsWith("/")) remote = `https://${ssh[1]}/${ssh[2]}`
  let url: URL
  try { url = new URL(remote) } catch { return }
  if (!["https:", "http:", "ssh:", "git:"].includes(url.protocol)) return
  const host = url.hostname.toLowerCase()
  let path = url.pathname.replace(/^\/+|\/+$/g, "").replace(/\.git$/, "")
  if (!path) return
  if (host === "github.com") path = path.toLowerCase()
  const authority = host + (url.port ? `:${url.port}` : "")
  const source = `https://${authority}/${path}.git`
  return { id: `repo:${authority}/${path}`, name: path, source }
}

export interface ProjectCheckout {
  id: string
  projectID: string
  projectName: string
  name: string
  source?: string
  location: "device" | "cloud"
  deviceID?: string
  hostname?: string
  directory: string
  branch?: string
  state: Workspace["state"] | "available" | "unavailable" | "not-started"
  sessionCount?: number
  updatedAt: number
}

export interface Project {
  id: string
  name: string
  source?: string
  checkouts: ProjectCheckout[]
}

export function cloudCheckout(workspace: Workspace): ProjectCheckout {
  const repo = workspace.source ? repositoryIdentity(workspace.source) : undefined
  return {
    id: workspace.id, projectID: repo?.id ?? workspace.projectID ?? `checkout:${workspace.id}`,
    projectName: repo?.name ?? workspace.name, name: workspace.name, source: repo?.source,
    location: "cloud", directory: workspace.root, branch: workspace.branch,
    state: workspace.state === "preparing" && !workspace.sandboxID ? "not-started" : workspace.state,
    sessionCount: workspace.conversationCount, updatedAt: workspace.updatedAt,
  }
}

export function groupProjects(checkouts: ProjectCheckout[]): Project[] {
  const projects = new Map<string, Project>()
  for (const checkout of checkouts) {
    let project = projects.get(checkout.projectID)
    if (!project) {
      project = { id: checkout.projectID, name: checkout.projectName, source: checkout.source, checkouts: [] }
      projects.set(project.id, project)
    }
    project.source ??= checkout.source
    project.checkouts.push(checkout)
  }
  return [...projects.values()].sort((a, b) => a.name.localeCompare(b.name))
}
