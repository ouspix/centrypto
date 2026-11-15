"""Recover bounded rowid ranges into a NEW archive; never modify the source.

Copies database-file rows, rejects non-empty WAL files, journals skipped damaged ranges, and resumes by
table/range after interruption. Indexes are rebuilt only after all table data.
An integrity/coverage report must be reviewed before activating the result.
"""
import argparse
import json
import os
from pathlib import Path
import sqlite3
import time

TABLES = ('MarketTick', 'MarketCandle', 'MarketFeature', 'MarketBook', 'BacktestArchiveIngest')

def recover(source: Path, destination: Path, batch: int):
    source, destination = source.resolve(strict=True), destination.resolve()
    if source == destination or destination.parent == source.parent:
        raise ValueError('Use a separate recovery directory; never overwrite the source')
    wal = Path(str(source) + '-wal')
    if wal.exists() and wal.stat().st_size:
        raise ValueError('Source has WAL data; use a WAL-aware recovery method rather than ignoring committed frames')
    destination.parent.mkdir(parents=True, exist_ok=True)
    temp = destination.parent / 'sqlite-temp'
    temp.mkdir(exist_ok=True)
    os.environ['SQLITE_TMPDIR'] = str(temp)
    report_path = destination.with_suffix('.recovery.json')
    fingerprint = {'path': str(source), 'size': source.stat().st_size, 'mtimeNs': source.stat().st_mtime_ns}
    state = json.loads(report_path.read_text()) if report_path.exists() else {'source': fingerprint, 'tables': {}, 'skipped': [], 'status': 'copying'}
    if state['source'] != fingerprint: raise ValueError('Source changed since recovery began')
    if destination.exists() and not report_path.exists(): raise ValueError('Destination exists without recovery state')
    def checkpoint():
        tmp = report_path.with_suffix('.json.tmp')
        tmp.write_text(json.dumps(state, indent=2))
        tmp.replace(report_path)
    checkpoint()
    src = sqlite3.connect(source.as_uri() + '?mode=ro&immutable=1', uri=True)
    src.execute('PRAGMA query_only=ON')
    src.execute('PRAGMA cache_size=-32768')
    dst = sqlite3.connect(destination)
    dst.execute('PRAGMA journal_mode=WAL')
    dst.execute('PRAGMA synchronous=FULL')
    dst.execute('PRAGMA cache_size=-65536')
    dst.execute('PRAGMA temp_store=FILE')
    schema = src.execute("SELECT type,name,tbl_name,sql FROM sqlite_master WHERE sql IS NOT NULL").fetchall()
    def read_range(table, low, high):
        try:
            rows = src.execute(f'SELECT * FROM "{table}" NOT INDEXED WHERE rowid BETWEEN ? AND ? ORDER BY rowid', (low, high)).fetchall()
            return rows
        except sqlite3.DatabaseError as error:
            if not any(word in str(error).lower() for word in ('malformed', 'corrupt')): raise
            if high - low < 32:
                state['skipped'].append({'table': table, 'firstRowId': low, 'lastRowId': high, 'reason': 'damaged SQLite page or btree'})
                return []
            middle = (low + high) // 2
            return read_range(table, low, middle) + read_range(table, middle + 1, high)
    last_log = 0
    try:
        for table in TABLES:
            sql = next(sql for kind,name,_,sql in schema if kind == 'table' and name == table)
            dst.execute(sql.replace('CREATE TABLE ', 'CREATE TABLE IF NOT EXISTS ', 1) if 'IF NOT EXISTS' not in sql.upper() else sql)
            progress = state['tables'].setdefault(table, {'throughRowId': 0, 'copiedRows': 0, 'maxRowId': src.execute(f'SELECT max(rowid) FROM "{table}"').fetchone()[0] or 0})
            high = progress['throughRowId']
            while high < progress['maxRowId']:
                low, high = high + 1, min(high + batch, progress['maxRowId'])
                rows = read_range(table, low, high)
                if rows:
                    placeholders = ','.join('?' for _ in rows[0])
                    dst.executemany(f'INSERT OR REPLACE INTO "{table}" VALUES ({placeholders})', rows)
                dst.commit()
                progress['throughRowId'] = high
                progress['copiedRows'] += len(rows)
                checkpoint()
                if time.monotonic() - last_log > 20:
                    print(json.dumps({'table': table, **progress, 'skippedRanges': len(state['skipped'])}), flush=True)
                    last_log = time.monotonic()
            print(json.dumps({'completedTable': table, **progress}), flush=True)
        state['status'] = 'indexing'; checkpoint()
        for kind,name,table,sql in schema:
            if kind == 'index' and table in TABLES:
                print(json.dumps({'buildingIndex': name}), flush=True)
                dst.execute(sql.replace('CREATE UNIQUE INDEX ', 'CREATE UNIQUE INDEX IF NOT EXISTS ', 1).replace('CREATE INDEX ', 'CREATE INDEX IF NOT EXISTS ', 1))
                dst.commit()
        state['status'] = 'checking'; checkpoint()
        state['integrityCheck'] = [row[0] for row in dst.execute('PRAGMA integrity_check')]
        state['status'] = 'recovered_with_gaps' if state['skipped'] else 'recovered'
        if state['integrityCheck'] != ['ok']: state['status'] = 'invalid'
        if source.stat().st_size != fingerprint['size'] or source.stat().st_mtime_ns != fingerprint['mtimeNs'] or (wal.exists() and wal.stat().st_size):
            state['status'] = 'invalid'
            state['error'] = 'Source changed during recovery'
        checkpoint()
        dst.execute('PRAGMA wal_checkpoint(TRUNCATE)')
        print(json.dumps({'status': state['status'], 'integrityCheck': state['integrityCheck'], 'skippedRanges': len(state['skipped'])}), flush=True)
        if state['status'] == 'invalid': raise ValueError('Recovered archive failed validation; do not activate it')
    finally:
        src.close(); dst.close()

if __name__ == '__main__':
    p = argparse.ArgumentParser()
    p.add_argument('source', type=Path)
    p.add_argument('destination', type=Path)
    p.add_argument('--batch', type=int, default=2000)
    a = p.parse_args()
    if not 100 <= a.batch <= 10000: p.error('batch must be 100..10000')
    recover(a.source, a.destination, a.batch)
