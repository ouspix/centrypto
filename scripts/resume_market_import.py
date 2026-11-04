"""One-time resumable history import, supervised independently of the terminal."""
import concurrent.futures
import fcntl
import json
import os
from pathlib import Path
import subprocess
import time

root = Path(__file__).resolve().parents[1]
lock = open(f'/tmp/centrypto-history-import-{os.getuid()}.lock', 'w')
try: fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
except BlockingIOError: raise SystemExit(0)
state = root / 'data/deployment/market-import-request.json'
if not state.exists() or json.loads(state.read_text()).get('complete'): raise SystemExit(0)

def migrate(pair):
    source, schema = pair
    return subprocess.call([str(root / '.venv-ops/bin/python'), '-u', str(root / 'scripts/migrate_market_to_vps.py'), '--source', source, '--schema', schema, '--batch-size', '50000'], cwd=root)

with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
    codes = list(pool.map(migrate, [('prisma/md_main.db', 'mainnet'), ('prisma/md_test.db', 'testnet')]))
if any(codes): raise SystemExit(1)
temporary = state.with_suffix('.tmp')
temporary.write_text(json.dumps({'complete': True, 'completedAt': time.time()}))
temporary.chmod(0o600)
temporary.replace(state)
print('Both market history imports completed; SQLite source files are unchanged.', flush=True)
