"""Supervise the local SSH tunnel and inference worker while this PC is awake.

The VPS independently runs Chrome, news capture, PostgreSQL and market ingestion.
A separate local desk worker serves authenticated research and explicitly enabled desk books.
"""
import fcntl
import json
import os
from pathlib import Path
import signal
import socket
import subprocess
import time

root = Path(__file__).resolve().parents[1]
lock = open(f'/tmp/centrypto-local-runtime-{os.getuid()}.lock', 'w')
try: fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
except BlockingIOError:
    print('Local runtime is already running.')
    raise SystemExit(0)
running = True
children = {}
restart_worker = False
logs = root / 'logs/intelligence'
logs.mkdir(parents=True, exist_ok=True)

def stop(*_):
    global running
    running = False

signal.signal(signal.SIGTERM, stop)
signal.signal(signal.SIGINT, stop)
def reload_worker(*_):
    global restart_worker
    restart_worker = True
signal.signal(signal.SIGHUP, reload_worker)

def listening(port):
    try:
        with socket.create_connection(('127.0.0.1', port), timeout=1): return True
    except OSError: return False

def launch(name, arguments, environment=None):
    log = open(logs / (name + '.log'), 'ab', buffering=0)
    process = subprocess.Popen(arguments, cwd=root, env=environment, stdout=log, stderr=subprocess.STDOUT, start_new_session=True)
    children[name] = (process, log)

try:
    while running:
        if restart_worker:
            restart_worker = False
            if 'worker' in children:
                process, log = children.pop('worker')
                try: os.killpg(process.pid, signal.SIGTERM); process.wait(timeout=20)
                except subprocess.TimeoutExpired: os.killpg(process.pid, signal.SIGKILL)
                except ProcessLookupError: pass
                log.close()
        for name, (process, log) in list(children.items()):
            if process.poll() is not None:
                log.close(); del children[name]
        if not listening(55432) and 'tunnel' not in children:
            launch('tunnel', ['ssh', '-NT', '-o', 'BatchMode=yes', '-o', 'ExitOnForwardFailure=yes', '-o', 'StrictHostKeyChecking=yes', '-o', 'ServerAliveInterval=15', '-o', 'ServerAliveCountMax=3', '-i', str(Path.home() / '.ssh/centrypto_vps'), '-L', '127.0.0.1:55432:127.0.0.1:5432', '-L', '127.0.0.1:6089:127.0.0.1:6080', 'centrypto@96.44.160.28'])
        if listening(55432) and 'worker' not in children:
            launch('worker', ['node', str(root / 'node_modules/tsx/dist/cli.mjs'), '-r', 'dotenv/config', str(root / 'scripts/start_intelligence_worker.ts')], {**os.environ, 'DOTENV_CONFIG_PATH': str(root / '.env.local')})
        if listening(55432) and 'desk' not in children:
            launch('desk', ['node', str(root / 'node_modules/tsx/dist/cli.mjs'), '-r', 'dotenv/config', str(root / 'scripts/start_trading_desk.ts')], {**os.environ, 'DOTENV_CONFIG_PATH': str(root / '.env.local')})
        request = root / 'data/deployment/market-import-request.json'
        if listening(55432) and 'history-import' not in children and request.exists():
            try:
                if not json.loads(request.read_text()).get('complete'): launch('history-import', [str(root / '.venv-ops/bin/python'), '-u', str(root / 'scripts/resume_market_import.py')])
            except (ValueError, OSError): pass
        time.sleep(2)
finally:
    for process, _ in children.values():
        try: os.killpg(process.pid, signal.SIGTERM)
        except ProcessLookupError: pass
    deadline = time.time() + 20
    for process, log in children.values():
        try: process.wait(timeout=max(1, deadline - time.time()))
        except subprocess.TimeoutExpired:
            try: os.killpg(process.pid, signal.SIGKILL)
            except ProcessLookupError: pass
        log.close()
