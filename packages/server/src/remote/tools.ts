/** Small filesystem bridge. Runs inside the Linux sandbox, never inside the DO. */
export const filesystemProgram = String.raw`
import os, sys, json, pathlib, subprocess
root = pathlib.Path(sys.argv[1]).resolve()
name = sys.argv[2]
arg = json.loads(sys.argv[3])
def target(value='.', write=False):
    p = pathlib.Path(value)
    if not p.is_absolute(): p = root / p
    p = p.resolve()
    if not p.is_relative_to(root): raise ValueError('Path escapes workspace')
    return p
def emit(value): print(value if isinstance(value,str) else json.dumps(value))
p = target(arg.get('path','.'))
if name == 'read':
    if p.is_dir(): lines = [x.name+('/' if x.is_dir() else '') for x in sorted(p.iterdir())]
    else:
        data = p.read_bytes()
        if b'\0' in data: raise ValueError('Binary file: use shell for binary operations')
        lines = data.decode().splitlines()
    start=max(1,int(arg.get('offset',1))); limit=min(10000,max(1,int(arg.get('limit',2000))))
    emit('\n'.join(str(i+start)+': '+v for i,v in enumerate(lines[start-1:start-1+limit])))
elif name == 'write':
    p.parent.mkdir(parents=True,exist_ok=True); p.write_text(arg['content']); emit('Wrote '+str(p.relative_to(root)))
elif name == 'edit':
    old=arg['oldString']; new=arg['newString']; text=p.read_text(); count=text.count(old)
    if not old or not count or (count>1 and not arg.get('replaceAll')): raise ValueError('Replacement must match uniquely, or use replaceAll')
    p.write_text(text.replace(old,new,-1 if arg.get('replaceAll') else 1)); emit('Edited '+str(p.relative_to(root)))
elif name in ('glob','grep'):
    args=['rg','--hidden','--glob','!.git']
    if name=='glob': args+=['--files','--glob',arg['pattern'],str(p)]
    else:
        args+=['--line-number','--column','--no-heading','--color','never']
        if arg.get('include'): args+=['--glob',arg['include']]
        args+=['--',arg['pattern'],str(p)]
    r=subprocess.run(args,capture_output=True,text=True)
    if r.returncode not in (0,1): raise ValueError(r.stderr)
    lines=r.stdout.splitlines()[:min(10000,int(arg.get('limit',100)))]
    emit('\n'.join(x.removeprefix(str(root)+'/') for x in lines))
else: raise ValueError('Unknown filesystem operation')
`
