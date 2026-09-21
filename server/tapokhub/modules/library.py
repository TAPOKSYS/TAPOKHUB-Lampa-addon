"""Библиотека TapokHub: позиции, коллекции-франшизы, настройка, отслеживание нового.

Что хранится (SQLite, общая для всех устройств):
- library_items: отдельные фильмы и сериалы, добавленные кнопкой «В библиотеку»;
- franchises + franchise_items: коллекции-франшизы. Состав собирается из коллекции TMDB и из Wikidata
  (франшиза P8345 / серия P179 по идентификаторам TMDB): спин-оффы, сериалы, мультсериалы;
- lib_events: что нового (новая позиция, новый сезон), для уведомлений Lampa.

Группы внутри франшизы:
  collection:<id>  части коллекции TMDB (по названию коллекции)      films      другие фильмы
  upcoming         скоро                                             series     сериалы
  animation        мультсериалы                                      other      прочее (скрыто по умолчанию)

Порядок внутри группы: по дате выхода из TMDB. У TMDB нет собственного порядка частей коллекции: список
parts приходит в произвольном порядке (у «Звёздных войн» 2019 стоит перед 2017), остаётся дата.

Пользовательские правки (скрыть, вернуть, добавить вручную) при пересборке не теряются.
"""

from __future__ import annotations

import json
import logging
import queue
import re
import threading
import time
import urllib.parse
from concurrent.futures import ThreadPoolExecutor
from datetime import date
from typing import Any

from tapokhub.core.common import DAY, UpstreamError
from tapokhub.libraries.tmdb_logos import pick_logo
from tapokhub.libraries.wikidata import WikidataClient, WikidataError
from tapokhub.core.i18n import default_lang, tr

log = logging.getLogger("tapokhub.library")

# «Серия» Wikidata (P179) бывает не франшизой, а каталогом студии («фильмы студии Walt Disney Animation Studios», 90+
# фильмов): от «101 далматинца» пришли бы все мультфильмы Диснея. Такой кандидат отбрасываем, если его нашли сами
# (не выбрал пользователь): участников больше CATALOGUE_MIN, и это не «медиафраншиза»/«кинофраншиза».
CATALOGUE_MIN = 30
FRANCHISE_CLASSES = {"Q196600", "Q130371093", "Q1667921"}     # медиафраншиза, кинофраншиза, серия романов
CATALOGUE_LABEL = re.compile(r"фильмы студии|мультфильмы студии|films (?:by|of|from) |filmography|filmografi|список|list of", re.I)

QID_RE = re.compile(r"^Q\d{1,12}$")
WD_PROPS = ("P8345", "P179")          # франшиза, серия: только эти связи Wikidata

NEW_DAYS = 14                 # сколько дней позиция помечается NEW

MOVIE_MIN_RUNTIME = 60        # короче: короткометражки, аттракционы, эпизоды-спецвыпуски -> «Прочее»
MOVIE_MIN_VOTES = 50
# Контент для взрослых («клубничка») в коллекции не попадает: скрывается автоматически (вернуть можно вручную в режиме «Настроить»).
# Признак TMDB adult (порно) и ключевые слова эротики: erotic movie, softcore, sexploitation, erotica. Широкие вроде «nudity»
# не берём: они есть у обычных фильмов.
ADULT_KEYWORDS = frozenset({190370, 155477, 10053, 325693})
# Группы библиотеки («Мои фильмы»...). Аниме и манга: ключевые слова anime, manga, based on manga (в том числе игровые экранизации),
# либо японская анимация. Остальная анимация — мультфильмы и мультсериалы. Жанр 16 — анимация, 99 — документальное.
ANIME_KEYWORDS = frozenset({210024, 295446, 13141})
GENRE_ANIMATION, GENRE_DOCUMENTARY = 16, 99
TV_MIN_VOTES = 100            # у мелочи (LEGO, шорты, фанатские) голосов меньше
UPCOMING_STATUSES = {"In Production", "Post Production", "Planned", "Rumored"}

GROUP_TITLES = {"films": "Другие фильмы", "upcoming": "Скоро", "series": "Сериалы", "animation": "Мультсериалы", "other": "Прочее"}
GROUP_ORDER = {"films": 1, "upcoming": 2, "series": 3, "animation": 4, "other": 9}

LIB_SCHEMA = """
CREATE TABLE IF NOT EXISTS library_items(
    user_id INTEGER NOT NULL DEFAULT 1, kind TEXT NOT NULL, tmdb_id INTEGER NOT NULL, added_at INTEGER NOT NULL,
    PRIMARY KEY(user_id, kind, tmdb_id)
);
CREATE TABLE IF NOT EXISTS franchises(
    id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT NOT NULL, wikidata_id TEXT, wd_prop TEXT,
    root_kind TEXT NOT NULL, root_id INTEGER NOT NULL, status TEXT NOT NULL, busy INTEGER NOT NULL DEFAULT 0,
    error TEXT, choices TEXT, created_at INTEGER NOT NULL, resolved_at INTEGER, merged_into INTEGER,
    logo TEXT, logo_checked INTEGER, user_id INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE IF NOT EXISTS franchise_items(
    franchise_id INTEGER NOT NULL, kind TEXT NOT NULL, tmdb_id INTEGER NOT NULL,
    grp TEXT NOT NULL, grp_title TEXT NOT NULL, title TEXT, date TEXT, source TEXT NOT NULL,
    hidden INTEGER NOT NULL DEFAULT 0, hidden_by TEXT, first_seen INTEGER NOT NULL, new_until INTEGER,
    seasons INTEGER, card TEXT NOT NULL,
    PRIMARY KEY(franchise_id, kind, tmdb_id)
);
CREATE INDEX IF NOT EXISTS franchise_items_member ON franchise_items(kind, tmdb_id);
CREATE TABLE IF NOT EXISTS torrent_choices(
    user_id INTEGER NOT NULL, kind TEXT NOT NULL, tmdb_id INTEGER NOT NULL, title TEXT, magnet TEXT, link TEXT,
    poster TEXT, tracker TEXT, at INTEGER NOT NULL, PRIMARY KEY(user_id, kind, tmdb_id)
);
CREATE TABLE IF NOT EXISTS user_settings(
    user_id INTEGER NOT NULL, key TEXT NOT NULL, value TEXT NOT NULL, at INTEGER NOT NULL, PRIMARY KEY(user_id, key)
);
CREATE TABLE IF NOT EXISTS lib_events(
    id INTEGER PRIMARY KEY AUTOINCREMENT, franchise_id INTEGER NOT NULL, kind TEXT, tmdb_id INTEGER,
    type TEXT NOT NULL, title TEXT, created_at INTEGER NOT NULL, seen INTEGER NOT NULL DEFAULT 0
);
"""


class Fail(Exception):
    """Понятная пользователю причина, по которой франшизу собрать не удалось."""


def clean_collection_name(name: str) -> str:
    # «Сага (Коллекция)», «Saga Collection», «101 далматинец (Коллекция мультфильмов)»
    return re.sub(r"\s*\((?:Коллекция|Collection)[^)]*\)\s*$|\s+Collection$", "", name or "", flags=re.I).strip()


def norm_title(s: str) -> str:
    return re.sub(r"[^\w]+", " ", (s or "").casefold().replace("ё", "е")).strip()


def normalize(kind: str, d: dict) -> dict:
    """Ответ TMDB -> плоская запись с тем, что нужно для разбивки и показа."""
    movie = kind == "movie"
    date_ = (d.get("release_date") if movie else d.get("first_air_date")) or ""
    kw = d.get("keywords") or {}          # append_to_response=keywords: у фильмов {"keywords": [...]}, у сериалов {"results": [...]}
    keywords = [k.get("id") for k in (kw.get("keywords") or kw.get("results") or []) if isinstance(k, dict)]
    runtime = d.get("runtime") if movie else next(iter(d.get("episode_run_time") or []), None)
    bc = d.get("belongs_to_collection") or {}
    return {
        "kind": kind, "id": d["id"],
        "title": (d.get("title") if movie else d.get("name")) or "",
        "original": (d.get("original_title") if movie else d.get("original_name")) or "",
        "date": date_[:10], "runtime": runtime, "votes": d.get("vote_count") or 0, "rating": d.get("vote_average") or 0,
        "animation": any(g.get("id") == 16 for g in d.get("genres") or []),
        "genres": [g.get("id") for g in d.get("genres") or []], "lang": d.get("original_language") or "", "keywords": keywords,
        "status": d.get("status") or "", "collection_id": bc.get("id"), "collection_name": bc.get("name"),
        "poster": d.get("poster_path"), "backdrop": d.get("backdrop_path"),
        "overview": (d.get("overview") or "")[:300], "seasons": d.get("number_of_seasons"),
        "adult": bool(d.get("adult")) or bool(ADULT_KEYWORDS.intersection(keywords)),
    }


