"""Хранилище: SQLite (ответы API, индекс картинок, коллекции для прогрева) и общие таблицы сервиса."""

from __future__ import annotations

import json
import logging
import sqlite3
import threading
import time
from pathlib import Path

log = logging.getLogger("tapokhub")


# ---------------------------------------------------------------- хранилище (SQLite)

SCHEMA = """
CREATE TABLE IF NOT EXISTS api_cache(
    key TEXT PRIMARY KEY, status INTEGER NOT NULL, ctype TEXT, body BLOB,
    fetched_at INTEGER NOT NULL, hits INTEGER NOT NULL DEFAULT 0, last_hit INTEGER
);
CREATE TABLE IF NOT EXISTS images(
    key TEXT PRIMARY KEY, size TEXT NOT NULL, name TEXT NOT NULL, bytes INTEGER NOT NULL,
    ctype TEXT, fetched_at INTEGER NOT NULL, hits INTEGER NOT NULL DEFAULT 0, last_hit INTEGER
);
CREATE TABLE IF NOT EXISTS meta(k TEXT PRIMARY KEY, v TEXT, updated_at INTEGER);
CREATE TABLE IF NOT EXISTS collections(
    id TEXT PRIMARY KEY, title TEXT NOT NULL, tmdb_collection INTEGER NOT NULL,
    extras TEXT NOT NULL DEFAULT '[]', position INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS seen(
    kind TEXT NOT NULL, value TEXT NOT NULL, n INTEGER NOT NULL DEFAULT 0, last INTEGER,
    PRIMARY KEY(kind, value)
);
"""

SEED_COLLECTIONS = [
    ("harry-potter", "Гарри Поттер", 1241, "[]", 1),
    ("fast-furious", "Форсаж", 9485, json.dumps([{"type": "movie", "id": 384018}]), 2),
]


class Store:
    """SQLite: по соединению на поток, WAL."""

    def __init__(self, path: Path):
        self.path = path
        self.local = threading.local()
        path.parent.mkdir(parents=True, exist_ok=True)
        with self.conn() as c:
            c.executescript(SCHEMA)
            if not c.execute("SELECT 1 FROM collections LIMIT 1").fetchone():
                c.executemany("INSERT INTO collections VALUES (?,?,?,?,?)", SEED_COLLECTIONS)

    def conn(self) -> sqlite3.Connection:
        c = getattr(self.local, "c", None)
        if c is None:
            c = sqlite3.connect(str(self.path), timeout=30, isolation_level=None)
            c.row_factory = sqlite3.Row
            c.execute("PRAGMA journal_mode=WAL")
            c.execute("PRAGMA synchronous=NORMAL")
            self.local.c = c
        return c

    def close(self) -> None:
        """Закрыть SQLite-соединение текущего потока в конце его работы."""
        c = getattr(self.local, "c", None)
        if c is not None:
            c.close()
            del self.local.c

    def run_and_close(self, fn, *args):
        try:
            return fn(*args)
        finally:
            self.close()

    def meta_get(self, k: str) -> str | None:
        r = self.conn().execute("SELECT v FROM meta WHERE k=?", (k,)).fetchone()
        return r["v"] if r else None

    def meta_set(self, k: str, v: str) -> None:
        self.conn().execute(
            "INSERT INTO meta(k,v,updated_at) VALUES(?,?,?) ON CONFLICT(k) DO UPDATE SET v=excluded.v, updated_at=excluded.updated_at",
            (k, v, int(time.time())),
        )

    def meta_age(self, k: str) -> float | None:
        r = self.conn().execute("SELECT updated_at FROM meta WHERE k=?", (k,)).fetchone()
        return time.time() - r["updated_at"] if r else None

    def seen(self, kind: str, value: str) -> None:
        self.conn().execute(
            "INSERT INTO seen(kind,value,n,last) VALUES(?,?,1,?) ON CONFLICT(kind,value) DO UPDATE SET n=n+1,last=excluded.last",
            (kind, value, int(time.time())),
        )

    def seen_values(self, kind: str) -> list[str]:
        return [r["value"] for r in self.conn().execute("SELECT value FROM seen WHERE kind=? ORDER BY n DESC", (kind,))]
