#!/bin/sh
# Run as root in CentryptoDB. Share its SSD-backed ext4 directory with Ubuntu.
set -eu
install -d -m 0755 -o 1000 -g 1000 /srv/centrypto-backtests
install -d -m 0755 /mnt/wsl/centrypto-backtests
mountpoint -q /mnt/wsl/centrypto-backtests || mount --bind /srv/centrypto-backtests /mnt/wsl/centrypto-backtests
target=/usr/local/sbin/centrypto-postgres-keepalive
if ! grep -q '# Shared backtest archive storage' "$target"; then
    test -e "$target.pre-backtest" || cp -p "$target" "$target.pre-backtest"
    awk '{print} /^set -eu$/ {print "# Shared backtest archive storage"; print "install -d -m 0755 -o 1000 -g 1000 /srv/centrypto-backtests"; print "install -d -m 0755 /mnt/wsl/centrypto-backtests"; print "mountpoint -q /mnt/wsl/centrypto-backtests || mount --bind /srv/centrypto-backtests /mnt/wsl/centrypto-backtests"}' "$target" > "$target.tmp"
    chmod 755 "$target.tmp"
    mv "$target.tmp" "$target"
fi
