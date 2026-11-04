#!/usr/bin/env bash
set -euo pipefail
# Bootstrap the unpacked extension with Puppeteer first (activate.py). Production
# account sign-in and collection then use a normal Chrome process, without a
# WebDriver/CDP controller or request interception.
if ! command -v google-chrome-stable >/dev/null; then
  curl --fail --location --silent --show-error https://dl.google.com/linux/direct/google-chrome-stable_current_amd64.deb -o /var/tmp/centrypto-google-chrome.deb
  DEBIAN_FRONTEND=noninteractive apt-get install -y -qq /var/tmp/centrypto-google-chrome.deb
fi
test -f /var/lib/centrypto-collectors/profile/Default/Preferences
install -d /etc/systemd/system/centrypto-news-browser.service.d
cat > /etc/systemd/system/centrypto-news-browser.service.d/interactive.conf <<'UNIT'
[Service]
ExecStart=
ExecStart=/usr/bin/google-chrome-stable --user-data-dir=/var/lib/centrypto-collectors/profile --no-first-run --no-default-browser-check --window-size=1280,900 --start-maximized about:blank
UNIT
systemctl daemon-reload
systemctl restart centrypto-news-browser
echo "Normal Chrome enabled. Images and account sign-in render normally; the extension remains the collector."
