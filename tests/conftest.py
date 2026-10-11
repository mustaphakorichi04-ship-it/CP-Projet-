import os
import tempfile
from pathlib import Path


_test_database_dir = tempfile.TemporaryDirectory(prefix='cp-engineer-tests-')
os.environ['CP_ENV'] = 'testing'
os.environ['CP_DB_PATH'] = str(Path(_test_database_dir.name) / 'test.db')