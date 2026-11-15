"""Copy a quiesced SQLite app into a freshly migrated local PostgreSQL database.

Run with the operations venv, a source database path, and APP_POSTGRES_URL in the
environment. Verify typed values in primary-key order before committing.
"""
import os
import sqlite3
import sys
from datetime import datetime, timedelta, timezone
from itertools import zip_longest
from pathlib import Path
from urllib.parse import urlparse

import psycopg


def quote(name):
    return '"' + name.replace('"', '""') + '"'


def convert(value, kind):
    if value is None:
        return None
    if kind == 'boolean':
        if value not in (0, 1):
            raise ValueError('Unexpected SQLite boolean')
        return bool(value)
    if kind == 'timestamp without time zone':
        if isinstance(value, int):
            return datetime(1970, 1, 1) + timedelta(milliseconds=value)
        date = datetime.fromisoformat(value.replace('Z', '+00:00'))
        return date.astimezone(timezone.utc).replace(tzinfo=None) if date.tzinfo else date
    return value


def migrate(src, pg):
    tables = {row[0] for row in src.execute("SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%'")} - {'_prisma_migrations'}
    column_types = {}
    for t, col, kind in pg.execute("SELECT table_name,column_name,data_type FROM information_schema.columns WHERE table_schema='public'"):
        column_types.setdefault(t, {})[col] = kind
    if tables != set(column_types) - {'_prisma_migrations'}:
        raise ValueError('Source and destination tables differ')
    parents = {t: {r[2] for r in src.execute(f'PRAGMA foreign_key_list({quote(t)})')} for t in tables}
    sequences = dict(src.execute('SELECT name,seq FROM sqlite_sequence'))
    copied = set()
    while copied != tables:
        ready = sorted(t for t in tables - copied if parents[t] <= copied)
        if not ready:
            raise ValueError('Unresolved table dependency')
        for table in ready:
            q = quote(table)
            info = src.execute(f'PRAGMA table_info({q})').fetchall()
            names = [c[1] for c in info]
            kinds = column_types[table]
            if set(names) != set(kinds) or pg.execute(f'SELECT EXISTS(SELECT FROM {q})').fetchone()[0]:
                raise ValueError(f'{table}: require matching columns and empty target')
            pk = [c[1] for c in sorted(info, key=lambda c: c[5]) if c[5]]
            cols = ','.join(map(quote, names))
            order = ','.join(map(quote, pk))
            pg_order = ','.join(quote(c) + (' COLLATE "C"' if kinds[c] == 'text' else '') for c in pk)

            def source_rows():
                for raw in src.execute(f'SELECT {cols} FROM {q} ORDER BY {order}'):
                    yield tuple(convert(v, kinds[n]) for v, n in zip(raw, names))

            with pg.cursor().copy(f'COPY {q} ({cols}) FROM STDIN') as stream:
                for row in source_rows():
                    stream.write_row(row)
            count = 0
            with pg.cursor(name='check_rows') as rows:
                rows.execute(f'SELECT {cols} FROM {q} ORDER BY {pg_order}')
                for count, (left, right) in enumerate(zip_longest(source_rows(), rows), 1):
                    if left != right:
                        raise ValueError(f'{table}: verification failed at row {count}')
            if len(pk) == 1:
                seq = pg.execute('SELECT pg_get_serial_sequence(%s,%s)', (q, pk[0])).fetchone()[0]
                if seq:
                    maximum = pg.execute(f'SELECT max({quote(pk[0])}) FROM {q}').fetchone()[0] or 0
                    value = max(maximum, sequences.get(table, 0))
                    pg.execute('SELECT setval(%s,%s,%s)', (seq, max(1, value), value > 0))
            print(f'{table}: {count} verified', flush=True)
            copied.add(table)


if __name__ == '__main__':
    url = os.environ['APP_POSTGRES_URL']
    if urlparse(url).hostname not in ('localhost', '127.0.0.1', '::1'):
        raise ValueError('Destination must be local')
    src = sqlite3.connect(Path(sys.argv[1]).resolve().as_uri() + '?mode=ro', uri=True)
    src.execute('BEGIN')
    if src.execute('PRAGMA integrity_check').fetchall() != [('ok',)] or src.execute('PRAGMA foreign_key_check').fetchone():
        raise ValueError('Source integrity check failed')
    if src.execute('SELECT count(*) FROM DeskBook WHERE enabled').fetchone()[0]:
        raise ValueError('Pause trading before migration')
    with psycopg.connect(url) as pg:
        migrate(src, pg)
