import sqlite3
import os
from contextlib import contextmanager
from datetime import datetime

# Creates a local database file right next to this script
DB_PATH = os.path.join(os.path.dirname(__file__), "amadeus_local.db")

# Adapts Python datetime objects so SQLite can store them
sqlite3.register_adapter(datetime, lambda val: val.isoformat())

_conn = sqlite3.connect(DB_PATH, check_same_thread=False)
_conn.row_factory = sqlite3.Row

# Automatically initialize tables on boot
_conn.execute('''
    CREATE TABLE IF NOT EXISTS jobs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        type TEXT,
        status TEXT,
        input_filename TEXT,
        output_filename TEXT,
        target_genre TEXT,
        bars_to_extend INTEGER,
        evaluation_result TEXT,
        error_message TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        completed_at TIMESTAMP
    )
''')
_conn.execute('''
    CREATE TABLE IF NOT EXISTS genres (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        slug TEXT,
        name TEXT,
        description TEXT
    )
''')
_conn.commit()

class SQLiteTranslatorCursor:
    def __init__(self, cursor):
        self.cursor = cursor
        
    def execute(self, query, params=()):
        # Translates PostgreSQL '%s' syntax to SQLite '?' syntax
        sqlite_query = query.replace("%s", "?")
        self.cursor.execute(sqlite_query, params)
        
    def fetchone(self):
        row = self.cursor.fetchone()
        return dict(row) if row else None
        
    def fetchall(self):
        return [dict(r) for r in self.cursor.fetchall()]
        
    def __enter__(self):
        return self
        
    def __exit__(self, exc_type, exc_val, exc_tb):
        self.cursor.close()

@contextmanager
def get_conn():
    class ContextConn:
        def cursor(self):
            return SQLiteTranslatorCursor(_conn.cursor())
        def commit(self):
            _conn.commit()
        def __enter__(self):
            return self
        def __exit__(self, exc_type, exc_val, exc_tb):
            _conn.commit()
            
    yield ContextConn()