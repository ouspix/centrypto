#!/usr/bin/env bash
set -euo pipefail
if [ "$(id -u)" != 0 ]; then echo "Run this installer as root." >&2; exit 1; fi
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq ca-certificates curl unzip postgresql postgresql-client python3 python3-psycopg2 xvfb x11vnc novnc websockify openbox fonts-liberation libnss3 libatk-bridge2.0-0 libdrm2 libxkbcommon0 libgbm1 libasound2t64 libgtk-3-0 libxshmfence1
id centrypto >/dev/null 2>&1 || useradd --create-home --shell /bin/bash centrypto
install -d -m 0755 /opt/centrypto-collectors /etc/centrypto-collectors
install -d -o centrypto -g centrypto -m 0700 /var/lib/centrypto-collectors /var/lib/centrypto-collectors/profile
python3 - <<'PY'
import hashlib,json,os,secrets,subprocess,tarfile,tempfile,urllib.request
from pathlib import Path
root=Path('/etc/centrypto-collectors')
config=root/'credentials.json'
if not config.exists():
    config.write_text(json.dumps({name:secrets.token_hex(32) for name in ['admin','app','market','browser','bridge_token']}))
    config.chmod(0o600)
version_file=Path('/opt/centrypto-collectors/node-version')
if not Path('/opt/centrypto-node/bin/node').exists():
    releases=json.load(urllib.request.urlopen('https://nodejs.org/dist/index.json'))
    version=next(row['version'] for row in releases if row['version'].startswith('v22.') and 'linux-x64' in row['files'])
    filename=f'node-{version}-linux-x64.tar.xz'
    base=f'https://nodejs.org/dist/{version}/'
    checksum=urllib.request.urlopen(base+'SHASUMS256.txt').read().decode()
    expected=next(line.split()[0] for line in checksum.splitlines() if line.endswith('  '+filename))
    with tempfile.TemporaryDirectory() as tmp:
        archive=Path(tmp)/filename
        urllib.request.urlretrieve(base+filename,archive)
        if hashlib.sha256(archive.read_bytes()).hexdigest()!=expected: raise SystemExit('Node checksum mismatch')
        Path('/opt/centrypto-node').mkdir(exist_ok=True)
        subprocess.run(['tar','-xJf',str(archive),'--strip-components=1','-C','/opt/centrypto-node'],check=True)
    version_file.write_text(version+'\n')
for binary in ['node','npm','npx']:
    destination=Path('/usr/local/bin')/binary
    if not destination.exists(): destination.symlink_to('/opt/centrypto-node/bin/'+binary)
PY
systemctl enable --now postgresql
python3 - <<'PY'
import json,subprocess
from pathlib import Path
import psycopg2
credentials=json.loads(Path('/etc/centrypto-collectors/credentials.json').read_text())
commands=[]
for kind in ['admin','app','market','browser']:
    role='centrypto_'+kind
    commands.append(f"DO $$ BEGIN IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname='{role}') THEN CREATE ROLE {role} LOGIN PASSWORD '{credentials[kind]}'; END IF; END $$;")
subprocess.run(['runuser','-u','postgres','--','psql','-q','-v','ON_ERROR_STOP=1'],input='\n'.join(commands),text=True,check=True)
exists=subprocess.check_output(['runuser','-u','postgres','--','psql','-Atqc',"SELECT 1 FROM pg_database WHERE datname='centrypto'"]).decode().strip()
if not exists: subprocess.run(['runuser','-u','postgres','--','createdb','--owner=centrypto_admin','centrypto'],check=True)
sql="""
CREATE SCHEMA IF NOT EXISTS app AUTHORIZATION centrypto_admin;
CREATE SCHEMA IF NOT EXISTS news AUTHORIZATION centrypto_admin;
CREATE SCHEMA IF NOT EXISTS mainnet AUTHORIZATION centrypto_admin;
CREATE SCHEMA IF NOT EXISTS testnet AUTHORIZATION centrypto_admin;
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
ALTER SYSTEM SET shared_buffers = '64MB';
ALTER SYSTEM SET work_mem = '4MB';
ALTER SYSTEM SET max_connections = '40';
ALTER SYSTEM SET listen_addresses = '127.0.0.1';
"""
subprocess.run(['runuser','-u','postgres','--','psql','-q','-v','ON_ERROR_STOP=1','-d','centrypto'],input=sql,text=True,check=True)
PY
systemctl restart postgresql
echo "VPS collector prerequisites installed; existing unrelated services were preserved."
