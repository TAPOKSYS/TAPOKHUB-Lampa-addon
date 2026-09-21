"""Кеширующий прокси TMDB: ответы API в SQLite, картинки на диске, последняя копия при недоступном TMDB, прогрев коллекций.

Ключ TMDB не хранится в настройках: Lampa сама присылает его в каждом запросе (api_key=...), сервис запоминает
последний рабочий. Если ключа ещё нет или он перестал подходить, его берут из опубликованной Lampa
(function key() { return '...' } в app.min.js).
"""

from __future__ import annotations

import json
import logging
import os
import re
import tempfile
import threading
import time
import urllib.parse
from pathlib import Path

from tapokhub import __version__
from tapokhub.core.common import DAY, HOUR, UpstreamError
from tapokhub.core.config import Config
from tapokhub.core.net import RateLimiter, SingleFlight, http_get
from tapokhub.core.store import Store
from tapokhub.libraries.tmdb_logos import pick_logo
from tapokhub.modules.library import Library
from tapokhub.modules.telegram import Telegram
from tapokhub.modules.users import Users
from tapokhub.core.i18n import tr

log = logging.getLogger("tapokhub")

EVICT_EVERY = 200          # как часто (по числу записей в кеш) проверять пределы кешей


KEY_RE = re.compile(r"^[0-9a-f]{32}$")
NAME_RE = re.compile(r"^[A-Za-z0-9_\-]{8,64}\.(jpg|jpeg|png|svg|webp)$")


def ttl_for(path: str) -> int:
    """Сколько живёт копия ответа API (секунды). Устаревшая всё равно отдаётся, если TMDB недоступен."""
    if re.match(r"^(collection/\d+|(movie|tv)/\d+(/images|/external_ids|/credits|/videos)?|tv/\d+/season/\d+)$", path):
        return DAY
    if re.match(r"^(movie|tv)/\d+/(recommendations|similar)$", path):
        return 6 * HOUR
    if path.startswith(("search/", "discover/", "trending/")):
        return 10 * 60
    if path.startswith(("configuration", "genre/")):
        return 7 * DAY
    return HOUR


def cache_key(path: str, params: list[tuple[str, str]]) -> str:
    """Ключ кеша: путь + параметры без api_key (у разных клиентов ключи разные, данные одни)."""
    rest = sorted((k, v) for k, v in params if k != "api_key")
    return path + "?" + urllib.parse.urlencode(rest)


def extract_key(js: str) -> list[str]:
    """Кандидаты на ключ TMDB из текста опубликованной Lampa: сначала function key(), затем любые 32-hex."""
    out: list[str] = []
    m = re.search(r"function\s+key\s*\(\s*\)\s*\{\s*return\s*['\"]([0-9a-f]{32})['\"]", js)
    if m:
        out.append(m.group(1))
    for k in re.findall(r"['\"]([0-9a-f]{32})['\"]", js):
        if k not in out:
            out.append(k)
    return out[:10]


# ---------------------------------------------------------------- ядро

