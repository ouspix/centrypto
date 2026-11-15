import importlib.util
import json
from pathlib import Path
import sqlite3
import tempfile
import unittest

spec = importlib.util.spec_from_file_location('recovery', Path(__file__).resolve().parents[1] / 'scripts/recover_backtest_archive.py')
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)

class ArchiveRecoveryTests(unittest.TestCase):
    def fixture(self, root):
        source = root / 'original.db'
        db = sqlite3.connect(source)
        for table in module.TABLES:
            db.execute(f'CREATE TABLE "{table}" (id INTEGER PRIMARY KEY, value TEXT)')
            db.executemany(f'INSERT INTO "{table}" VALUES (?,?)', [(n, 'x'*1000) for n in range(1,101)])
        db.commit()
        page = db.execute("SELECT pageno FROM dbstat WHERE name='MarketFeature' AND pagetype='leaf' ORDER BY pageno LIMIT 1").fetchone()[0]
        page_size = db.execute('PRAGMA page_size').fetchone()[0]
        db.close()
        return source, page, page_size

    def test_resumes_without_duplicates_and_rejects_changed_source(self):
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory); source,_,_=self.fixture(root); target=root/'recovery'/'fixed.db'
            module.recover(source,target,100)
            module.recover(source,target,100)
            report=json.loads(target.with_suffix('.recovery.json').read_text())
            self.assertEqual(report['status'],'recovered')
            with sqlite3.connect(target) as db:
                self.assertEqual(db.execute('SELECT count(*) FROM MarketFeature').fetchone()[0],100)
            with source.open('ab') as file: file.write(b'changed')
            with self.assertRaisesRegex(ValueError,'Source changed'): module.recover(source,target,100)

    def test_preserves_corrupt_original_and_reports_omitted_ranges(self):
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory); source,page,page_size=self.fixture(root); target=root/'recovery'/'fixed.db'
            with source.open('r+b') as file:
                file.seek((page-1)*page_size); file.write(b'\xff'*page_size)
            original=source.read_bytes()
            module.recover(source,target,100)
            report=json.loads(target.with_suffix('.recovery.json').read_text())
            self.assertEqual(source.read_bytes(),original)
            self.assertEqual(report['status'],'recovered_with_gaps')
            self.assertTrue(report['skipped'])
            self.assertEqual(report['integrityCheck'],['ok'])
            self.assertEqual(report['tables']['MarketBook']['copiedRows'],100)
            self.assertLess(report['tables']['MarketFeature']['copiedRows'],100)

    def test_refuses_to_ignore_wal_data(self):
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory); source,_,_=self.fixture(root)
            Path(str(source)+'-wal').write_bytes(b'wal data')
            with self.assertRaisesRegex(ValueError,'WAL data'): module.recover(source,root/'recovery'/'fixed.db',100)

if __name__ == '__main__': unittest.main()
