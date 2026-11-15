"""Recovery policy tests: python3 -m unittest discover -s scripts -p test_local_runtime.py."""
import json
import os
from pathlib import Path
import signal
import socket
import struct
import subprocess
import tempfile
import threading
import time
import unittest
from unittest.mock import Mock, patch

import start_local_runtime as runtime


class ReadinessTests(unittest.TestCase):
    def probe(self, response):
        with socket.socket() as server:
            server.bind(('127.0.0.1', 0))
            server.listen()
            def respond():
                connection, _ = server.accept()
                with connection:
                    connection.recv(4096)
                    for part in response:
                        connection.sendall(part)
            thread = threading.Thread(target=respond)
            thread.start()
            result = runtime.postgres_ready(('127.0.0.1', server.getsockname()[1], 'fixture', 'fixture'))
            thread.join(timeout=3)
            return result

    def test_accepts_postgres_authentication_challenge(self):
        self.assertTrue(self.probe([b'R', struct.pack('!II', 8, 0)]))

    def test_tcp_listener_is_not_readiness(self):
        self.assertFalse(self.probe([b'HTTP/1.1 200 OK']))

    def test_recovery_rejection_is_not_readiness(self):
        self.assertFalse(self.probe([b'E' + struct.pack('!I', 24) + b'SFATAL\0']))

    def test_partial_reply_is_not_readiness(self):
        self.assertFalse(self.probe([b'R\0']))

    def test_unavailable_or_timed_out_database_is_not_ready(self):
        with patch.object(runtime.socket, 'create_connection', side_effect=TimeoutError):
            self.assertFalse(runtime.postgres_ready(('localhost', 1, 'fixture', 'fixture')))

    def test_configuration_never_exposes_password(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / '.env.local').write_text('DATABASE_URL="postgresql://test:private@127.0.0.1:55433/app?schema=public"\n')
            self.assertEqual(runtime.database_endpoint(root), ('127.0.0.1', 55433, 'test', 'app'))
            (root / '.env.local').write_text('DATABASE_URL=file:old-snapshot.db')
            with self.assertRaisesRegex(ValueError, 'PostgreSQL'):
                runtime.database_endpoint(root)

    def test_existing_environment_matches_worker_dotenv_precedence(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / '.env.local').write_text('DATABASE_URL=postgresql://file_user:private@localhost/file_db')
            with patch.dict(os.environ, {'DATABASE_URL': 'postgresql://env_user:private@localhost/env_db'}):
                self.assertEqual(runtime.database_endpoint(root), ('localhost', 5432, 'env_user', 'env_db'))


class DatabaseWatchdogTests(unittest.TestCase):
    def run_cycle(self, service_state, start_code=0, ready=False, cycles=1):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            shim = '''#!/bin/sh
case "${0##*/}" in
    install|mountpoint) exit 0 ;;
    pg_isready) exit "$PROBE_CODE" ;;
    systemctl)
        if [ "$1" = show ]; then echo "$SERVICE_STATE"; exit 0; fi
        echo start >> "$CALLS"
        exit "$START_CODE" ;;
    timeout) shift; exec "$@" ;;
    sleep)
        count=0
        if [ -f "$SLEEPS" ]; then count=$(cat "$SLEEPS"); fi
        count=$((count + 1)); echo "$count" > "$SLEEPS"
        if [ "$count" -ge "$CYCLES" ]; then exit 99; fi ;;
esac
'''
            for command in ['install', 'mountpoint', 'pg_isready', 'systemctl', 'timeout', 'sleep']:
                path = root / command
                path.write_text(shim)
                path.chmod(0o755)
            source = (Path(__file__).parent / 'centrypto-postgres-keepalive.sh').read_text()
            source = source.replace('/run/centrypto-postgres-keepalive.lock', str(root / 'fixture.lock'))
            env = {**os.environ, 'PATH': str(root) + ':' + os.environ['PATH'], 'SERVICE_STATE': service_state,
                   'PROBE_CODE': '0' if ready else '1', 'START_CODE': str(start_code),
                   'CALLS': str(root / 'calls'), 'SLEEPS': str(root / 'sleeps'), 'CYCLES': str(cycles)}
            result = subprocess.run(['sh'], input=source, text=True, env=env, capture_output=True, timeout=3)
            self.assertEqual(result.returncode, 99, result.stderr)
            return (root / 'calls').read_text().splitlines() if (root / 'calls').exists() else []

    def test_does_not_cancel_start_stop_or_recovery_in_progress(self):
        for state in ['activating', 'deactivating', 'active']:
            with self.subTest(state=state):
                self.assertEqual(self.run_cycle(state), [])

    def test_restarts_only_inactive_or_failed_cluster(self):
        for state in ['inactive', 'failed']:
            with self.subTest(state=state):
                self.assertEqual(self.run_cycle(state), ['start'])

    def test_failed_start_does_not_end_watchdog(self):
        self.assertEqual(self.run_cycle('failed', start_code=1, cycles=2), ['start', 'start'])

    def test_ready_cluster_is_never_restarted(self):
        self.assertEqual(self.run_cycle('active', ready=True), [])


class SupervisorTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.root = Path(self.directory.name)
        self.now = 0
        self.runtime = runtime.Runtime(self.root, lambda: self.now)
        self.runtime.event = Mock()

    def child(self, code=None, started=0):
        process = Mock(pid=999999)
        process.poll.return_value = code
        log = Mock()
        self.runtime.children['desk'] = (process, log, started)
        return process, log

    @patch.object(runtime, 'listening', return_value=False)
    @patch.object(runtime, 'project_web_running', return_value=False)
    def test_boot_waits_for_database_then_starts_workers_without_vps(self, *_):
        self.runtime.launch = Mock()
        self.runtime.tick(False)
        self.assertEqual([call.args[0] for call in self.runtime.launch.call_args_list], ['tunnel'])
        self.runtime.launch.reset_mock()
        self.runtime.tick(True)
        self.assertEqual([call.args[0] for call in self.runtime.launch.call_args_list], ['tunnel', 'worker', 'desk', 'research'])

    @patch.object(runtime, 'listening', return_value=True)
    def test_database_outage_leaves_running_protection_alive(self, *_):
        process, _ = self.child()
        self.runtime.launch = Mock()
        self.runtime.tick(False)
        self.assertIn('desk', self.runtime.children)
        process.terminate.assert_not_called()
        self.runtime.launch.assert_not_called()
        health = json.loads((self.root / '.runtime/local-runtime-health.json').read_text())
        self.assertFalse(health['appDatabaseReady'])
        self.assertEqual(health['children']['desk']['pid'], process.pid)

    def test_crash_retries_are_bounded_and_reset_after_stability(self):
        for expected_delay in [2, 4, 8, 16, 32, 60, 60]:
            _, log = self.child(code=1, started=self.now)
            self.runtime.reap()
            self.assertEqual(self.runtime.retries['desk'][1] - self.now, expected_delay)
            log.close.assert_called_once()
            self.now += expected_delay
        self.child(code=1, started=self.now - 61)
        self.runtime.reap()
        self.assertEqual(self.runtime.retries['desk'][1] - self.now, 2)

    @patch.object(runtime.subprocess, 'Popen')
    def test_no_duplicate_child_and_backoff_prevents_launch_storm(self, popen):
        self.child()
        self.runtime.launch('desk', ['fixture'])
        popen.assert_not_called()
        self.runtime.children.clear()
        self.runtime.retries['desk'] = (3, 8)
        self.runtime.launch('desk', ['fixture'])
        popen.assert_not_called()
        self.now = 8
        self.runtime.launch('desk', ['fixture'])
        popen.assert_called_once()
        self.runtime.children['desk'][1].close()

    @patch.object(runtime.subprocess, 'Popen', side_effect=OSError('fixture'))
    def test_spawn_failure_is_retried(self, *_):
        self.runtime.launch('desk', ['fixture'])
        self.assertEqual(self.runtime.retries['desk'], (1, 2))
        self.assertNotIn('desk', self.runtime.children)

    @patch.object(runtime, 'listening', return_value=True)
    def test_diagnostic_disk_failure_does_not_stop_workers(self, *_):
        self.child()
        (self.root / '.runtime').write_text('not a directory')
        self.runtime.tick(False)
        self.assertIn('desk', self.runtime.children)
        self.assertEqual(self.runtime.states['diagnostics'], 'write_failed')

    @patch.object(runtime, 'listening', return_value=True)
    @patch.object(runtime, 'project_web_running', return_value=False)
    def test_unrelated_web_listener_is_left_untouched(self, *_):
        self.runtime.launch = Mock()
        self.runtime.tick(True)
        self.assertNotIn('web', [call.args[0] for call in self.runtime.launch.call_args_list])
        self.assertEqual(self.runtime.states['web'], 'port_owned_elsewhere')

    def test_orphan_lock_prevents_duplicate_after_supervisor_restart(self):
        # Real exec/flock processes, with an isolated lock name, not live workers.
        name = 'recovery-test-' + str(os.getpid())
        first = runtime.Runtime(self.root)
        second = runtime.Runtime(self.root)
        first.event = second.event = Mock()
        try:
            first.launch(name, ['sleep', '30'])
            time.sleep(0.1)
            second.launch(name, ['sleep', '30'])
            duplicate = second.children[name][0]
            self.assertEqual(duplicate.wait(timeout=3), 75)
            self.assertIsNone(first.children[name][0].poll())
            first.stop_children()
            second.reap()
            second.retries.clear()
            second.launch(name, ['sleep', '30'])
            time.sleep(0.1)
            self.assertIsNone(second.children[name][0].poll())
        finally:
            first.stop_children()
            second.stop_children()
            Path(f'/tmp/centrypto-{name}-{os.getuid()}.lock').unlink(missing_ok=True)


if __name__ == '__main__':
    unittest.main()