class Proxy:
    def __init__(self, cfg: Config):
        self.cfg = cfg
        cfg.img_dir.mkdir(parents=True, exist_ok=True)
        self.store = Store(cfg.db_path)
        self.flight = SingleFlight()
        self.limiter = RateLimiter(cfg.rate_limit)
        self.heavy_limiter = RateLimiter(cfg.heavy_limit)
        self.stats = {"api_hit": 0, "api_miss": 0, "api_stale": 0, "img_hit": 0, "img_miss": 0, "upstream_errors": 0}
        self.stats_lock = threading.Lock()
        self.last_warm: float | None = None
        self.writes = 0            # сколько записей в кеш сделано; каждые EVICT_EVERY проверяем предел кеша
        self.users = Users(self.store, cfg.token, cfg.cub_domains)
        self.library = Library(self)
        self.telegram = Telegram(self)

    def bump(self, name: str) -> None:
        with self.stats_lock:
            self.stats[name] += 1

    # ---- ключ TMDB

    def key(self) -> str | None:
        return self.store.meta_get("tmdb_key")

    def learn_key(self, key: str, source: str) -> None:
        """Запомнить ключ, только если апстрим его уже принял (вызывать после 200)."""
        if KEY_RE.match(key) and key != self.key():
            self.store.meta_set("tmdb_key", key)
            self.store.meta_set("tmdb_key_source", source)
            log.info(tr("ключ TMDB обновлён (источник: %s)"), source)

    def key_valid(self, key: str) -> bool:
        try:
            st, _, _ = http_get(f"{self.cfg.api_upstream}/3/configuration?api_key={key}", self.cfg.upstream_timeout, 1 << 20)
            return st == 200
        except UpstreamError:
            return False

    def refresh_key_from_lampa(self) -> bool:
        """Достать ключ из опубликованной Lampa. Ключ принимается только после проверки в TMDB."""
        try:
            st, data, _ = http_get(self.cfg.lampa_app_url, self.cfg.upstream_timeout, 8 * 1024**2)
        except UpstreamError as e:
            log.warning(tr("не удалось скачать Lampa: %s"), e)
            return False
        if st != 200:
            return False
        for cand in extract_key(data.decode("utf-8", "ignore")):
            if self.key_valid(cand):
                self.learn_key(cand, "lampa")
                self.store.meta_set("tmdb_key_checked", str(int(time.time())))
                return True
        log.warning(tr("в Lampa не нашлось рабочего ключа TMDB"))
        return False

    def ensure_key(self) -> str | None:
        """Ключ для собственных запросов сервиса: последний присланный Lampa, иначе взять у Lampa."""
        key = self.key()
        age = self.store.meta_age("tmdb_key_checked")
        if key and (age is None or age > DAY):
            if self.key_valid(key):
                self.store.meta_set("tmdb_key_checked", str(int(time.time())))
            else:
                key = None
        if not key:
            self.refresh_key_from_lampa()
            key = self.key()
        return key

    # ---- API

    def fetch_api(self, path: str, params: list[tuple[str, str]], key: str) -> tuple[int, bytes, str]:
        q = [(k, v) for k, v in params if k != "api_key"] + [("api_key", key)]
        url = f"{self.cfg.api_upstream}/3/{path}?{urllib.parse.urlencode(q)}"
        return http_get(url, self.cfg.upstream_timeout, self.cfg.max_download)

    def get_api(self, path: str, params: list[tuple[str, str]], client_key: str | None, force: bool = False,
                learn: bool = True) -> tuple[int, bytes, str, str]:
        """-> (status, body, content-type, hit|miss|stale). learn=False: ключ клиента используется для этого запроса, но не запоминается."""
        ck = cache_key(path, params)
        now = int(time.time())
        row = self.store.conn().execute("SELECT * FROM api_cache WHERE key=?", (ck,)).fetchone()
        ttl = ttl_for(path)
        if row and not force and now - row["fetched_at"] < (ttl if row["status"] == 200 else min(ttl, HOUR)):
            self.store.conn().execute("UPDATE api_cache SET hits=hits+1,last_hit=? WHERE key=?", (now, ck))
            self.bump("api_hit")
            return row["status"], row["body"], row["ctype"], "hit"

        key = client_key if client_key and KEY_RE.match(client_key) else self.key()
        if not key:
            if row:
                return row["status"], row["body"], row["ctype"], "stale"
            raise UpstreamError(401, b'{"status_message":"no TMDB key known yet","success":false}')

        def go() -> tuple[int, bytes, str]:
            st, body, ctype = self.fetch_api(path, params, key)
            if st in (200, 404):
                self.store.conn().execute(
                    "INSERT INTO api_cache(key,status,ctype,body,fetched_at,hits,last_hit) VALUES(?,?,?,?,?,0,?) "
                    "ON CONFLICT(key) DO UPDATE SET status=excluded.status, ctype=excluded.ctype, body=excluded.body, fetched_at=excluded.fetched_at",
                    (ck, st, ctype or "application/json", body, int(time.time()), int(time.time())),
                )
                if st == 200 and client_key and learn:
                    self.learn_key(client_key, "lampa-request")
                self.writes += 1
                if self.writes % EVICT_EVERY == 0:
                    self.evict_api()
            return st, body, ctype

        try:
            st, body, ctype = self.flight.do("api:" + ck, go)
        except UpstreamError as e:
            self.bump("upstream_errors")
            if row and now - row["fetched_at"] < self.cfg.stale_max:
                self.bump("api_stale")
                return row["status"], row["body"], row["ctype"], "stale"
            raise e
        if st >= 500 and row and now - row["fetched_at"] < self.cfg.stale_max:
            self.bump("upstream_errors")
            self.bump("api_stale")
            return row["status"], row["body"], row["ctype"], "stale"
        if st not in (200, 404):
            return st, body, ctype or "application/json", "miss"
        self.bump("api_miss")
        return st, body, ctype or "application/json", "miss"

    # ---- картинки

    def img_path(self, size: str, name: str) -> Path:
        return self.cfg.img_dir / size / name

    def get_image(self, size: str, name: str) -> tuple[Path, str, str]:
        """-> (файл, content-type, hit|miss). Бросает UpstreamError."""
        p = self.img_path(size, name)
        now = int(time.time())
        if p.is_file():
            self.store.conn().execute("UPDATE images SET hits=hits+1,last_hit=? WHERE key=?", (now, f"{size}/{name}"))
            self.bump("img_hit")
            row = self.store.conn().execute("SELECT ctype FROM images WHERE key=?", (f"{size}/{name}",)).fetchone()
            return p, (row["ctype"] if row and row["ctype"] else guess_ctype(name)), "hit"

        def go() -> str:
            st, data, ctype = http_get(f"{self.cfg.img_upstream}/t/p/{size}/{name}", self.cfg.upstream_timeout, self.cfg.max_download)
            if st != 200:
                raise UpstreamError(st, b"", "text/plain")
            ctype = (ctype or guess_ctype(name)).split(";")[0]
            if not ctype.startswith("image/"):
                raise UpstreamError(502, msg="upstream returned non-image")
            p.parent.mkdir(parents=True, exist_ok=True)
            fd, tmp = tempfile.mkstemp(dir=str(p.parent), prefix=".dl-")
            try:
                with os.fdopen(fd, "wb") as f:
                    f.write(data)
                os.replace(tmp, p)
            finally:
                if os.path.exists(tmp):
                    os.unlink(tmp)
            self.store.conn().execute(
                "INSERT INTO images(key,size,name,bytes,ctype,fetched_at,hits,last_hit) VALUES(?,?,?,?,?,?,0,?) "
                "ON CONFLICT(key) DO UPDATE SET bytes=excluded.bytes, ctype=excluded.ctype, fetched_at=excluded.fetched_at",
                (f"{size}/{name}", size, name, len(data), ctype, now, now),
            )
            self.writes += 1
            if self.writes % EVICT_EVERY == 0:
                self.evict_images()
            return ctype

        try:
            ctype = self.flight.do(f"img:{size}/{name}", go)
        except UpstreamError:
            self.bump("upstream_errors")
            raise
        self.bump("img_miss")
        return p, ctype, "miss"

    def evict_images(self) -> int:
        """Если кеш картинок перерос предел, удалить давно не запрашивавшиеся."""
        c = self.store.conn()
        total = c.execute("SELECT COALESCE(SUM(bytes),0) t FROM images").fetchone()["t"]
        if total <= self.cfg.img_max_total:
            return 0
        goal = int(self.cfg.img_max_total * 0.9)
        removed = 0
        for r in c.execute("SELECT key,size,name,bytes FROM images ORDER BY COALESCE(last_hit,0) ASC, hits ASC").fetchall():
            if total <= goal:
                break
            try:
                self.img_path(r["size"], r["name"]).unlink()
            except FileNotFoundError:
                pass
            c.execute("DELETE FROM images WHERE key=?", (r["key"],))
            total -= r["bytes"]
            removed += 1
        log.info(tr("кеш картинок: удалено %d файлов"), removed)
        return removed

    def evict_api(self) -> int:
        """Если кеш ответов TMDB перерос предел, удалить давно не запрашивавшиеся. Без этого любой вошедший пользователь мог бы
        забить диск разными запросами (каждый ответ, в том числе 404, кешируется)."""
        c = self.store.conn()
        total = c.execute("SELECT COALESCE(SUM(LENGTH(body)),0) t FROM api_cache").fetchone()["t"]
        if total <= self.cfg.api_max_total:
            return 0
        goal = int(self.cfg.api_max_total * 0.9)
        drop = []
        for r in c.execute("SELECT key, LENGTH(body) n FROM api_cache ORDER BY COALESCE(last_hit, fetched_at) ASC, hits ASC").fetchall():
            if total <= goal:
                break
            drop.append((r["key"],))
            total -= r["n"] or 0
        c.executemany("DELETE FROM api_cache WHERE key=?", drop)
        log.info(tr("кеш ответов TMDB: удалено %d записей"), len(drop))
        return len(drop)

    # ---- прогрев: собираем в кеш то, что понадобится плагину коллекций

    def collections(self) -> list[dict]:
        rows = self.store.conn().execute("SELECT * FROM collections ORDER BY position, id").fetchall()
        return [{"id": r["id"], "title": r["title"], "tmdb_collection": r["tmdb_collection"], "extras": json.loads(r["extras"])} for r in rows]

    def langs(self) -> list[str]:
        seen = self.store.seen_values("lang")
        return seen or list(self.cfg.warm_langs)

    def warm(self) -> dict:
        """Обойти коллекции: коллекция, фильмы, логотипы и картинки. Те же запросы, что делает плагин."""
        key = self.ensure_key()
        report = {"collections": 0, "movies": 0, "images": 0, "errors": 0, "skipped": None}
        if not key:
            report["skipped"] = tr("нет ключа TMDB")
            return report

        def api(path: str, params: list[tuple[str, str]]) -> dict | None:
            try:
                st, body, _, _ = self.get_api(path, params, None, force=False)
                return json.loads(body) if st == 200 else None
            except (UpstreamError, ValueError):
                report["errors"] += 1
                return None

        def image(size: str, file_path: str | None) -> None:
            if not file_path or not NAME_RE.match(file_path.lstrip("/")):
                return
            try:
                self.get_image(size, file_path.lstrip("/"))
                report["images"] += 1
            except UpstreamError:
                report["errors"] += 1

        for col in self.collections():
            for lang in self.langs():
                data = api(f"collection/{col['tmdb_collection']}", [("language", lang)])
                if not data:
                    continue
                report["collections"] += 1
                items = [("movie", p["id"]) for p in data.get("parts", [])] + [(e["type"], e["id"]) for e in col["extras"]]
                image_langs = ",".join(dict.fromkeys([lang, "en", "null"]))
                for kind, mid in items:
                    movie = api(f"{kind}/{mid}", [("language", lang)])
                    imgs = api(f"{kind}/{mid}/images", [("include_image_language", image_langs), ("language", lang)])
                    report["movies"] += 1
                    if movie:
                        for s in self.cfg.warm_poster_sizes:
                            image(s, movie.get("poster_path"))
                        for s in self.cfg.warm_backdrop_sizes:
                            image(s, movie.get("backdrop_path"))
                    if imgs:
                        logo = pick_logo(imgs.get("logos") or [], lang)
                        for s in self.cfg.warm_logo_sizes:
                            image(s, logo)
        self.evict_images()
        self.evict_api()
        self.last_warm = time.time()
        log.info(tr("прогрев: %s"), report)
        return report

    def health(self) -> dict:
        c = self.store.conn()
        img = c.execute("SELECT COUNT(*) n, COALESCE(SUM(bytes),0) b FROM images").fetchone()
        api = c.execute("SELECT COUNT(*) n, MIN(fetched_at) oldest, MAX(fetched_at) newest FROM api_cache").fetchone()
        with self.stats_lock:
            stats = dict(self.stats)
        return {
            "ok": True,
            "version": __version__,
            "key_known": bool(self.key()),
            "key_source": self.store.meta_get("tmdb_key_source"),
            "api_entries": api["n"], "api_oldest": api["oldest"], "api_newest": api["newest"],
            "images": img["n"], "images_bytes": img["b"],
            "collections": len(self.collections()),
            "last_warm": int(self.last_warm) if self.last_warm else None,
            "langs_seen": self.store.seen_values("lang"),
            "sizes_seen": self.store.seen_values("size"),
            "stats": stats,
        }


def guess_ctype(name: str) -> str:
    ext = name.rsplit(".", 1)[-1].lower()
    return {"jpg": "image/jpeg", "jpeg": "image/jpeg", "png": "image/png", "svg": "image/svg+xml", "webp": "image/webp"}.get(ext, "application/octet-stream")
