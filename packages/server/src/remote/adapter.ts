import { FileSystem } from "@opencode/core/filesystem"
import { FileSystemSearch } from "@opencode/core/filesystem/search"
import { Location } from "@opencode/core/location"
import { Project } from "@opencode/core/project"
import { Vcs } from "@opencode/core/vcs"
import { define } from "@opencode/plugin/effect/plugin"
import { Tool } from "@opencode/schema/tool"
import type { FileDiff } from "@opencode/schema/file-diff"
import { AbsolutePath, RelativePath } from "@opencode/schema/schema"
import { makeLocationNode } from "@opencode/util/effect/app-node"
import { Context, Effect, Layer, Option, Schema, Stream } from "effect"
import type { WorkspaceManager } from "./manager"

const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'"

// Only arguments cross this boundary. File operations resolve real paths on the
// sandbox, so symlinks cannot turn the native file browser into another workspace.
export const nativeWorkspaceScript = String.raw`
import base64,json,mimetypes,os,pathlib,subprocess,sys
x=json.load(sys.stdin); root=os.path.realpath(x['root']); os.chdir(root)
def path(value='.'):
 p=os.path.realpath(os.path.join(root,value))
 if os.path.commonpath([root,p])!=root: raise ValueError('Path escapes workspace')
 return p
def git(*args,check=True):
 p=subprocess.run(['git',*args],stdout=subprocess.PIPE,stderr=subprocess.PIPE)
 if check and p.returncode: raise RuntimeError(p.stderr.decode(errors='replace'))
 return p.stdout.decode(errors='replace').strip()
def entry(p): return {'path':os.path.relpath(p,root),'type':'directory' if os.path.isdir(p) else 'file'}
op=x['op']; value=x.get('input',{})
if op=='read':
 p=path(value['path']); data=pathlib.Path(p).read_bytes()
 if len(data)>8*1024*1024: raise ValueError('File exceeds 8 MiB browser limit')
 result={'data':base64.b64encode(data).decode(),'mime':mimetypes.guess_type(p)[0] or 'application/octet-stream','mtime':os.stat(p).st_mtime*1000}
elif op=='list':
 p=path(value.get('path','.')); result=[entry(os.path.join(p,n)) for n in sorted(os.listdir(p)) if n!='.git']
elif op=='find':
 query=value.get('query','').lower(); kind=value.get('type'); limit=min(value.get('limit',100),1000); result=[]
 for directory,dirs,files in os.walk(root):
  dirs[:]=[n for n in dirs if n not in ['.git','node_modules','.cache','.next'] and os.path.commonpath([root,os.path.realpath(os.path.join(directory,n))])==root]
  for name in dirs+files:
   p=os.path.join(directory,name); item=entry(p)
   if query in item['path'].lower() and (not kind or item['type']==kind): result.append(item)
   if len(result)>=limit: break
  if len(result)>=limit: break
elif op=='write':
 p=path(value['path']); os.makedirs(os.path.dirname(p),exist_ok=True); pathlib.Path(p).write_bytes(base64.b64decode(value['data'])); result={'path':p}
elif op=='info':
 current=git('symbolic-ref','--short','HEAD',check=False); default=git('symbolic-ref','--short','refs/remotes/origin/HEAD',check=False).removeprefix('origin/')
 result={'provider':'git','branch':{**({'current':current} if current else {}),**({'default':default} if default else {})}}
elif op=='base':
 ref=git('symbolic-ref','--short','refs/remotes/origin/HEAD',check=False)
 if not ref:
  for candidate in ['refs/remotes/origin/main','refs/remotes/origin/master','refs/heads/main','refs/heads/master']:
   if git('rev-parse','--verify',candidate,check=False): ref=candidate; break
 result={'name':ref.rsplit('/',1)[-1],'ref':ref,'source':'default'} if ref else None
elif op=='branches':
 names=git('for-each-ref','--format=%(refname:short)','refs/heads','refs/remotes').splitlines(); search=value.get('search','').lower()
 result=[n for n in names if search in n.lower()][:min(value.get('limit',100),1000)]
elif op in ['status','diff']:
 mode=value.get('mode','working'); base=value.get('base'); args=['diff','--no-ext-diff','--no-color','--no-renames']
 if mode=='working': args+=['HEAD']
 elif mode=='committed': args+=['HEAD^','HEAD']
 else:
  base=base or git('symbolic-ref','--short','refs/remotes/origin/HEAD',check=False) or 'HEAD'
  args+=[base+'...HEAD']
 stats=git(*args,'--numstat','-z').split('\0'); result=[]
 for row in stats:
  if not row: continue
  added,deleted,name=row.split('\t',2); p=path(name)
  status='deleted' if not os.path.exists(p) else ('added' if not git('cat-file','-e','HEAD:'+name,check=False) and subprocess.run(['git','cat-file','-e','HEAD:'+name],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL).returncode else 'modified')
  item={'file':name,'additions':int(added) if added.isdigit() else 0,'deletions':int(deleted) if deleted.isdigit() else 0,'status':status}
  if op=='diff': item['patch']=git(*args,'--unified='+str(min(value.get('context',3),100)), '--', name)
  result.append(item)
 if mode=='working':
  for name in git('ls-files','--others','--exclude-standard','-z').split('\0'):
   if not name: continue
   p=path(name)
   if not os.path.isfile(p): continue
   data=pathlib.Path(p).read_bytes(); lines=data.decode(errors='replace').splitlines(); item={'file':name,'additions':len(lines),'deletions':0,'status':'added'}
   if op=='diff': item['patch']='Binary file' if b'\0' in data else '--- /dev/null\n+++ b/'+name+'\n@@ -0,0 +1,'+str(len(lines))+' @@\n'+'\n'.join('+'+line for line in lines)+'\n'
   result.append(item)
else: raise ValueError('Unknown native operation')
print(json.dumps(result))
`

