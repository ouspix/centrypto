"""Hash code, source inputs and rebuilt features before fitting."""
from common import *

def sha(path):
    digest=hashlib.sha256()
    with path.open('rb') as f:
        for block in iter(lambda:f.read(8*1024*1024),b''):digest.update(block)
    return digest.hexdigest()

def verify_lock():
    record=json.loads((HERE/'experiment-lock.json').read_text())
    for filename,expected in record['files'].items():assert sha(pathlib.Path(filename))==expected,filename
    return record

def main():
    files=[*HERE.glob('*.py'),HERE/'spec.json',HERE/'paths.json',HERE/'catalog.json',HERE/'market-feature-names.json',HERE/'sma-feature-names.json',HERE/'news-feature-names.json']
    files += [CACHE/name for name in ['sma.npy','news.npy','news-row-ids.npy','targets.npy','oracle-gains.npy','oracle-exits.npy','state.npy','entry-exit-targets.json','teachers.json']]
    files += [BASE_CACHE/name for name in ['market.npy','state.npy','news-full.json.gz']]
    files += [TARGETS/'entry-exit-targets.json',HERE.parent/'two-stage-directions-2026-11-14'/'target-summary.json',HERE/'strict-deadline-correction.json']
    record={'at':dt.datetime.now(dt.timezone.utc).isoformat(),'files':{str(f):sha(f) for f in sorted(set(files))},
            'note':'Protocol and datasets frozen before this rebuild is fitted. Prior historical experiments were viewed. Preserve original artifacts; candidate direction is an input, future rally direction is label-only.'}
    save('experiment-lock.json',record);print('Locked',len(record['files']),'inputs',flush=True)

if __name__=='__main__':main()
