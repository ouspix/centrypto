# Local application database

The installed application uses PostgreSQL 17 in the CentryptoDB WSL distribution on the X: SSD. Its data files and WAL live inside the distribution's ext4 filesystem. The listener is on loopback port 55433. The separate SSH tunnel on 55432 serves the VPS news and market databases. The Windows task **Centrypto local PostgreSQL** starts the local server at sign-in. Inspect it with:

```powershell
Get-ScheduledTask -TaskName 'Centrypto local PostgreSQL'
wsl -d CentryptoDB -u root -- pg_lsclusters
```

The application and workers read the private `DATABASE_URL` in `.env.local`. Page checksums, fsync, full-page writes and synchronous commits are enabled. Model definitions are shared between the historical SQLite client and the PostgreSQL client. Run `npm run prisma:generate:main` after editing the models. PostgreSQL migrations belong in `prisma/app-postgres/migrations`.

## Automatic service recovery

Install/update the existing local service tasks from Windows with `scripts/install_local_runtime.ps1`. This installs the repository's `centrypto-postgres-keepalive.sh` and `postgres-restart.conf` into CentryptoDB, and copies `start_local_service.ps1` to `%LOCALAPPDATA%\Centrypto\runtime` so the Windows launcher remains accessible when WSL is stopped. Installation does not restart an already running task; gracefully restart its old process when deploying supervisor changes. `-NoStart` only skips the immediate start request; the registered triggers remain enabled.

- **Centrypto local PostgreSQL** owns a Windows retry loop around the database distro. Inside WSL, systemd restarts unexpected PostgreSQL failures after five seconds; the keepalive also retries an inactive cluster indefinitely, with delays capped at 60 seconds. It does not interrupt a server already recovering. It restores the existing shared backtest mount on each distro start.
- **Centrypto local intelligence** owns the Windows retry loop around the Python supervisor. The supervisor checks the configured PostgreSQL startup protocol before launching inference, desk, research and the production web server. Existing workers retain their reconnect loops during an outage. Protection/reconciliation startup does not require the VPS market/news tunnel to be available.
- Both Windows loops retry WSL exits, including successful exit codes, with backoff from 5 to 60 seconds. Both scheduled tasks start at sign-in and have an indefinite one-minute trigger to recover a stopped Windows launcher, even after Scheduler's failure retry count is exhausted. `IgnoreNew` and Linux process locks prevent duplicate service instances.
- The two old one-shot bootstrap tasks (**Centrypto local services**, **Centrypto start services**) are disabled. The supervisor now restarts a crashed web process as well as workers and the SSH tunnel. Existing web processes in this checkout are recognized; unrelated port-3000 listeners are left alone. A missing production build is reported, not silently replaced with development mode.

These are per-user **interactive** Windows tasks: after a Windows reboot they resume when this Windows user signs in. They do not provide unattended service before sign-in, while the PC is asleep, or while it is powered off. A full Windows reboot is not required to deploy them. The launcher continues to work after a WSL/distro shutdown while the Windows session is active.

Inspect `%LOCALAPPDATA%\Centrypto\runtime\logs` for launcher exits and supervisor events, `logs/intelligence/{worker,desk,research,web,tunnel}.log` for child output, and `.runtime/local-runtime-health.json` for the latest readiness, child PIDs and retry delays. This file reports process/dependency health; use the application heartbeat, execution reconciliation timestamp, inference availability and research runtime status to verify useful work resumed. A running process alone does not prove application health. Task XML backups are kept in `%LOCALAPPDATA%\Centrypto\runtime`.

For planned downtime, disable both managed scheduled tasks **before** stopping the Windows launchers and gracefully stopping the Linux supervisor and database keepalive. Otherwise their next retry/periodic trigger will restart the services. Re-enable and start both tasks to resume. Never delete PID/lock files to force a second worker. Recovery preserves desk enablement, mandates, leases and idempotency records; it does not resubmit expired orders or grant new trade permission. The desk reconciles exchange state before allowing live reviews after a worker restart.

## Import and verification

Stop application writers and disable the trading book before a migration. Generate the clients, apply the PostgreSQL migrations to an empty local destination, and supply that destination privately in the `APP_POSTGRES_URL` environment variable. Run:

```bash
.venv-ops/bin/python scripts/migrate_app_to_postgres.py /absolute/path/to/repaired.db
```

The importer checks source integrity, compares schema columns, respects foreign-key order, preserves sequence positions and compares every application value before committing. The original SQLite migration ledger stays in the source file. PostgreSQL keeps its own migration history. To run the desk integration suite against PostgreSQL, set `DESK_TEST_POSTGRES_URL` to a dedicated loopback database named `centrypto_test_*`. The suite creates and drops a unique fixture schema per test.

## Backups and recovery

Create custom-format backups with `pg_dump -p 55433 -Fc centrypto_app` as the local PostgreSQL administrator. Keep backups in a user-restricted directory on a second physical disk. For a restore drill, use a fresh database owned by `centrypto_app`, restore with `pg_restore --single-transaction --exit-on-error --no-owner --role=centrypto_app`, and run `pg_amcheck` against the restored database. The initial migration backup was restored and checked on November 4, 2026. Treat both SQLite and PostgreSQL backups as private wallet data.

The repaired SQLite file is a snapshot from the time of migration. Subsequent application writes go to PostgreSQL. Before switching back, reconcile all changes since the snapshot, especially orders, fills and desk instructions.
