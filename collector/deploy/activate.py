#!/usr/bin/env python3
"""Install supervised VPS collectors. Run after migrations and grants."""
import json
import os
import subprocess
import shutil
from pathlib import Path

root = Path('/opt/centrypto-collectors')
config = Path('/etc/centrypto-collectors')
credentials = json.loads((config / 'credentials.json').read_text())
node = '/opt/centrypto-node/bin/node'
npm = '/opt/centrypto-node/bin/npm'
env = {**os.environ, 'PATH': '/opt/centrypto-node/bin:' + os.environ.get('PATH', ''), 'PUPPETEER_SKIP_DOWNLOAD': 'true'}
subprocess.run([npm, 'install', '--omit=dev', '--ignore-scripts', '--loglevel=error'], cwd=root, env=env, check=True)
shutil.copytree(root / 'generated/market-client', root / 'node_modules/@prisma/market-client', dirs_exist_ok=True)
shutil.copytree(root / 'generated/news-client', root / 'node_modules/@prisma/news-client', dirs_exist_ok=True)
cache = root / 'chrome-cache'
browser_env = {**env, 'PUPPETEER_CACHE_DIR': str(cache)}
browser_env.pop('PUPPETEER_SKIP_DOWNLOAD', None)
package_root = root / 'node_modules/puppeteer'
package = json.loads((package_root / 'package.json').read_text())
cli = package['bin']['puppeteer'] if isinstance(package['bin'], dict) else package['bin']
subprocess.run([node, str(package_root / cli), 'browsers', 'install', 'chrome'], cwd=root, env=browser_env, check=True)
chrome = subprocess.check_output([node, '-e', 'Promise.resolve(require("puppeteer").executablePath()).then(value => process.stdout.write(value))'], cwd=root, env=browser_env).decode()
for name in ['chrome-sandbox', 'chrome_sandbox']:
    sandbox = Path(chrome).parent / name
    if sandbox.exists(): sandbox.chmod(0o4755)
policy = Path('/etc/apparmor.d/centrypto-chrome')
policy.write_text(f'abi <abi/4.0>,\ninclude <tunables/global>\nprofile centrypto-chrome "{chrome}" flags=(unconfined) {{\n  userns,\n}}\n')
subprocess.run(['apparmor_parser', '-r', str(policy)], check=True)

def connection(role, schema):
    return f'postgresql://centrypto_{role}:{credentials[role]}@127.0.0.1:5432/centrypto?schema={schema}&connection_limit=2&pool_timeout=30'

def environment(name, values):
    file = config / name
    file.write_text(''.join(f'{key}={value}\n' for key, value in values.items()))
    file.chmod(0o600)

environment('news.env', {'NODE_ENV': 'production', 'NEWS_DATABASE_URL': connection('browser', 'news'), 'NEWS_BRIDGE_TOKEN': credentials['bridge_token'], 'NEWS_COLLECTOR_INSTANCE_ID': 'racknerd', 'NEWS_COLLECTOR_OWNER_ADDRESS': credentials.get('owner_address', '')})
environment('browser.env', {'NODE_ENV': 'production', 'NEWS_BRIDGE_TOKEN': credentials['bridge_token'], 'CHROME_PATH': chrome, 'NEWS_EXTENSION_PATH': str(root / 'extension'), 'NEWS_PROFILE_PATH': '/var/lib/centrypto-collectors/profile', 'DISPLAY': ':99', 'XAUTHORITY': '/var/lib/centrypto-collectors/Xauthority', 'PUPPETEER_CACHE_DIR': str(cache)})
environment('market.env', {'NODE_ENV': 'production', 'MARKET_DATABASE_URL': connection('market', 'mainnet'), 'MARKET_TEST_DATABASE_URL': connection('market', 'testnet'), 'MARKET_COLLECTOR_ROLE': 'worker', 'COLLECTOR_TICK_INTERVAL_MS': '15000'})
authority = Path('/var/lib/centrypto-collectors/Xauthority')
if not authority.exists():
    import secrets
    subprocess.run(['xauth', '-f', str(authority), 'add', ':99', '.', secrets.token_hex(16)], check=True)
    subprocess.run(['chown', 'centrypto:centrypto', str(authority)], check=True)
    authority.chmod(0o600)

def unit(name, command, *, environment_file=None, after='', extra=''):
    content = f'''[Unit]
Description=Centrypto {name}
After=network-online.target postgresql.service {after}
Wants=network-online.target

[Service]
Type=simple
User=centrypto
Group=centrypto
WorkingDirectory={root}
Environment=PATH=/opt/centrypto-node/bin:/usr/local/bin:/usr/bin:/bin
Environment=DISPLAY=:99
Environment=XAUTHORITY=/var/lib/centrypto-collectors/Xauthority
{f'EnvironmentFile={config / environment_file}' if environment_file else ''}
ExecStart={command}
Restart=always
RestartSec=5
TimeoutStopSec=20
KillMode=control-group
UMask=0077
{extra}

[Install]
WantedBy=multi-user.target
'''
    Path('/etc/systemd/system/' + name + '.service').write_text(content)

unit('centrypto-display', '/usr/bin/Xvfb :99 -screen 0 1280x900x24 -nolisten tcp -auth /var/lib/centrypto-collectors/Xauthority')
unit('centrypto-desktop', '/usr/bin/openbox', after='centrypto-display.service')
unit('centrypto-vnc', '/usr/bin/x11vnc -display :99 -auth /var/lib/centrypto-collectors/Xauthority -localhost -nopw -forever -shared -rfbport 5900', after='centrypto-display.service')
unit('centrypto-desktop-web', '/usr/bin/websockify --web=/usr/share/novnc 127.0.0.1:6080 127.0.0.1:5900', after='centrypto-vnc.service')
unit('centrypto-news-bridge', f'{node} {root}/bridge.js', environment_file='news.env')
unit('centrypto-news-browser', f'{node} {root}/browser.js', environment_file='browser.env', after='centrypto-display.service centrypto-news-bridge.service', extra='MemoryHigh=900M\nMemoryMax=1200M')
unit('centrypto-market', f'{node} {root}/market.js', environment_file='market.env', extra='MemoryHigh=300M\nMemoryMax=500M')
subprocess.run(['systemctl', 'daemon-reload'], check=True)
units = ['centrypto-display', 'centrypto-desktop', 'centrypto-vnc', 'centrypto-desktop-web', 'centrypto-news-bridge', 'centrypto-news-browser', 'centrypto-market']
subprocess.run(['systemctl', 'enable', '--now', *units], check=True)
print('Supervised market/news collectors and SSH-only remote desktop activated.')
