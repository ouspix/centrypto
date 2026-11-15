"""Activate the prepared collector using its existing supervisor and service owner."""
import pathlib, hashlib, json, os, signal, shutil, subprocess, time
root=pathlib.Path('/opt/centrypto-collectors')
assert root.resolve()==root and root.stat().st_uid==os.getuid()
release=json.loads((root/'provenance-release.json').read_text())
new=root/'market-provenance.js';target=root/'market.js';backup=root/'market-before-provenance-20261115.js'
assert hashlib.sha256(new.read_bytes()).hexdigest()==release['sha256']
def pid():
    return int(subprocess.check_output(['systemctl','show','centrypto-market','--property=MainPID','--value']).strip())
def restart_owned_process():
    current=pid()
    assert current>1
    proc=pathlib.Path('/proc')/str(current)
    assert proc.stat().st_uid==os.getuid()
    assert str(target).encode() in (proc/'cmdline').read_bytes().split(b'\0')
    os.kill(current,signal.SIGTERM)
    return current
if not backup.exists():shutil.copy2(target,backup)
os.replace(new,target)
old=restart_owned_process()
for _ in range(40):
    time.sleep(.5)
    current=pid()
    if current>1 and current!=old:
        time.sleep(3)
        if pid()==current:
            print(json.dumps({'status':'activated','pid':current,'previous_pid':old,'sha256':release['sha256'],'backup':str(backup)}));break
else:
    shutil.copy2(backup,target)
    if pid()>1:restart_owned_process()
    raise RuntimeError('New collector did not stay running; previous bundle restored')