def library_group(n: dict) -> str:
    """Группа позиции в «Библиотеке»: movie, tv, cartoon_movie, cartoon_tv, anime, docs."""
    genres = n.get("genres") or ()
    animation = GENRE_ANIMATION in genres
    if ANIME_KEYWORDS.intersection(n.get("keywords") or ()) or (animation and n.get("lang") == "ja"):
        return "anime"
    if animation:
        return "cartoon_movie" if n["kind"] == "movie" else "cartoon_tv"
    if GENRE_DOCUMENTARY in genres:
        return "docs"
    return n["kind"]


def card_of(n: dict) -> dict:
    """Карточка в том виде, в каком её понимает Lampa (как ответ TMDB)."""
    c = {"id": n["id"], "media_type": n["kind"], "poster_path": n["poster"], "backdrop_path": n["backdrop"],
         "vote_average": n["rating"], "overview": n["overview"]}
    if n["kind"] == "movie":
        c.update(title=n["title"], original_title=n["original"], release_date=n["date"])
    else:
        c.update(name=n["title"], original_name=n["original"], first_air_date=n["date"])
    return c


class Library:
    def __init__(self, proxy, wd: WikidataClient | None = None, today=None, workers: int = 6):
        self.proxy = proxy
        self.store = proxy.store
        c = self.store.conn()
        old_items = c.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name='library_items'").fetchone() and \
            "user_id" not in {r["name"] for r in c.execute("PRAGMA table_info(library_items)")}
        if old_items:      # база до появления пользователей: всё, что накоплено, принадлежит владельцу (1)
            c.execute("ALTER TABLE library_items RENAME TO library_items_old")
        c.executescript(LIB_SCHEMA)
        if old_items:
            c.execute("INSERT INTO library_items(user_id,kind,tmdb_id,added_at) SELECT 1,kind,tmdb_id,added_at FROM library_items_old")
            c.execute("DROP TABLE library_items_old")
        have = {r["name"] for r in c.execute("PRAGMA table_info(franchises)")}
        for col, typ in (("logo", "TEXT"), ("logo_checked", "INTEGER"), ("user_id", "INTEGER NOT NULL DEFAULT 1")):     # базы старых версий
            if col not in have:
                c.execute(f"ALTER TABLE franchises ADD COLUMN {col} {typ}")
        cfg = proxy.cfg
        self.wd = wd or WikidataClient(cfg.wikidata_api, self.store.conn, min_interval=cfg.wd_min_interval, backoff=cfg.wd_backoff,
                                                  label_langs=tuple(dict.fromkeys((*cfg.warm_langs, "en"))))
        self.today = today or (lambda: date.today().isoformat())
        self.workers = workers
        self.jobs: queue.Queue = queue.Queue()
        self.thread: threading.Thread | None = None
        self.lock = threading.Lock()

    # ------------------------------------------------------------------ TMDB

    def lang(self) -> str:
        return (self.proxy.langs() or [default_lang()])[0]

    def tmdb(self, path: str, extra: list | None = None) -> dict | None:
        params = [("language", self.lang())] + (extra or [])
        if not self.proxy.key():
            self.proxy.ensure_key()        # ключа ещё нет (сервис только что запущен): взять у Lampa
        try:
            st, body, _, _ = self.proxy.get_api(path, params, None)
            return json.loads(body) if st == 200 else None
        except (UpstreamError, ValueError):
            return None

    def details(self, kind: str, tid: int) -> dict | None:
        d = self.tmdb(f"{kind}/{tid}", [("append_to_response", "keywords")])
        return normalize(kind, d) if d and "id" in d else None

    def details_many(self, keys: list) -> dict:
        if not keys:
            return {}
        with ThreadPoolExecutor(max_workers=self.workers) as pool:
            res = list(pool.map(lambda k: self.store.run_and_close(self.details, k[0], k[1]), keys))
        return {k: d for k, d in zip(keys, res) if d}

    # ------------------------------------------------------------------ разбивка на группы

    @staticmethod
    def passes(n: dict) -> bool:
        """Достаточно ли фильм «настоящий»: длиннее короткометражки и есть голоса."""
        return (n["runtime"] or 0) >= MOVIE_MIN_RUNTIME and n["votes"] >= MOVIE_MIN_VOTES

    def classify(self, n: dict, coll: tuple | None) -> tuple[str, str, bool]:
        """-> (группа, заголовок группы, скрыть автоматически)."""
        if n.get("adult"):
            return "other", GROUP_TITLES["other"], True
        if coll:
            return f"collection:{coll[0]}", coll[1], False
        today = self.today()
        date_ = n["date"]
        if (date_ and date_ > today) or (n["status"] in UPCOMING_STATUSES and not (date_ and date_ <= today)):
            return "upcoming", GROUP_TITLES["upcoming"], False
        if n["kind"] == "movie":
            if (n["runtime"] or 0) < MOVIE_MIN_RUNTIME or n["votes"] < MOVIE_MIN_VOTES:
                return "other", GROUP_TITLES["other"], True
            return "films", GROUP_TITLES["films"], False
        if n["votes"] < TV_MIN_VOTES:
            return "other", GROUP_TITLES["other"], True
        return ("animation", GROUP_TITLES["animation"], False) if n["animation"] else ("series", GROUP_TITLES["series"], False)

    # ------------------------------------------------------------------ данные

    def row(self, sql: str, *args):
        return self.store.conn().execute(sql, args).fetchone()

    def rows(self, sql: str, *args):
        return self.store.conn().execute(sql, args).fetchall()

    def franchise(self, fid: int):
        return self.row("SELECT * FROM franchises WHERE id=?", fid)

    def find_by_member(self, kind: str, tid: int, user: int = 1):
        return self.row(
            "SELECT f.* FROM franchise_items i JOIN franchises f ON f.id = i.franchise_id "
            "WHERE i.kind=? AND i.tmdb_id=? AND f.user_id=? AND f.merged_into IS NULL AND f.status IN ('ready','pending','resolving') ORDER BY f.id LIMIT 1",
            kind, tid, user)

    def _set(self, fid: int, **kw) -> None:
        cols = ", ".join(f"{k}=?" for k in kw)
        self.store.conn().execute(f"UPDATE franchises SET {cols} WHERE id=?", (*kw.values(), fid))

    def event(self, fid: int, kind: str | None, tid: int | None, type_: str, title: str | None) -> None:
        self.store.conn().execute(
            "INSERT INTO lib_events(franchise_id,kind,tmdb_id,type,title,created_at) VALUES(?,?,?,?,?,?)",
            (fid, kind, tid, type_, title, int(time.time())))

    # ------------------------------------------------------------------ создание и очередь

    def create(self, kind: str, tid: int, wikidata: str | None = None, prop: str = "P8345", user: int = 1) -> dict:
        """Создать франшизу от позиции. Если такая уже есть, вернуть её. Сборка идёт в фоне."""
        with self.lock:
            f = self.find_by_member(kind, tid, user)
            if f:
                return dict(f)
            f = self.row("SELECT * FROM franchises WHERE user_id=? AND root_kind=? AND root_id=? AND merged_into IS NULL AND status IN ('pending','resolving','needs_choice','error') ORDER BY id DESC LIMIT 1", user, kind, tid)
            if f:
                if wikidata:                       # выбор из предложенных вариантов
                    self._set(f["id"], wikidata_id=wikidata, wd_prop=prop, status="pending", error=None, choices=None)
                    self.enqueue(f["id"])
                elif f["status"] == "error":       # повторная попытка после ошибки
                    self._set(f["id"], status="pending", error=None)
                    self.enqueue(f["id"])
                return dict(self.franchise(f["id"]))
            cur = self.store.conn().execute(
                "INSERT INTO franchises(title,wikidata_id,wd_prop,root_kind,root_id,status,created_at,user_id) VALUES(?,?,?,?,?,'pending',?,?)",
                ("…", wikidata, prop if wikidata else None, kind, tid, int(time.time()), user))
            fid = cur.lastrowid
            self.enqueue(fid)
            return dict(self.franchise(fid))

    def enqueue(self, fid: int) -> None:
        self._set(fid, busy=1)
        self.jobs.put(fid)

    def start(self) -> None:
        """Фоновый поток сборки (один: Wikidata просит не частить). Незавершённое после перезапуска ставится в очередь."""
        if self.thread and self.thread.is_alive():
            return
        for r in self.rows("SELECT id FROM franchises WHERE status IN ('pending','resolving') AND merged_into IS NULL"):
            self.jobs.put(r["id"])
        self.thread = threading.Thread(target=self._loop, daemon=True, name="library-worker")
        self.thread.start()

    def stop(self) -> None:
        """Завершить очередь и закрыть соединение worker до удаления базы/выхода."""
        if self.thread and self.thread.is_alive():
            self.jobs.put(None)
            self.thread.join()
        self.thread = None

    def _loop(self) -> None:
        try:
            while True:
                job = self.jobs.get()
                try:
                    if job is None:
                        return
                    if isinstance(job, tuple):
                        try:
                            self.absorb_related(*job[1:])
                        except Exception:
                            log.exception(tr("добавление связанного %s не удалось"), job)
                    else:
                        self.build_safe(job)
                finally:
                    self.jobs.task_done()
        finally:
            self.store.close()

    def wait_idle(self, timeout: float = 30.0) -> bool:
        """Дождаться пустой очереди (для тестов и CLI)."""
        end = time.time() + timeout
        while time.time() < end:
            if self.jobs.unfinished_tasks == 0:
                return True
            time.sleep(0.02)
        return False

    def refresh_all(self, min_age: int = 20 * 3600) -> int:
        """Ежедневное отслеживание: пересобрать франшизы, которые давно не обновлялись."""
        n = 0
        for r in self.rows("SELECT id FROM franchises WHERE status='ready' AND merged_into IS NULL AND busy=0 AND COALESCE(resolved_at,0) < ?", int(time.time()) - min_age):
            self.enqueue(r["id"])
            n += 1
        return n

    def build_safe(self, fid: int) -> None:
        f = self.franchise(fid)
        if not f or f["merged_into"]:
            return
        try:
            self.build(fid)
        except (Fail, WikidataError) as e:
            msg = str(e)
        except Exception as e:  # noqa: BLE001
            log.exception(tr("сборка франшизы %s упала"), fid)
            msg = tr("внутренняя ошибка: {name}", name=e.__class__.__name__)
        else:
            return
        if f["resolved_at"]:      # уже была собрана: данные остаются, ошибка только запоминается
            self._set(fid, error=msg, busy=0)
        else:
            self._set(fid, status="error", error=msg, busy=0)

    # ------------------------------------------------------------------ сборка

    def build(self, fid: int) -> None:
        f = self.franchise(fid)
        first_time = f["resolved_at"] is None
        self._set(fid, status="resolving" if first_time else f["status"], error=None)
        self.proxy.ensure_key()

        root = self.details(f["root_kind"], f["root_id"])
        if not root:
            raise Fail(tr("TMDB не отдаёт данные по этой позиции"))

        fr_qid, prop = f["wikidata_id"], f["wd_prop"] or "P8345"
        root_qid = None
        if not fr_qid:
            ext = self.tmdb(f"{f['root_kind']}/{f['root_id']}/external_ids") or {}
            root_qid = ext.get("wikidata_id")
            if root_qid:
                ent = self.wd.entities([root_qid]).get(root_qid)
                claims = (ent or {}).get("claims", {})
                cands = [(q, "P8345") for q in claims.get("P8345", [])] or [(q, "P179") for q in claims.get("P179", [])]
                if len(cands) > 1:
                    names = self.wd.entities([q for q, _ in cands])
                    choices = [{"wikidata": q, "prop": p, "title": names.get(q, {}).get("label", q)} for q, p in cands]
                    self._set(fid, status="needs_choice", choices=json.dumps(choices, ensure_ascii=False), busy=0, title=root["title"])
                    return
                if cands:
                    fr_qid, prop = cands[0]

        members: list[dict] = []
        fr_label = None
        if fr_qid:
            members = self.wd.members(fr_qid, prop)
            if not members and prop == "P8345":      # выбранный вариант мог быть «серией»
                members = self.wd.members(fr_qid, "P179")
            ent = self.wd.entities([fr_qid]).get(fr_qid, {})
            fr_label = ent.get("label")
            if not f["wikidata_id"] and self.is_catalogue(fr_label, ent.get("claims", {}), prop, len(members)):
                log.info(tr("франшиза %s: %r похожа на каталог студии (%s участников), берём только коллекцию TMDB"), fid, fr_label, len(members))
                members, fr_qid, prop, fr_label = [], None, None, None

        # Общей франшизы в Wikidata нет (или это каталог студии): собираем по цепочкам связей между произведениями
        if not fr_qid and root_qid:
            members = self.wd.related(root_qid)

        # ---- состав: корень, участники Wikidata, коллекции TMDB
        want: dict[tuple, set] = {(root["kind"], root["id"]): {"wikidata"}}
        for m in members:
            want.setdefault((m["kind"], m["id"]), set()).add("wikidata")
        details = self.details_many(list(want))
        if (root["kind"], root["id"]) not in details:
            details[(root["kind"], root["id"])] = root

        # Коллекции TMDB. Им доверяем не всегда: у члена франшизы бывает своя коллекция-мусор
        # (пять LEGO-шортов, пародии «Гриффинов»). Доверенная коллекция: та, в которой корень, либо та, где
        # хотя бы 3/4 частей проходят пороги и есть участник Wikidata. Части недоверенных коллекций сверх
        # того, что назвала Wikidata, не подтягиваем, а сами участники классифицируются по общим правилам.
        collections: dict[int, dict] = {}
        for cid in {d["collection_id"] for d in details.values() if d["collection_id"]}:
            col = self.tmdb(f"collection/{cid}")
            if col and col.get("parts"):
                collections[cid] = {"name": clean_collection_name(col.get("name") or ""), "ids": [p["id"] for p in col["parts"]]}
        details.update(self.details_many([("movie", pid) for info in collections.values() for pid in info["ids"] if ("movie", pid) not in details]))
        tagged = {(m["kind"], m["id"]) for m in members}
        in_collection: dict[int, tuple] = {}
        for cid, info in collections.items():
            parts = [details.get(("movie", pid)) for pid in info["ids"]]
            passing = sum(1 for d in parts if d and self.passes(d))
            has_tagged = any(("movie", pid) in tagged for pid in info["ids"])
            trusted = root["collection_id"] == cid or (bool(info["ids"]) and passing / len(info["ids"]) >= 0.75 and has_tagged)
            if not trusted:
                continue
            for pid in info["ids"]:
                in_collection[pid] = (cid, info["name"])
                want.setdefault(("movie", pid), set()).add("tmdb_collection")

        if not details:
            raise Fail(tr("нет данных для сборки"))

        entries = self._entries(want, details, in_collection, root_key=(root["kind"], root["id"]))
        title = fr_label or (next(iter(collections.values()))["name"] if len(collections) == 1 else None) or root["title"]

        # ---- если такая франшиза уже есть (собрана от другой позиции), сливаем
        if fr_qid:
            other = self.row("SELECT id FROM franchises WHERE user_id=? AND wikidata_id=? AND id<>? AND merged_into IS NULL AND status='ready' ORDER BY id LIMIT 1", f["user_id"], fr_qid, fid)
            if other:
                self._set(fid, status="merged", merged_into=other["id"], busy=0, wikidata_id=fr_qid)
                self.store.conn().execute("DELETE FROM franchise_items WHERE franchise_id=?", (fid,))
                # позиция, от которой пришли, тоже должна оказаться в найденной франшизе
                self.add_item(other["id"], root["kind"], root["id"], manual=False, details=root)
                return

        self._persist(fid, f, entries, title, fr_qid, prop)

    @staticmethod
    def is_catalogue(label, claims: dict, prop: str, members: int) -> bool:
        """Кандидат Wikidata — каталог (студия, фильмография), а не франшиза."""
        if FRANCHISE_CLASSES & set(claims.get("P31", [])):
            return False
        if members > CATALOGUE_MIN and prop == "P179":
            return True
        return members > CATALOGUE_MIN // 2 and bool(CATALOGUE_LABEL.search(label or ""))

    def _entries(self, want: dict, details: dict, in_collection: dict, root_key: tuple | None = None) -> list[dict]:
        """Классификация, дубли, итоговые записи."""
        items = []
        for key, srcs in want.items():
            n = details.get(key)
            if not n:
                continue          # TMDB про неё ничего не знает (Wikidata бывает устаревшей)
            coll = in_collection.get(n["id"]) if n["kind"] == "movie" else None
            grp, gtitle, auto = self.classify(n, coll)
            if auto and key == root_key and not n.get("adult"):      # позицию, от которой создали коллекцию, автоматика не прячет (кроме контента для взрослых)
                grp, gtitle = ("films", GROUP_TITLES["films"]) if n["kind"] == "movie" else (("animation", GROUP_TITLES["animation"]) if n["animation"] else ("series", GROUP_TITLES["series"]))
                auto = False
            items.append({"n": n, "grp": grp, "gtitle": gtitle, "auto": auto, "source": "tmdb_collection" if coll else "wikidata"})

        # дубли TMDB (одинаковые вид, название, год): оставляем с наибольшим числом голосов; части коллекций не трогаем
        best: dict[tuple, dict] = {}
        for it in items:
            if it["grp"].startswith("collection:"):
                continue
            k = (it["n"]["kind"], norm_title(it["n"]["title"]), it["n"]["date"][:4])
            if k not in best or it["n"]["votes"] > best[k]["n"]["votes"]:
                best[k] = it
        keep = {id(v) for v in best.values()}
        return [it for it in items if it["grp"].startswith("collection:") or id(it) in keep]

    def _persist(self, fid: int, f, entries: list[dict], title: str, fr_qid: str | None, prop: str | None) -> None:
        c = self.store.conn()
        now = int(time.time())
        first_time = f["resolved_at"] is None
        has_collections = any(e["grp"].startswith("collection:") for e in entries)
        existing = {(r["kind"], r["tmdb_id"]): r for r in self.rows("SELECT * FROM franchise_items WHERE franchise_id=?", fid)}
        c.execute("BEGIN IMMEDIATE")
        try:
            for e in entries:
                n = e["n"]
                key = (n["kind"], n["id"])
                gtitle = "Фильмы" if e["grp"] == "films" and not has_collections else e["gtitle"]
                card = json.dumps(card_of(n), ensure_ascii=False)
                row = existing.get(key)
                if row is None:
                    new = (not first_time) and not e["auto"] and e["grp"] != "other"
                    c.execute(
                        "INSERT INTO franchise_items(franchise_id,kind,tmdb_id,grp,grp_title,title,date,source,hidden,hidden_by,first_seen,new_until,seasons,card) "
                        "VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
                        (fid, n["kind"], n["id"], e["grp"], gtitle, n["title"], n["date"], e["source"], 1 if e["auto"] else 0,
                         "auto" if e["auto"] else None, now, now + NEW_DAYS * DAY if new else None, n["seasons"], card))
                    if new:
                        self.event(fid, n["kind"], n["id"], "new_item", n["title"])
                    continue
                hidden, hidden_by = row["hidden"], row["hidden_by"]
                if hidden_by != "user":               # выбор пользователя сильнее автоматики
                    hidden, hidden_by = (1, "auto") if e["auto"] else (0, None)
                new_until, seasons = row["new_until"], row["seasons"]
                if n["kind"] == "tv" and n["seasons"]:
                    if seasons is not None and n["seasons"] > seasons and not hidden:
                        new_until = now + NEW_DAYS * DAY
                        self.event(fid, "tv", n["id"], "new_season", f"{n['title']}: сезон {n['seasons']}")
                    seasons = max(seasons or 0, n["seasons"])
                c.execute(
                    "UPDATE franchise_items SET grp=?,grp_title=?,title=?,date=?,hidden=?,hidden_by=?,new_until=?,seasons=?,card=?,"
                    "source=CASE WHEN source='manual' THEN 'manual' ELSE ? END WHERE franchise_id=? AND kind=? AND tmdb_id=?",
                    (row["grp"] if row["source"] == "manual" else e["grp"], row["grp_title"] if row["source"] == "manual" else gtitle,
                     n["title"], n["date"], hidden, hidden_by, new_until, seasons, card, e["source"], fid, n["kind"], n["id"]))
            c.execute("UPDATE franchises SET title=?, wikidata_id=?, wd_prop=?, status='ready', busy=0, error=NULL, choices=NULL, resolved_at=? WHERE id=?",
                      (title, fr_qid, prop if fr_qid else None, now, fid))
            c.execute("COMMIT")
        except Exception:
            c.execute("ROLLBACK")
            raise
        if first_time:
            self.event(fid, None, None, "created", title)
        self.ensure_logo(fid)

    LOGO_RECHECK = 7 * DAY

    IDENTITY_STOP = frozenset({"сери", "филь", "колл", "фран", "кине", "всел", "the", "and", "seri", "film", "coll", "fran", "cine", "univ"})

    @classmethod
    def _stems(cls, text: str) -> set:
        """Основы слов (первые 4 буквы), без служебных: «серия фильмов о Человеке-пауке» ~ «Человек-паук»."""
        return {w[:4] for w in norm_title(text).split() if len(w) >= 3} - cls.IDENTITY_STOP

    def _identity(self, fid: int) -> tuple[list, bool]:
        """Позиции, по которым берём логотип и обложку франшизы -> (строки, составная ли она).

        Обычно это самые ранние части основной коллекции. Но у составной вселенной (Marvel: Железный человек, Тор, Мстители...)
        первая часть одной из коллекций не «лицо» всей франшизы: чужой логотип подписал бы вселенную названием фильма.
        Составной считается франшиза с несколькими коллекциями TMDB, если название ни одной позиции не связано с названием франшизы;
        для неё логотипа нет (остаётся текст названия), обложка берётся у лучшего по рейтингу."""
        f = self.franchise(fid)
        rows = self.rows(
            "SELECT kind, tmdb_id, grp, grp_title, title, card FROM franchise_items WHERE franchise_id=? AND hidden=0 "
            "ORDER BY (grp LIKE 'collection:%') DESC, (date IS NULL OR date='') ASC, date ASC", fid)
        if len({r["grp"] for r in rows if r["grp"].startswith("collection:")}) <= 1:
            return rows[:6], False
        mine = self._stems(f["title"] if f else "")
        own = [r for r in rows if mine & (self._stems(r["grp_title"]) | self._stems(r["title"]))]
        return (own[:6], False) if own else ([], True)

    def ensure_logo(self, fid: int, force: bool = False) -> None:
        """Логотип франшизы вместо текстового названия: TMDB-логотип первой подходящей позиции (сначала основная
        коллекция, по дате). Ищем не чаще раза в неделю; не нашли: остаётся текст. Ошибки сети не критичны."""
        f = self.franchise(fid)
        if not f or (f["logo_checked"] and not force and time.time() - f["logo_checked"] < self.LOGO_RECHECK and f["logo"]):
            return
        try:
            rows, _ = self._identity(fid)
            lang = self.lang()
            langs = ",".join(dict.fromkeys([lang, "en", "null"]))
            found = None
            for r in rows:
                d = self.tmdb(f"{r['kind']}/{r['tmdb_id']}/images", [("include_image_language", langs)])
                found = pick_logo((d or {}).get("logos") or [], lang) if d else None
                if found:
                    break
            self._set(fid, logo=found, logo_checked=int(time.time()))
        except Exception:  # noqa: BLE001
            log.exception(tr("логотип франшизы %s не определён"), fid)

    # ------------------------------------------------------------------ правки пользователя

    def add_item(self, fid: int, kind: str, tid: int, manual: bool = True, details: dict | None = None) -> bool:
        n = details or self.details(kind, tid)
        if not n:
            return False
        groups = {r["grp"]: r["grp_title"] for r in self.rows("SELECT DISTINCT grp, grp_title FROM franchise_items WHERE franchise_id=? AND grp LIKE 'collection:%'", fid)}
        coll = None
        if n["kind"] == "movie" and n["collection_id"] and f"collection:{n['collection_id']}" in groups:
            coll = (n["collection_id"], groups[f"collection:{n['collection_id']}"])
        grp, gtitle, _ = self.classify(n, coll)
        adult = bool(n.get("adult")) and not manual      # автоматически контент для взрослых не добавляем видимым; выбор руками сильнее
        if grp == "other" and not adult:                # добавили руками — значит нужно, в «Прочее» не прячем
            grp, gtitle = ("films", GROUP_TITLES["films"]) if n["kind"] == "movie" else (("animation", GROUP_TITLES["animation"]) if n["animation"] else ("series", GROUP_TITLES["series"]))
        now = int(time.time())
        values = (fid, n["kind"], n["id"], grp, gtitle, n["title"], n["date"], "manual" if manual else "wikidata", 1 if adult else 0,
                  "user" if manual else ("auto" if adult else None), now, n["seasons"], json.dumps(card_of(n), ensure_ascii=False))
        insert = ("INSERT INTO franchise_items(franchise_id,kind,tmdb_id,grp,grp_title,title,date,source,hidden,hidden_by,first_seen,new_until,seasons,card) "
                  "VALUES(?,?,?,?,?,?,?,?,?,?,?,NULL,?,?)")
        if manual:   # добавили руками: вернуть, если было скрыто, и закрепить выбор пользователя
            self.store.conn().execute(insert + " ON CONFLICT(franchise_id,kind,tmdb_id) DO UPDATE SET hidden=0, hidden_by='user'", values)
        else:        # автоматически: существующую запись не трогаем
            self.store.conn().execute(insert + " ON CONFLICT(franchise_id,kind,tmdb_id) DO NOTHING", values)
        return True

    # ---- добавление сразу нескольких позиций: коллекция TMDB или всё связанное

    def add_options(self, fid: int, kind: str, tid: int) -> dict | None:
        """Что можно добавить вместе с позицией: только её, её коллекцию TMDB, всё связанное (франшиза)."""
        n = self.details(kind, tid)
        if not n:
            return None
        out = {"title": n["title"], "kind": n["kind"], "id": n["id"], "collection": None}
        if n["kind"] == "movie" and n["collection_id"]:
            col = self.tmdb(f"collection/{n['collection_id']}")
            if col and col.get("parts"):
                out["collection"] = {"id": n["collection_id"], "name": clean_collection_name(col.get("name") or ""), "count": len(col["parts"])}
        return out

    def _insert_new(self, fid: int, entries: list[dict], root_key: tuple | None) -> int:
        """Вставить записи, которых в коллекции ещё нет; существующие (и выбор пользователя по ним) не трогаем."""
        now = int(time.time())
        added = 0
        for e in entries:
            n = e["n"]
            key = (n["kind"], n["id"])
            hidden = 1 if e["auto"] and key != root_key else 0
            cur = self.store.conn().execute(
                "INSERT INTO franchise_items(franchise_id,kind,tmdb_id,grp,grp_title,title,date,source,hidden,hidden_by,first_seen,new_until,seasons,card) "
                "VALUES(?,?,?,?,?,?,?,?,?,?,?,NULL,?,?) ON CONFLICT(franchise_id,kind,tmdb_id) DO NOTHING",
                (fid, n["kind"], n["id"], e["grp"], e["gtitle"], n["title"], n["date"], "manual" if key == root_key else e["source"],
                 hidden, "auto" if hidden else None, now, n["seasons"], json.dumps(card_of(n), ensure_ascii=False)))
            added += cur.rowcount
        return added

    def add_scope(self, fid: int, kind: str, tid: int, scope: str) -> bool:
        """scope: 'item' (только позиция), 'collection' (вся коллекция TMDB), 'related' (связанное: ставится в очередь)."""
        n = self.details(kind, tid)
        if not n:
            return False
        if scope == "related":
            self._set(fid, busy=1)
            self.jobs.put(("absorb", fid, n["kind"], n["id"]))
            return self.add_item(fid, n["kind"], n["id"], details=n)     # сама позиция сразу, остальное подтянется
        if scope != "collection":
            return self.add_item(fid, n["kind"], n["id"], details=n)
        col = self.tmdb(f"collection/{n['collection_id']}") if n["kind"] == "movie" and n["collection_id"] else None
        if not col or not col.get("parts"):
            return self.add_item(fid, n["kind"], n["id"], details=n)     # коллекции у неё нет: только сама
        name = clean_collection_name(col.get("name") or "")
        ids = [p["id"] for p in col["parts"]]
        want = {("movie", pid): {"tmdb_collection"} for pid in ids}
        want[(n["kind"], n["id"])] = {"manual"}
        details = self.details_many(list(want))
        details.setdefault((n["kind"], n["id"]), n)
        entries = self._entries(want, details, {pid: (n["collection_id"], name) for pid in ids}, root_key=(n["kind"], n["id"]))
        self._insert_new(fid, entries, (n["kind"], n["id"]))         # сначала группа коллекции...
        self.add_item(fid, n["kind"], n["id"], details=n)            # ...потом выбранную позицию вернуть, если была скрыта
        return True

    def absorb_related(self, fid: int, kind: str, tid: int) -> None:
        """Всё, что Wikidata связывает с позицией (франшиза, а без неё цепочки продолжений и ремейков), в коллекцию fid."""
        try:
            n = self.details(kind, tid)
            if not n:
                return
            ext = self.tmdb(f"{kind}/{tid}/external_ids") or {}
            qid = ext.get("wikidata_id")
            members: list[dict] = []
            if qid:
                claims = (self.wd.entities([qid]).get(qid) or {}).get("claims", {})
                cands = [(q, "P8345") for q in claims.get("P8345", [])] or [(q, "P179") for q in claims.get("P179", [])]
                if cands:
                    fq, prop = cands[0]
                    members = self.wd.members(fq, prop)
                    ent = self.wd.entities([fq]).get(fq, {})
                    if self.is_catalogue(ent.get("label"), ent.get("claims", {}), prop, len(members)):
                        members = []
                if not members:
                    members = self.wd.related(qid)
            want = {(n["kind"], n["id"]): {"manual"}}
            for m in members:
                want.setdefault((m["kind"], m["id"]), set()).add("wikidata")
            details = self.details_many(list(want))
            details.setdefault((n["kind"], n["id"]), n)
            # коллекции TMDB, к которым относятся найденные; доверяем так же, как при сборке (см. build)
            tagged = {(m["kind"], m["id"]) for m in members}
            in_collection: dict[int, tuple] = {}
            cols = {}
            for cid in {d["collection_id"] for d in details.values() if d["collection_id"]}:
                col = self.tmdb(f"collection/{cid}")
                if col and col.get("parts"):
                    cols[cid] = (clean_collection_name(col.get("name") or ""), [p["id"] for p in col["parts"]])
            details.update(self.details_many([("movie", pid) for _, ids in cols.values() for pid in ids if ("movie", pid) not in details]))
            for cid, (name, ids) in cols.items():
                parts = [details.get(("movie", pid)) for pid in ids]
                passing = sum(1 for d in parts if d and self.passes(d))
                trusted = n["collection_id"] == cid or (passing / len(ids) >= 0.75 and any(("movie", pid) in tagged for pid in ids))
                if trusted:
                    for pid in ids:
                        in_collection[pid] = (cid, name)
                        want.setdefault(("movie", pid), set()).add("tmdb_collection")
            entries = self._entries(want, details, in_collection, root_key=(n["kind"], n["id"]))
            self._insert_new(fid, entries, (n["kind"], n["id"]))
        finally:
            self._set(fid, busy=0)

    def hide(self, fid: int, kind: str, tid: int, hidden: bool) -> bool:
        cur = self.store.conn().execute(
            "UPDATE franchise_items SET hidden=?, hidden_by='user', new_until=CASE WHEN ?=1 THEN NULL ELSE new_until END WHERE franchise_id=? AND kind=? AND tmdb_id=?",
            (1 if hidden else 0, 1 if hidden else 0, fid, kind, tid))
        return cur.rowcount > 0

    def remove_manual(self, fid: int, kind: str, tid: int) -> bool:
        cur = self.store.conn().execute("DELETE FROM franchise_items WHERE franchise_id=? AND kind=? AND tmdb_id=? AND source='manual'", (fid, kind, tid))
        return cur.rowcount > 0

    # ------------------------------------------------------------------ чтение

    def franchise_summary(self, f, members: bool = False) -> dict:
        now = int(time.time())
        cnt = self.row(
            "SELECT SUM(hidden=0) visible, SUM(hidden=1) hidden, SUM(hidden=0 AND COALESCE(new_until,0)>?) new FROM franchise_items WHERE franchise_id=?", now, f["id"])
        out = {"id": f["id"], "title": f["title"], "status": f["status"], "busy": bool(f["busy"]), "error": f["error"],
               "wikidata": f["wikidata_id"], "resolved_at": f["resolved_at"], "merged_into": f["merged_into"],
               "counts": {"visible": cnt["visible"] or 0, "hidden": cnt["hidden"] or 0, "new": cnt["new"] or 0}}
        if f["status"] == "needs_choice":
            out["choices"] = json.loads(f["choices"] or "[]")
        out["cover"] = self.cover(f["id"])
        out["logo"] = f["logo"]
        if members:
            # видимые позиции коротким списком: по ним плагин узнаёт, смотрит ли пользователь эту коллекцию (просмотры лежат в Lampa)
            out["members"] = [[r["kind"], r["tmdb_id"]] for r in self.rows("SELECT kind, tmdb_id FROM franchise_items WHERE franchise_id=? AND hidden=0", f["id"])]
        return out

    def cover(self, fid: int) -> dict | None:
        """Картинки для плитки коллекции: кадр первой части основной коллекции (иначе самой ранней позиции).
        У составной вселенной (см. _identity) первая часть одной из коллекций не подходит: берём лучшую по рейтингу позицию."""
        rows, composite = self._identity(fid)
        cards = [json.loads(r["card"]) for r in rows]
        if composite:
            every = [json.loads(r["card"]) for r in self.rows("SELECT card FROM franchise_items WHERE franchise_id=? AND hidden=0", fid)]
            cards = sorted((c for c in every if c.get("backdrop_path")), key=lambda c: -(c.get("vote_average") or 0))[:1] or every[:1]
        pick = next((c for c in cards if c.get("backdrop_path")), cards[0] if cards else None)
        return {"backdrop_path": pick.get("backdrop_path"), "poster_path": pick.get("poster_path")} if pick else None

    def franchise_detail(self, fid: int, include_hidden: bool = False) -> dict | None:
        f = self.franchise(fid)
        if not f:
            return None
        out = self.franchise_summary(f)
        if f["merged_into"]:
            return out
        now = int(time.time())
        groups: dict[str, dict] = {}
        for r in self.rows("SELECT * FROM franchise_items WHERE franchise_id=?", fid):
            if r["hidden"] and not include_hidden:
                continue
            g = groups.setdefault(r["grp"], {"key": r["grp"], "title": tr(r["grp_title"]), "items": []})
            card = json.loads(r["card"])
            card.update(hidden=bool(r["hidden"]), hidden_by=r["hidden_by"], is_new=bool(r["new_until"] and r["new_until"] > now and not r["hidden"]),
                        source=r["source"], seasons=r["seasons"])
            g["items"].append(card)

        def sort_key(c: dict):
            return (c.get("release_date") or c.get("first_air_date") or "9999", c.get("title") or c.get("name") or "")

        for g in groups.values():
            g["items"].sort(key=sort_key)
            g["hidden_count"] = sum(1 for c in g["items"] if c["hidden"])
        ordered = sorted(groups.values(), key=lambda g: (
            0 if g["key"].startswith("collection:") else GROUP_ORDER.get(g["key"], 5),
            min((sort_key(c)[0] for c in g["items"]), default="9999")))
        out["groups"] = ordered
        return out

    def status(self, kind: str, tid: int, user: int = 1) -> dict:
        f = self.find_by_member(kind, tid, user) or self.row(
            "SELECT * FROM franchises WHERE user_id=? AND root_kind=? AND root_id=? AND merged_into IS NULL ORDER BY id DESC LIMIT 1", user, kind, tid)
        return {"in_library": bool(self.row("SELECT 1 FROM library_items WHERE user_id=? AND kind=? AND tmdb_id=?", user, kind, tid)),
                "franchise": self.franchise_summary(f) if f else None}

    # ---- рекомендации по просмотренному

    REC_MAX_SEEDS = 40          # сколько просмотренных позиций берём (самые свежие)
    REC_PER_SEED = 20           # сколько рекомендаций TMDB берём у каждой
    REC_MIN_VOTES = 100         # отсеиваем малоизвестное
    REC_LIMIT = 60

    def recommend(self, seeds: list[dict], exclude: list[dict], limit: int | None = None) -> list[dict]:
        """Рекомендации TMDB по списку просмотренного. Что смотрел пользователь, знает только Lampa: она присылает
        просмотренное (seeds, от свежих к старым) и всё, что уже начато или просмотрено (exclude, это в подборку не берём).
        Сервер ничего из этого не хранит. -> карточки с полем because (по каким просмотренным попала в подборку)."""
        limit = limit or self.REC_LIMIT
        clean = []
        for s_ in seeds[: self.REC_MAX_SEEDS]:
            kind = s_.get("kind")
            try:
                tid = int(s_.get("id"))
            except (TypeError, ValueError):
                continue
            if kind in ("movie", "tv") and tid > 0:
                clean.append((kind, tid, str(s_.get("title") or "")[:80]))
        skip = {(x[0], x[1]) for x in clean}
        for x in exclude:
            try:
                if x.get("kind") in ("movie", "tv"):
                    skip.add((x["kind"], int(x["id"])))
            except (TypeError, ValueError, KeyError):
                pass
        if not clean:
            return []
        with ThreadPoolExecutor(max_workers=self.workers) as pool:
            fetched = list(pool.map(lambda x: self.store.run_and_close(self.tmdb, f"{x[0]}/{x[1]}/recommendations"), clean))
        score: dict[tuple, float] = {}
        cards: dict[tuple, dict] = {}
        because: dict[tuple, list[str]] = {}
        today = self.today()
        for idx, ((kind, _tid, title), data) in enumerate(zip(clean, fetched)):
            weight = 1.0 / (1 + idx * 0.03)                     # свежий просмотр весит чуть больше старого
            for rank, r in enumerate(((data or {}).get("results") or [])[: self.REC_PER_SEED]):
                rk = r.get("media_type") if r.get("media_type") in ("movie", "tv") else kind
                key = (rk, r.get("id"))
                if key in skip or r.get("adult") or not r.get("poster_path") or (r.get("vote_count") or 0) < self.REC_MIN_VOTES:
                    continue
                if rk == "movie" and (r.get("release_date") or "9999") > today:
                    continue                                    # ещё не вышло
                if rk == "tv" and (r.get("first_air_date") or "9999") > today:
                    continue
                score[key] = score.get(key, 0.0) + weight * (1 - rank / (self.REC_PER_SEED + 5))
                cards.setdefault(key, r)
                if title and len(because.setdefault(key, [])) < 3 and title not in because[key]:
                    because[key].append(title)
        def final(key):
            va = min(float(cards[key].get("vote_average") or 0), 9.0)
            return score[key] * (0.7 + 0.3 * va / 9.0)         # нескольким просмотренным нравится и оценка высокая: выше
        out = []
        for key in sorted(score, key=final, reverse=True)[:limit]:
            card = card_of(normalize(key[0], cards[key]))
            card["because"] = because.get(key, [])
            out.append(card)
        return out

    # ---- дубли коллекций

    def dedupe(self, user: int, dry: bool = False) -> list[tuple[int, int]]:
        """Убрать одинаковые коллекции пользователя: одна Wikidata-франшиза, один корень или один и тот же видимый состав.
        Остаётся самая старая (у неё раньше выставлены пользовательские настройки), остальные удаляются вместе с составом.
        Дубли появляются, когда одну коллекцию собрали дважды (например, под двумя пользователями, которых потом слили).
        -> [(удалённая, оставленная)]."""
        rows = self.rows("SELECT * FROM franchises WHERE user_id=? AND merged_into IS NULL AND status='ready' ORDER BY id", user)
        parent = {r["id"]: r["id"] for r in rows}

        def find(x):
            while parent[x] != x:
                parent[x] = parent[parent[x]]
                x = parent[x]
            return x

        def union(a, b):
            ra, rb = find(a), find(b)
            if ra != rb:
                parent[max(ra, rb)] = min(ra, rb)      # корнем становится старая

        seen: dict[tuple, int] = {}
        for r in rows:
            members = frozenset((i["kind"], i["tmdb_id"]) for i in self.rows("SELECT kind, tmdb_id FROM franchise_items WHERE franchise_id=? AND hidden=0", r["id"]))
            for key in ((("wd", r["wikidata_id"]) if r["wikidata_id"] else None), ("root", r["root_kind"], r["root_id"]), (("set", members) if members else None)):
                if key is None:
                    continue
                if key in seen:
                    union(seen[key], r["id"])
                else:
                    seen[key] = r["id"]
        removed = [(r["id"], find(r["id"])) for r in rows if find(r["id"]) != r["id"]]
        if not dry:
            c = self.store.conn()
            for gone, _keep in removed:
                for table in ("franchise_items", "lib_events"):
                    c.execute(f"DELETE FROM {table} WHERE franchise_id=?", (gone,))
                c.execute("DELETE FROM franchises WHERE id=?", (gone,))
        return removed

    # ---- выбранные торренты (автозапуск): общие для всех устройств пользователя

    CHOICES_MAX = 2000
    ITEMS_MAX = 5000            # отдельных позиций в библиотеке одного пользователя
    FRANCHISES_MAX = 300        # коллекций одного пользователя: каждая собирается запросами к TMDB и Wikidata, очередь общая

    OWNER = 1                   # владелец сервера: демо-пределы (TAPOK_LIMIT_*) его не касаются

    def user_caps(self, user: int) -> dict:
        """Свои пределы пользователя (`tapokhub users limit`): {movie|tv|franchise: число}. Они сильнее общих и действуют и на владельца."""
        try:
            raw = json.loads(self.store.meta_get(f"limits:{user}") or "{}")
        except ValueError:
            return {}
        return {k: int(v) for k, v in raw.items() if k in ("movie", "tv", "franchise") and isinstance(v, int) and v > 0} if isinstance(raw, dict) else {}

    def set_user_caps(self, user: int, caps: dict) -> dict:
        caps = {k: int(v) for k, v in caps.items() if k in ("movie", "tv", "franchise") and int(v) > 0}
        self.store.meta_set(f"limits:{user}", json.dumps(caps))
        return caps

    def demo_cap(self, user: int, what: str) -> int:
        """Предел на пользователя: what = movie | tv | franchise. Сначала его собственный (`users limit`), потом общий демо-предел
        (TAPOK_LIMIT_*, владельца он не касается). 0 = предела нет."""
        own = self.user_caps(user).get(what)
        if own:
            return own
        if user == self.OWNER:
            return 0
        cfg = self.proxy.cfg
        return {"movie": cfg.limit_movies, "tv": cfg.limit_tv, "franchise": cfg.limit_franchises}[what]

    def choices(self, user: int) -> list[dict]:
        return [{"kind": r["kind"], "id": r["tmdb_id"], "title": r["title"] or "", "MagnetUri": r["magnet"] or "", "Link": r["link"] or "",
                 "poster": r["poster"] or "", "tracker": r["tracker"] or "", "at": r["at"]}
                for r in self.rows("SELECT * FROM torrent_choices WHERE user_id=? ORDER BY at DESC", user)]

    def choose(self, user: int, kind: str, tid: int, data: dict) -> dict | None:
        """Запомнить торрент, выбранный для фильма или сериала. Нужна ссылка (magnet или торрент-файл)."""
        magnet = str(data.get("MagnetUri") or "")[:4000]
        link = str(data.get("Link") or "")[:2000]
        if not (magnet or link):
            return None
        at = int(time.time() * 1000)
        c = self.store.conn()
        c.execute(
            "INSERT INTO torrent_choices(user_id,kind,tmdb_id,title,magnet,link,poster,tracker,at) VALUES(?,?,?,?,?,?,?,?,?) "
            "ON CONFLICT(user_id,kind,tmdb_id) DO UPDATE SET title=excluded.title, magnet=excluded.magnet, link=excluded.link, "
            "poster=excluded.poster, tracker=excluded.tracker, at=excluded.at",
            (user, kind, tid, str(data.get("title") or "")[:300], magnet, link, str(data.get("poster") or "")[:300], str(data.get("tracker") or "")[:80], at))
        extra = self.rows("SELECT kind, tmdb_id FROM torrent_choices WHERE user_id=? ORDER BY at DESC LIMIT -1 OFFSET ?", user, self.CHOICES_MAX)
        for r in extra:
            c.execute("DELETE FROM torrent_choices WHERE user_id=? AND kind=? AND tmdb_id=?", (user, r["kind"], r["tmdb_id"]))
        return next((x for x in self.choices(user) if x["kind"] == kind and x["id"] == tid), None)

    # ---- настройки плагина пользователя (общие для его устройств; сервер только хранит)

    SETTING_KEY = re.compile(r"^tapokhub_[A-Za-z0-9_]{1,60}$")
    SETTINGS_MAX = 200

    def settings_get(self, user: int) -> dict:
        return {r["key"]: {"value": r["value"], "at": r["at"]} for r in self.rows("SELECT * FROM user_settings WHERE user_id=?", user)}

    def settings_set(self, user: int, items: dict) -> dict:
        """Записать настройки {ключ: значение}; -> {ключ: время записи}. Ключи только вида tapokhub_..., значения короткие строки."""
        at = int(time.time() * 1000)
        c = self.store.conn()
        done = {}
        for k, v in list(items.items())[:100]:
            if not isinstance(k, str) or not self.SETTING_KEY.match(k) or k in ("tapokhub_token", "tapokhub_torrents"):
                continue        # токен и выбранные торренты хранятся отдельно и здесь не нужны
            c.execute("INSERT INTO user_settings(user_id,key,value,at) VALUES(?,?,?,?) ON CONFLICT(user_id,key) DO UPDATE SET value=excluded.value, at=excluded.at",
                      (user, k, str(v)[:500], at))
            done[k] = at
        extra = self.rows("SELECT key FROM user_settings WHERE user_id=? ORDER BY at DESC LIMIT -1 OFFSET ?", user, self.SETTINGS_MAX)
        for r in extra:
            c.execute("DELETE FROM user_settings WHERE user_id=? AND key=?", (user, r["key"]))
        return done

    def stats(self, user: int = 1) -> dict:
        """Сводка для главного экрана: сколько разных фильмов и сериалов в библиотеке и видимых частях коллекций, сколько
        коллекций. Идентификаторы отдаём списками: «просмотрено» знает только Lampa (её отметки лежат на устройстве)."""
        rows = self.rows(
            "SELECT kind, tmdb_id FROM library_items WHERE user_id=? UNION "
            "SELECT i.kind, i.tmdb_id FROM franchise_items i JOIN franchises f ON f.id=i.franchise_id "
            "WHERE i.hidden=0 AND f.user_id=? AND f.status='ready' AND f.merged_into IS NULL", user, user)
        out: dict = {"movie": [], "tv": []}
        for r in rows:
            out[r["kind"]].append(r["tmdb_id"])
        n = self.row("SELECT COUNT(*) c FROM franchises WHERE user_id=? AND status='ready' AND merged_into IS NULL", user)["c"]
        return {"movies": len(out["movie"]), "tv": len(out["tv"]), "collections": n, "ids": out}

    def library_cards(self, user: int = 1) -> list[dict]:
        rows = self.rows("SELECT kind, tmdb_id, added_at FROM library_items WHERE user_id=? ORDER BY added_at DESC", user)
        det = self.details_many([(r["kind"], r["tmdb_id"]) for r in rows])
        return [dict(card_of(det[(r["kind"], r["tmdb_id"])]), added_at=r["added_at"], group=library_group(det[(r["kind"], r["tmdb_id"])]))
                for r in rows if (r["kind"], r["tmdb_id"]) in det]

    # ------------------------------------------------------------------ HTTP-API

    def handle(self, method: str, path: str, query: str, body: bytes, user: int = 1) -> tuple[int, Any]:
        """path: то, что после /lib/. -> (HTTP-статус, JSON-объект)."""
        q = dict(urllib.parse.parse_qsl(query))
        try:
            data = json.loads(body.decode("utf-8")) if body else {}
        except ValueError:
            return 400, {"error": "bad json"}
        if not isinstance(data, dict):
            return 400, {"error": "bad json"}
        parts = [p for p in path.strip("/").split("/") if p]

        def kind_id(src: dict):
            kind = str(src.get("kind") or src.get("media_type") or "")
            try:
                tid = int(src.get("id") if src.get("id") is not None else src.get("tmdb"))
            except (TypeError, ValueError):
                return None
            return (kind, tid) if kind in ("movie", "tv") and tid > 0 else None

        if method == "GET" and parts == ["status"]:
            ki = kind_id(q)
            return (200, self.status(*ki, user)) if ki else (400, {"error": "kind and id required"})

        if parts == ["telegram"]:
            return self.proxy.telegram.handle(method, data, user)

        if parts == ["registration"]:
            return self.proxy.users.registration_api(method, data, user)

        if parts == ["settings"] and method == "GET":
            return 200, {"settings": self.settings_get(user)}
        if parts == ["settings"] and method == "POST":
            items = data.get("settings")
            if not isinstance(items, dict):
                return 400, {"error": "settings required"}
            return 200, {"saved": self.settings_set(user, items)}

        if parts == ["torrents"] and method == "GET":
            return 200, {"items": self.choices(user)}
        if parts == ["torrents"] and method == "POST":
            ki = kind_id(data)
            if not ki:
                return 400, {"error": "kind and id required"}
            item = self.choose(user, ki[0], ki[1], data)
            return (200, item) if item else (400, {"error": "MagnetUri or Link required"})
        if parts == ["torrents", "forget"] and method == "POST":
            ki = kind_id(data)
            if data.get("all"):
                cur = self.store.conn().execute("DELETE FROM torrent_choices WHERE user_id=?", (user,))
            elif ki:
                cur = self.store.conn().execute("DELETE FROM torrent_choices WHERE user_id=? AND kind=? AND tmdb_id=?", (user, *ki))
            else:
                return 400, {"error": "all or kind and id required"}
            return 200, {"deleted": cur.rowcount}

        if parts == ["recommend"] and method == "POST":
            seeds, exclude = data.get("seeds"), data.get("exclude")
            if not isinstance(seeds, list) or not isinstance(exclude or [], list):
                return 400, {"error": "seeds required"}
            return 200, {"items": self.recommend([x for x in seeds if isinstance(x, dict)], [x for x in (exclude or []) if isinstance(x, dict)])}

        if parts == ["stats"] and method == "GET":
            return 200, self.stats(user)

        if parts == ["items"] and method == "GET":
            return 200, {"items": self.library_cards(user)}
        if parts == ["items", "add"] and method == "POST":
            ki = kind_id(data)
            if not ki:
                return 400, {"error": "kind and id required"}
            if not self.row("SELECT 1 FROM library_items WHERE user_id=? AND kind=? AND tmdb_id=?", user, *ki) and \
                    self.row("SELECT COUNT(*) c FROM library_items WHERE user_id=?", user)["c"] >= self.ITEMS_MAX:
                return 429, {"error": tr("в библиотеке уже {ITEMS_MAX} позиций, это предел", ITEMS_MAX=self.ITEMS_MAX)}
            cap = self.demo_cap(user, ki[0])
            if cap and not self.row("SELECT 1 FROM library_items WHERE user_id=? AND kind=? AND tmdb_id=?", user, *ki) and \
                    self.row("SELECT COUNT(*) c FROM library_items WHERE user_id=? AND kind=?", user, ki[0])["c"] >= cap:
                return 429, {"error": tr("В демо-версии можно добавить не больше {cap} {v3}. Уберите что-нибудь или поставьте свой сервер", cap=cap, v3=tr('фильмов') if ki[0] == 'movie' else tr('сериалов'))}
            if not self.details(*ki):
                return 404, {"error": tr("TMDB не знает эту позицию")}
            self.store.conn().execute("INSERT OR IGNORE INTO library_items(user_id,kind,tmdb_id,added_at) VALUES(?,?,?,?)", (user, *ki, int(time.time())))
            return 200, self.status(*ki, user)
        if parts == ["items", "remove"] and method == "POST":
            ki = kind_id(data)
            if not ki:
                return 400, {"error": "kind and id required"}
            self.store.conn().execute("DELETE FROM library_items WHERE user_id=? AND kind=? AND tmdb_id=?", (user, *ki))
            return 200, self.status(*ki, user)

        if parts == ["franchises"] and method == "GET":
            return 200, {"franchises": [self.franchise_summary(f, members=True) for f in self.rows("SELECT * FROM franchises WHERE user_id=? AND merged_into IS NULL ORDER BY id", user)]}
        if parts == ["franchises"] and method == "POST":
            ki = kind_id(data)
            if not ki:
                return 400, {"error": "kind and id required"}
            if not self.find_by_member(*ki, user) and \
                    self.row("SELECT COUNT(*) c FROM franchises WHERE user_id=? AND merged_into IS NULL", user)["c"] >= self.FRANCHISES_MAX:
                return 429, {"error": tr("коллекций уже {FRANCHISES_MAX}, это предел", FRANCHISES_MAX=self.FRANCHISES_MAX)}
            cap = self.demo_cap(user, "franchise")
            if cap and not self.find_by_member(*ki, user) and \
                    self.row("SELECT COUNT(*) c FROM franchises WHERE user_id=? AND merged_into IS NULL", user)["c"] >= cap:
                return 429, {"error": tr("В демо-версии можно создать не больше {cap} коллекций. Удалите одну или поставьте свой сервер", cap=cap)}
            wd, prop = data.get("wikidata"), data.get("prop") or "P8345"
            if wd is not None and not (isinstance(wd, str) and QID_RE.match(wd) and prop in WD_PROPS):
                return 400, {"error": "bad wikidata or prop"}
            return 200, self.franchise_summary(self.create(*ki, wikidata=wd, prop=prop, user=user))

        if len(parts) >= 2 and parts[0] == "franchises" and parts[1].isdigit():
            fid = int(parts[1])
            f = self.franchise(fid)
            if not f or f["user_id"] != user:            # чужие коллекции не видны и не различаются с несуществующими
                return 404, {"error": "not found"}
            if f["merged_into"] and len(parts) == 2:
                return 200, self.franchise_summary(f)
            if len(parts) == 2 and method == "GET":
                return 200, self.franchise_detail(fid, include_hidden=q.get("hidden") == "1")
            if len(parts) == 3 and method == "POST":
                action = parts[2]
                if action in ("hide", "add", "item-remove"):
                    ki = kind_id(data)
                    if not ki:
                        return 400, {"error": "kind and id required"}
                    if action == "hide":
                        ok = self.hide(fid, *ki, hidden=bool(data.get("hidden", True)))
                    elif action == "add":
                        ok = self.add_scope(fid, *ki, str(data.get("scope") or "item"))
                    else:
                        ok = self.remove_manual(fid, *ki)
                    return (200, self.franchise_detail(fid, include_hidden=True)) if ok else (404, {"error": "not found"})
                if action == "add-options" and method == "POST":
                    ki = kind_id(data)
                    opts = self.add_options(fid, *ki) if ki else None
                    return (200, opts) if opts else (404, {"error": "not found"})
                if action == "refresh":
                    self.enqueue(fid)
                    return 200, self.franchise_summary(self.franchise(fid))
                if action == "choose" and data.get("wikidata"):
                    wd, prop = data["wikidata"], data.get("prop") or "P8345"
                    if not (isinstance(wd, str) and QID_RE.match(wd) and prop in WD_PROPS):
                        return 400, {"error": "bad wikidata or prop"}
                    self._set(fid, wikidata_id=wd, wd_prop=prop, status="pending", error=None, choices=None)
                    self.enqueue(fid)
                    return 200, self.franchise_summary(self.franchise(fid))
                if action == "delete":
                    for table in ("franchise_items", "lib_events"):
                        self.store.conn().execute(f"DELETE FROM {table} WHERE franchise_id=?", (fid,))
                    self.store.conn().execute("DELETE FROM franchises WHERE id=?", (fid,))
                    return 200, {"deleted": fid}

        if parts == ["search"] and method == "GET":
            text = (q.get("query") or "").strip()
            if not text:
                return 400, {"error": "query required"}
            res = self.tmdb("search/multi", [("query", text)]) or {}
            out = []
            for r in res.get("results", [])[:20]:
                if r.get("media_type") in ("movie", "tv") and not r.get("adult"):
                    n = normalize(r["media_type"], r)
                    out.append(card_of(n))
            return 200, {"results": out}

        if parts == ["events"] and method == "GET":
            rows = self.rows("SELECT e.* FROM lib_events e JOIN franchises f ON f.id=e.franchise_id WHERE e.seen=0 AND f.user_id=? ORDER BY e.id LIMIT 200", user)
            return 200, {"events": [dict(r) for r in rows]}
        if parts == ["events", "seen"] and method == "POST":
            ids = data.get("ids")
            mine = "franchise_id IN (SELECT id FROM franchises WHERE user_id=?)"
            if data.get("all"):
                self.store.conn().execute(f"UPDATE lib_events SET seen=1 WHERE {mine}", (user,))
            elif isinstance(ids, list):
                self.store.conn().executemany(f"UPDATE lib_events SET seen=1 WHERE id=? AND {mine}", [(i, user) for i in ids if isinstance(i, int)])
            return 200, {"ok": True}

        return 404, {"error": "not found"}
