"""Generate an inspectable first-party module/navigation index, without executing sources."""
import ast
from collections import defaultdict
import os
from pathlib import Path
import re
import subprocess

root = Path(__file__).resolve().parents[1]
roots = {'app', 'backtest_py', 'components', 'config', 'context', 'hooks', 'lib', 'prompts', 'prisma', 'scripts', 'sentiment', 'services', 'src', 'types', '__tests__', 'examples', 'collector', '.github'}
extensions = {'.ts', '.tsx', '.js', '.mjs', '.cjs', '.py', '.json', '.prisma', '.sh', '.ps1', '.sql', '.html', '.css', '.yml', '.yaml', '.toml'}
listed = subprocess.check_output(['git', 'ls-files', '-c', '-o', '--exclude-standard', '-z'], cwd=root).decode().split('\0')
files = sorted({Path(name) for name in listed if name and (len(Path(name).parts) == 1 or Path(name).parts[0] in roots) and Path(name).suffix in extensions and Path(name).name not in {'package-lock.json', 'next-env.d.ts'}})
known = set(files)

def resolve(candidate):
    normalized = Path(os.path.normpath(candidate))
    for path in [normalized, *[Path(str(normalized) + suffix) for suffix in ['.ts', '.tsx', '.js', '.mjs', '.py']], normalized/'index.ts', normalized/'index.tsx', normalized/'__init__.py']:
        if path in known: return path
    return None

def dependencies(file, text):
    found = set()
    if file.suffix == '.py':
        try:
            for node in ast.walk(ast.parse(text)):
                modules = [item.name for item in node.names] if isinstance(node, ast.Import) else [node.module] if isinstance(node, ast.ImportFrom) and node.module else []
                for module in modules:
                    target = resolve(module.replace('.', '/'))
                    if target and target != file: found.add(target)
        except SyntaxError: pass
    else:
        for match in re.finditer(r'''(?:\bfrom\s*|\brequire\(\s*|\bimport\(\s*|\bimport\s*)["']([^"']+)["']''', text):
            name = match.group(1)
            candidate = name[2:] if name.startswith('@/') else str(file.parent/name) if name.startswith('.') else ''
            if candidate:
                target = resolve(candidate)
                if target and target != file: found.add(target)
    return sorted(found)

def link(file): return f'[{file.as_posix()}](../{file.as_posix()})'

groups = defaultdict(list)
for file in files: groups[file.parts[0] if len(file.parts) > 1 else 'Root tooling'].append(file)
lines = ['# Centrypto module index', '', f'Generated from the current working tree: **{len(files)} first-party source/config/test files**.', '', 'See [architecture](architecture.md) for runtime graphs and [operations](news-intelligence-operations.md) for the deployed VPS/local split.', '', 'Dependencies list direct static first-party imports, including type-only imports. This is a navigation index; HTTP calls, dynamic dispatch, database relationships and UI mounting are described in the architecture. Installed/generated files, data, virtual environments, lockfiles and bundled upstream RSSHub internals are excluded.', '']
for group, members in sorted(groups.items()):
    lines += [f'## {group}', '', '| File | Lines | Direct first-party dependencies |', '| --- | ---: | --- |']
    for file in members:
        text = (root/file).read_text(encoding='utf8')
        refs = ', '.join(link(ref) for ref in dependencies(file, text)) or '—'
        lines.append(f'| {link(file)} | {len(text.splitlines())} | {refs} |')
    lines.append('')
(root/'docs/module-index.md').write_text('\n'.join(lines), encoding='utf8')
print(f'Indexed {len(files)} first-party files.')
