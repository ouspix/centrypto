"""Bind this dedicated browser profile to its existing verified application wallet."""
import json
from pathlib import Path
import re
import subprocess
import sys
owner = Path(sys.argv[1]).read_text().strip().lower()
if not re.fullmatch(r'0x[0-9a-f]{40}', owner): raise SystemExit('Invalid wallet pairing')
directory = Path('/etc/centrypto-collectors')
file = directory/'credentials.json'
credentials = json.loads(file.read_text())
credentials['owner_address'] = owner
file.write_text(json.dumps(credentials)); file.chmod(0o600)
environment = directory/'news.env'
if environment.exists():
    lines = [line for line in environment.read_text().splitlines() if not line.startswith('NEWS_COLLECTOR_OWNER_ADDRESS=')]
    environment.write_text('\n'.join([*lines, 'NEWS_COLLECTOR_OWNER_ADDRESS='+owner])+'\n'); environment.chmod(0o600)
    subprocess.run(['systemctl', 'restart', 'centrypto-news-bridge'], check=True)
print('Collector browser paired to its application wallet.')