const base64 = (bytes: Uint8Array) => {
  let text = ""
  for (const byte of bytes) text += String.fromCharCode(byte)
  return btoa(text)
}
const decode64 = (text: string) => Uint8Array.from(atob(text), (value) => value.charCodeAt(0))

export function remoteReplacements(manager: WorkspaceManager) {
  // Preserve the native project's database and events, but don't let a Worker
  // filesystem existence check suppress registration or archive a remote tree.
  const project = Project.node.mapLayer(layer => Layer.flatMap(layer, services => Layer.succeed(Project.Service, {
    ...Context.get(services, Project.Service),
    resolve: (directory, options) => Effect.gen(function* () {
      const workspace = yield* Effect.promise(() => manager.resolve(directory))
      const original = Context.get(services, Project.Service)
      if (!workspace) return yield* original.resolve(directory, options)
      const root = AbsolutePath.make(workspace.root)
      const resolved = yield* original.resolve(root, { persist: true })
      return { ...resolved, directory: root, canonical: root, vcs: { type: "git", store: AbsolutePath.make(workspace.root + "/.git") } }
    }),
    sweep: () => Effect.void,
  })))
  const native = <A>(directory: string, op: string, input: unknown = {}) => Effect.promise(async signal => {
    const workspace = await manager.resolve(directory)
    if (!workspace) throw new Error("No remote workspace is attached to this location")
    if (op === "write" && !["ready", "paused"].includes(workspace.state))
      throw new Error(`Workspace is ${workspace.state}; writes are frozen during or after handoff`)
    const payload = JSON.stringify({ root: workspace.root, op, input })
    const result = await manager.run(workspace.id, `python3 -c ${quote(nativeWorkspaceScript)}`, { signal, timeoutSeconds: 60, stdin: payload })
    if (result.exitCode !== 0) throw new Error(result.stderr || `Remote ${op} failed`)
    return JSON.parse(result.stdout) as A
  })
  const files = Layer.effect(FileSystem.Service, Effect.gen(function* () {
    const location = yield* Location.Service
    const read: FileSystem.Interface["read"] = input => native<{ data: string; mime: string; mtime: number }>(location.directory, "read", input).pipe(
      Effect.map(value => {
        const bytes = decode64(value.data)
        return { mime: value.mime, size: bytes.length, mtime: Option.some(new Date(value.mtime)), stream: (options?: { offset?: number; bytesToRead?: number }) => Stream.succeed(bytes.slice(options?.offset ?? 0, options?.bytesToRead === undefined ? undefined : (options.offset ?? 0) + options.bytesToRead)) }
      }),
      Effect.catchDefect(() => Effect.fail(new FileSystem.NotFoundError({ path: input.path }))),
    )
    const find: FileSystem.Interface["find"] = input => native<FileSystem.Entry[]>(location.directory, "find", input)
    return FileSystem.Service.of({
      read,
      list: input => native<FileSystem.Entry[]>(location.directory, "list", input).pipe(Effect.catchDefect(() => Effect.fail(new FileSystem.NotFoundError({ path: RelativePath.make(input?.path ?? ".") })))),
      find,
      write: input => native<{ path: string }>(location.directory, "write", { path: input.path, data: base64(input.data) }).pipe(
        Effect.tap(() => Effect.promise(async () => {
          const workspace = await manager.resolve(location.directory)
          if (workspace) await manager.checkpoint(workspace.id)
        })),
        Effect.map(value => ({ path: AbsolutePath.make(value.path) })),
      ),
    })
  }))
  const search = Layer.effect(FileSystemSearch.Service, Effect.gen(function* () {
    const location = yield* Location.Service
    return FileSystemSearch.Service.of({ find: input => native<FileSystem.Entry[]>(location.directory, "find", input) })
  }))
  const vcs = Layer.effect(Vcs.Service, Effect.gen(function* () {
    const location = yield* Location.Service
    const attached = yield* Effect.promise(() => manager.resolve(location.directory))
    return Vcs.Service.of({
      transform: () => Effect.succeed({ dispose: Effect.void }), reload: () => Effect.void,
      initialize: () => Effect.fail(new Vcs.InitializeError({ kind: "unsupported" })),
      info: () => attached ? native<Vcs.Info>(location.directory, "info") : Effect.succeed({ branch: {} }),
      base: () => attached ? native<Vcs.Base | null>(location.directory, "base").pipe(Effect.catchDefect(cause => Effect.fail(new Vcs.DiffError({ message: String(cause) })))) : Effect.succeed(null),
      branches: options => attached ? native<Vcs.BranchList>(location.directory, "branches", options) : Effect.succeed([]),
      status: () => attached ? native<Vcs.FileStatus[]>(location.directory, "status") : Effect.succeed([]),
      diff: (mode, options) => attached ? native<FileDiff.Info[]>(location.directory, "diff", { mode, ...options }).pipe(Effect.catchDefect(cause => Effect.fail(new Vcs.DiffError({ message: String(cause) })))) : Effect.succeed([]),
    })
  }))
  return [
    Project.node.replace(project),
    FileSystem.node.replace(makeLocationNode({ service: FileSystem.Service, layer: files, deps: [Location.node] })),
    FileSystemSearch.node.replace(makeLocationNode({ service: FileSystemSearch.Service, layer: search, deps: [Location.node] })),
    Vcs.node.replace(makeLocationNode({ service: Vcs.Service, layer: vcs, deps: [Location.node] })),
  ]
}

