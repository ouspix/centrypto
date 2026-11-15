"""Supervise local workers, web and the VPS tunnel. Never activate a desk book.

Windows owns WSL restart; this process owns child restart. Existing workers keep
retrying during database/network outages so protection is not needlessly stopped.
"""
import fcntl
import json
import os
from pathlib import Path
import signal
import socket
import struct
import subprocess
import time
from urllib.parse import unquote, urlsplit

ROOT = Path(__file__).resolve().parents[1]
POLL_SECONDS = 5
STABLE_SECONDS = 60


def database_endpoint(root):
    value = os.environ.get('DATABASE_URL', '')
    env = root / '.env.local'
    if not value and env.exists():
        for line in env.read_text().splitlines():
            if line.strip().startswith('DATABASE_URL='):
                value = line.strip().partition('=')[2].strip().strip('\"\'')
    url = urlsplit(value)
    if url.scheme not in ('postgres', 'postgresql') or not url.hostname:
        raise ValueError('Local runtime requires a PostgreSQL DATABASE_URL in .env.local')
    return url.hostname, url.port or 5432, unquote(url.username or ''), unquote(url.path.lstrip('/'))


def postgres_ready(endpoint):
    """Check PostgreSQL's startup response, not merely an open TCP listener.

    An authentication challenge means recovery is complete and connections are
    accepted. Workers still authenticate and check storage themselves. No password
    is sent by this probe and errors/rejection/partial replies are not readiness.
    """
    host, port, user, database = endpoint
    payload = struct.pack('!I', 196608) + f'user\0{user}\0database\0{database}\0\0'.encode()
    try:
        with socket.create_connection((host, port), timeout=2) as connection:
            connection.settimeout(2)
            connection.sendall(struct.pack('!I', len(payload) + 4) + payload)
            header = b''
            while len(header) < 9:
                chunk = connection.recv(9 - len(header))
                if not chunk:
                    return False
                header += chunk
            return header[:1] == b'R' and 8 <= struct.unpack('!I', header[1:5])[0] <= 4096
    except OSError:
        return False


def listening(port):
    try:
        with socket.create_connection(('127.0.0.1', port), timeout=1):
            return True
    except OSError:
        return False


def project_web_running(root):
    for item in Path('/proc').iterdir():
        if not item.name.isdigit():
            continue
        try:
            if item.stat().st_uid != os.getuid() or (item / 'cwd').resolve() != root:
                continue
            args = (item / 'cmdline').read_bytes().decode(errors='replace').split('\0')
            if args[0].startswith('next-server') or str(root / 'node_modules/next/dist/bin/next') in args:
                return True
        except OSError:
            pass
    return False


