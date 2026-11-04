"""Copy local market history into VPS PostgreSQL without changing SQLite sources.

Uses a durable progress file, bounded COPY batches, source row IDs for resume,
and natural candle keys. New VPS collection can continue during the import.
"""
from __future__ import annotations
import argparse
import hashlib
import json
import sqlite3
from datetime import datetime, timezone
from pathlib import Path
import psycopg
from psycopg import sql

def timestamp(value):
    if value is None: return None
    if isinstance(value, (int, float)): return datetime.fromtimestamp(value / 1000, timezone.utc).replace(tzinfo=None)
    return datetime.fromisoformat(str(value).replace("Z", "+00:00")).replace(tzinfo=None)

def migrate(source: Path, schema: str, credentials: dict, batch_size: int):
    state_file = Path("data/deployment") / (source.stem + "-postgres-progress.json")
    state = {}
    sqlite = sqlite3.connect(f"file:{source.resolve()}?mode=ro", uri=True, timeout=30)
    postgres = psycopg.connect(host="127.0.0.1", port=55432, dbname="centrypto", user="centrypto_admin", password=credentials["admin"], autocommit=True)
    source_key = hashlib.sha256(str(source.resolve()).encode()).hexdigest()
    with postgres.cursor() as cursor:
        cursor.execute(sql.SQL('CREATE TABLE IF NOT EXISTS {}."_CentryptoImportCursor" ("sourceKey" TEXT NOT NULL, "tableName" TEXT NOT NULL, "lastId" BIGINT NOT NULL DEFAULT 0, PRIMARY KEY ("sourceKey","tableName"))').format(sql.Identifier(schema)))
    try:
        for table in ["MarketTick", "MarketCandle"]:
            source_columns = [row[1] for row in sqlite.execute(f'PRAGMA table_info("{table}")')]
            columns = [name for name in source_columns if name != "id"]
            select_columns = ",".join('"'+name+'"' for name in ["id", *columns])
            with postgres.cursor() as cursor:
                cursor.execute(sql.SQL('INSERT INTO {}."_CentryptoImportCursor" ("sourceKey","tableName") VALUES (%s,%s) ON CONFLICT DO NOTHING').format(sql.Identifier(schema)), (source_key, table))
            last = 0
            copied = 0
            while True:
                with postgres.transaction():
                    with postgres.cursor() as cursor:
                        cursor.execute(sql.SQL('SELECT "lastId" FROM {}."_CentryptoImportCursor" WHERE "sourceKey"=%s AND "tableName"=%s FOR UPDATE').format(sql.Identifier(schema)), (source_key, table))
                        last = cursor.fetchone()[0]
                        rows = sqlite.execute(f'SELECT {select_columns} FROM "{table}" WHERE id > ? ORDER BY id LIMIT ?', (last, batch_size)).fetchall()
                        if not rows: break
                        cursor.execute(sql.SQL('CREATE TEMP TABLE migration_batch (LIKE {}.{}) ON COMMIT DROP').format(sql.Identifier(schema), sql.Identifier(table)))
                        cursor.execute('ALTER TABLE migration_batch DROP COLUMN "id"')
                        with cursor.copy(sql.SQL('COPY migration_batch ({}) FROM STDIN').format(sql.SQL(',').join(map(sql.Identifier, columns)))) as copy:
                            for row in rows:
                                values = [timestamp(value) if name in {"ts", "openTime"} else value for name, value in zip(columns, row[1:])]
                                copy.write_row(values)
                        if table == "MarketCandle":
                            conflict = sql.SQL('ON CONFLICT ("symbol","timeframe","openTime") DO NOTHING')
                        else:
                            # The cursor commits atomically with the COPY, including across crashes.
                            conflict = sql.SQL('')
                        cursor.execute(sql.SQL('INSERT INTO {}.{} ({}) SELECT {} FROM migration_batch {}').format(sql.Identifier(schema), sql.Identifier(table), sql.SQL(',').join(map(sql.Identifier, columns)), sql.SQL(',').join(map(sql.Identifier, columns)), conflict))
                        cursor.execute(sql.SQL('UPDATE {}."_CentryptoImportCursor" SET "lastId"=%s WHERE "sourceKey"=%s AND "tableName"=%s').format(sql.Identifier(schema)), (rows[-1][0], source_key, table))
                last = rows[-1][0]
                copied += len(rows)
                state[table] = last
                state_file.write_text(json.dumps(state)); state_file.chmod(0o600)
                if copied % (batch_size * 10) == 0: print(f"{schema}.{table}: {copied} rows this run", flush=True)
            print(f"{schema}.{table}: history import complete through source row {last}", flush=True)
    finally:
        sqlite.close(); postgres.close()

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--source", type=Path, required=True)
    parser.add_argument("--schema", choices=["mainnet", "testnet"], required=True)
    parser.add_argument("--batch-size", type=int, default=10000)
    args = parser.parse_args()
    credentials = json.loads(Path("data/deployment/vps-credentials.json").read_text())
    migrate(args.source, args.schema, credentials, args.batch_size)

if __name__ == "__main__": main()
