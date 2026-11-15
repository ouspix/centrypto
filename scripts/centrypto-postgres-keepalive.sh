#!/bin/sh
# Keep the distro and cluster alive; Windows owns retries if WSL itself stops.
set -eu
exec 9>/run/centrypto-postgres-keepalive.lock
flock -n 9 || exit 75
install -d -m 0755 -o 1000 -g 1000 /srv/centrypto-backtests
install -d -m 0755 /mnt/wsl/centrypto-backtests
mountpoint -q /mnt/wsl/centrypto-backtests || mount --bind /srv/centrypto-backtests /mnt/wsl/centrypto-backtests
delay=5
state=unknown
while :; do
    if pg_isready -q -h 127.0.0.1 -p 55433 -t 2; then
        if [ "$state" != ready ]; then echo "$(date -Is) PostgreSQL accepting connections"; fi
        state=ready
        delay=5
    else
        if [ "$state" != waiting ]; then echo "$(date -Is) PostgreSQL unavailable; retrying startup"; fi
        state=waiting
        # Leave slow recovery/live servers alone; systemd serializes starts.
        service_state=$(systemctl show -p ActiveState --value postgresql@17-centrypto.service 2>/dev/null || true)
        case "$service_state" in
            inactive|failed) timeout 90 systemctl start postgresql@17-centrypto.service || true ;;
        esac
        delay=$((delay * 2))
        if [ "$delay" -gt 60 ]; then delay=60; fi
    fi
    sleep "$delay"
done