class Runtime:
    def __init__(self, root=ROOT, clock=time.monotonic):
        self.root, self.clock = root, clock
        self.children, self.retries, self.states = {}, {}, {}
        self.logs = root / 'logs/intelligence'
        self.logs.mkdir(parents=True, exist_ok=True)
        self.environment = {**os.environ, 'DOTENV_CONFIG_PATH': str(root / '.env.local')}

    def event(self, event, **fields):
        print(json.dumps({'at': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime()), 'event': event, **fields}), flush=True)

    def state(self, name, value):
        if self.states.get(name) != value:
            self.states[name] = value
            self.event('state_changed', component=name, state=value)

    def reap(self):
        now = self.clock()
        for name, (process, log, started) in list(self.children.items()):
            code = process.poll()
            if code is None:
                continue
            log.close()
            del self.children[name]
            failures = 0 if now - started >= STABLE_SECONDS else self.retries.get(name, (0, 0))[0]
            failures = min(failures + 1, 6)
            delay = min(60, 2 ** failures)
            self.retries[name] = (failures, now + delay)
            self.event('child_exited', component=name, code=code, retrySeconds=delay)

    def launch(self, name, arguments):
        if name in self.children or self.clock() < self.retries.get(name, (0, 0))[1]:
            return
        # An orphaned worker after supervisor SIGKILL retains this lock. Its
        # replacement cannot overlap it, even while the new supervisor retries.
        lock = f'/tmp/centrypto-{name}-{os.getuid()}.lock'
        log = open(self.logs / (name + '.log'), 'ab', buffering=0)
        try:
            process = subprocess.Popen(['flock', '--nonblock', '--conflict-exit-code', '75', '--no-fork', lock, *arguments],
                                       cwd=self.root, env=self.environment, stdin=subprocess.DEVNULL,
                                       stdout=log, stderr=subprocess.STDOUT, start_new_session=True)
        except OSError:
            log.close()
            failures = min(self.retries.get(name, (0, 0))[0] + 1, 6)
            self.retries[name] = (failures, self.clock() + min(60, 2 ** failures))
            self.event('launch_failed', component=name)
            return
        self.children[name] = (process, log, self.clock())
        self.event('child_started', component=name, pid=process.pid)

    def tick(self, app_ready):
        self.reap()
        self.state('appDatabase', 'ready' if app_ready else 'waiting')
        if not listening(55432):
            self.launch('tunnel', ['ssh', '-NT', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10',
                                  '-o', 'ExitOnForwardFailure=yes', '-o', 'StrictHostKeyChecking=yes',
                                  '-o', 'ServerAliveInterval=15', '-o', 'ServerAliveCountMax=3',
                                  '-i', str(Path.home() / '.ssh/centrypto_vps'),
                                  '-L', '127.0.0.1:55432:127.0.0.1:5432',
                                  '-L', '127.0.0.1:6089:127.0.0.1:6080', 'centrypto@96.44.160.28'])
        if app_ready:
            # Protection/reconciliation must not depend on the news/market tunnel.
            for name, script in [('worker', 'start_intelligence_worker.ts'), ('desk', 'start_trading_desk.ts'), ('research', 'start_research_worker.ts')]:
                self.launch(name, ['node', '--import', 'tsx', '-r', 'dotenv/config', str(self.root / 'scripts' / script)])
            if 'web' not in self.children and not project_web_running(self.root):
                if listening(3000):
                    self.state('web', 'port_owned_elsewhere')
                elif (self.root / '.next/BUILD_ID').is_file():
                    self.launch('web', ['node', str(self.root / 'node_modules/next/dist/bin/next'), 'start', '--hostname', '127.0.0.1', '--port', '3000'])
                    self.state('web', 'supervised')
                else:
                    self.state('web', 'production_build_missing')
        request = self.root / 'data/deployment/market-import-request.json'
        if listening(55432) and request.exists():
            try:
                if not json.loads(request.read_text()).get('complete'):
                    self.launch('history-import', [str(self.root / '.venv-ops/bin/python'), '-u', str(self.root / 'scripts/resume_market_import.py')])
            except (ValueError, OSError):
                pass
        state = {'checkedAt': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime()), 'pid': os.getpid(),
                 'appDatabaseReady': app_ready, 'vpsTunnelListening': listening(55432), 'webListening': listening(3000),
                 'children': {name: {'pid': child[0].pid} for name, child in self.children.items()},
                 'retryInSeconds': {name: round(max(0, retry[1] - self.clock()), 1) for name, retry in self.retries.items() if name not in self.children}}
        try:
            directory = self.root / '.runtime'
            directory.mkdir(exist_ok=True)
            temporary = directory / 'local-runtime-health.tmp'
            temporary.write_text(json.dumps(state))
            temporary.replace(directory / 'local-runtime-health.json')
        except OSError:
            # Disk/diagnostic failure must not stop exposure protection.
            self.state('diagnostics', 'write_failed')

    def stop_children(self, names=None):
        selected = {name: child for name, child in self.children.items() if names is None or name in names}
        for process, _, _ in selected.values():
            try:
                os.killpg(process.pid, signal.SIGTERM)
            except ProcessLookupError:
                pass
        deadline = self.clock() + 30
        for name, (process, log, _) in selected.items():
            try:
                process.wait(timeout=max(0.1, deadline - self.clock()))
            except subprocess.TimeoutExpired:
                try:
                    os.killpg(process.pid, signal.SIGKILL)
                except ProcessLookupError:
                    pass
                process.wait(timeout=5)
            log.close()
            self.children.pop(name, None)


def main():
    with open(f'/tmp/centrypto-local-runtime-{os.getuid()}.lock', 'w') as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            print('Local runtime is already running.', flush=True)
            return 75
        endpoint = database_endpoint(ROOT)
        runtime = Runtime()
        running, reload_worker = True, False

        def stop(*_):
            nonlocal running
            running = False

        def reload(*_):
            nonlocal reload_worker
            reload_worker = True

        signal.signal(signal.SIGTERM, stop)
        signal.signal(signal.SIGINT, stop)
        signal.signal(signal.SIGHUP, reload)
        runtime.event('supervisor_started', pid=os.getpid())
        try:
            while running:
                if reload_worker:
                    reload_worker = False
                    runtime.stop_children(['worker'])
                runtime.tick(postgres_ready(endpoint))
                time.sleep(POLL_SECONDS)
        finally:
            runtime.stop_children()
            runtime.event('supervisor_stopped')
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