/** Workspace tools select the owning Session on every call, including cached calls. */
export const remoteWorkspacePlugin = (manager: WorkspaceManager) => define({
  id: "remote-workspace",
  effect: Effect.fn(function* (context) {
    const inputs = {
      read: Schema.Struct({ path: Schema.String, offset: Schema.optional(Schema.Number), limit: Schema.optional(Schema.Number) }),
      write: Schema.Struct({ path: Schema.String, content: Schema.String }),
      edit: Schema.Struct({ path: Schema.String, oldString: Schema.String, newString: Schema.String, replaceAll: Schema.optional(Schema.Boolean) }),
      patch: Schema.Struct({ patchText: Schema.String }),
      glob: Schema.Struct({ pattern: Schema.String, path: Schema.optional(Schema.String), limit: Schema.optional(Schema.Number) }),
      grep: Schema.Struct({ pattern: Schema.String, path: Schema.optional(Schema.String), include: Schema.optional(Schema.String), limit: Schema.optional(Schema.Number) }),
      shell: Schema.Struct({ command: Schema.String, workdir: Schema.optional(Schema.String), timeout: Schema.optional(Schema.Number) }),
    }
    yield* context.tool.transform(tools => {
      for (const [name, input] of Object.entries(inputs)) tools.add({
        name: `workspace_${name}`,
        description: `Run ${name} in this session's remote workspace. Paths are relative to its checkout.`,
        input, options: { codemode: false },
        execute: (args, call) => Effect.tryPromise({
          try: async signal => {
            const workspace = await manager.forSession(call.sessionID)
            if (!workspace) throw new Error("This session has no remote workspace")
            return { content: await manager.tool(workspace.id, name, args, signal) }
          },
          catch: error => Tool.Error.make({ message: String(error), error: String(error) }),
        }),
      })
    })
    yield* context.session.hook("context", event => Effect.promise(async () => {
      if (event.agent === "plugin-author" || !await manager.forSession(event.sessionID)) {
        for (const name of Object.keys(inputs)) delete event.tools[`workspace_${name}`]
      }
    }))
  }),
})
