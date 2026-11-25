"""Compute-only restart: preserve completed deterministic runs and every model rule."""
import pathlib,os,signal,json,time,hashlib
HERE=pathlib.Path(__file__).resolve().parent
target='reports/feature-ablation-2026-11-14/train_ablation.py'
processes={};roots=[]
for path in pathlib.Path('/proc').iterdir():
    if not path.name.isdigit():continue
    try:
        argv=(path/'cmdline').read_bytes().split(b'\0');argv=[a.decode(errors='replace') for a in argv if a]
        stat=(path/'stat').read_text();ppid=int(stat[stat.rfind(')')+2:].split()[1]);processes[int(path.name)]=ppid
        if len(argv)==2 and argv[0].endswith('/venv/bin/python') and argv[1]==target:roots.append(int(path.name))
    except (FileNotFoundError,ProcessLookupError,PermissionError):continue
assert len(roots)==1,roots
tree=set(roots)
while True:
    expanded=tree|{pid for pid,parent in processes.items() if parent in tree}
    if expanded==tree:break
    tree=expanded
for pid in roots:
    try:os.kill(pid,signal.SIGTERM)
    except ProcessLookupError:pass
for pid in tree-set(roots):
    try:os.kill(pid,signal.SIGTERM)
    except ProcessLookupError:pass
time.sleep(1)
original=json.loads((HERE/'experiment.json').read_text());assert original['workers']==4
before=json.loads((HERE/'experiment-lock.json').read_text())
for name,digest in before['files'].items():assert hashlib.sha256((HERE/name).read_bytes()).hexdigest()==digest,name
(HERE/'pre-concurrency-lock.json').write_text(json.dumps(before,indent=2))
updated={**original,'workers':8};assert {k:v for k,v in updated.items() if k!='workers'}=={k:v for k,v in original.items() if k!='workers'}
(HERE/'experiment.json').write_text(json.dumps(updated,indent=2))
before['files']['experiment.json']=hashlib.sha256((HERE/'experiment.json').read_bytes()).hexdigest()
(HERE/'experiment-lock.json').write_text(json.dumps(before,indent=2))
(HERE/'concurrency-amendment.json').write_text(json.dumps({'only_change':'CPU worker count 4 to 8; no features, labels, seeds, training, selection or execution changes.',
    'completed_runs_reused':True,'model_rules_unchanged':True,'stopped_process_count':len(tree)},indent=2))
print(json.dumps({'stopped_process_count':len(tree),'workers':8,'only_compute_concurrency_changed':True}))
