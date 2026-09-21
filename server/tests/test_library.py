#!/usr/bin/env python3
"""Тесты библиотеки на поддельных TMDB и Wikidata. Запуск: python3 server/test_library.py"""

import os as _os
_os.environ["TAPOK_LANG"] = "ru"      # тесты проверяют русские тексты; английские: test_i18n.py
import http.client
import http.server
import json
import re
import shutil
import socketserver
import sys
import tempfile
import threading
import time
import unittest
import urllib.parse
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from tapokhub.core.config import Config  # noqa: E402
from tapokhub.core.store import Store  # noqa: E402
from tapokhub.modules.api import create_server  # noqa: E402
from tapokhub.modules.proxy import Proxy  # noqa: E402
from tapokhub.modules import library as lib  # noqa: E402

KEY = "d" * 32
TOKEN = "t0k3n" * 5
TODAY = "2026-09-19"


def movie(mid, title, date, runtime, votes, status="Released", coll=None, genres=(), poster=True):
    d = {"id": mid, "title": title, "original_title": title + " (orig)", "release_date": date, "runtime": runtime,
         "vote_count": votes, "vote_average": 7.5, "status": status, "genres": [{"id": g} for g in genres],
         "poster_path": f"/poster{mid:08d}.jpg" if poster else None, "backdrop_path": f"/backdrop{mid:06d}.jpg", "overview": "О" * 400}
    if coll:
        d["belongs_to_collection"] = {"id": coll[0], "name": coll[1]}
    return d


def tv(tid, name, date, votes, seasons=1, status="Ended", genres=(), runtime=(45,)):
    return {"id": tid, "name": name, "original_name": name + " (orig)", "first_air_date": date, "episode_run_time": list(runtime),
            "vote_count": votes, "vote_average": 8.0, "status": status, "genres": [{"id": g} for g in genres],
            "number_of_seasons": seasons, "poster_path": f"/poster{tid:08d}.jpg", "backdrop_path": f"/backdrop{tid:06d}.jpg", "overview": "О"}


def fresh_world():
    """Выдуманная франшиза «Сага» с неудобными данными."""
    C = (500, "Сага (Коллекция)")
    return {
        "movies": {
            1000: movie(1000, "Сага: Часть 1", "2001-05-01", 120, 5000, coll=C),
            1001: movie(1001, "Сага: Часть 2", "2003-05-01", 125, 4000, coll=C),
            1002: movie(1002, "Сага: Часть 3", "2005-05-01", 130, 4500, coll=C),
            2000: movie(2000, "Сага: Изгой", "2016-12-01", 133, 9000),
            2001: movie(2001, "LEGO Сага", "2009-01-01", 22, 113),                 # короткая -> Прочее
            2002: movie(2002, "Сага: Мало голосов", "2012-01-01", 100, 10),         # мало голосов -> Прочее
            2003: movie(2003, "Сага: Спецвыпуск", "2010-01-01", 90, 500),           # дубль (год и название)
            2004: movie(2004, "Сага: Спецвыпуск", "2010-06-01", 90, 900),           # дубль, голосов больше
            2100: movie(2100, "Сага: Будущее", "2099-01-01", 0, 0, status="Post Production"),
            7000: movie(7000, "Сага: Другая дверь", "2015-01-01", 100, 300),
            # коллекция-мусор: короткие ролики (Wikidata знает двух из трёх)
            2500: movie(2500, "Сага в кубиках 1", "2011-01-01", 10, 60, coll=(700, "Сага в кубиках (Коллекция)")),
            2501: movie(2501, "Сага в кубиках 2", "2012-01-01", 10, 60, coll=(700, "Сага в кубиках (Коллекция)")),
            2502: movie(2502, "Сага в кубиках 3", "2013-01-01", 10, 60, coll=(700, "Сага в кубиках (Коллекция)")),
            # честная вторая коллекция (Wikidata знает один из двух фильмов)
            # без франшизы: ремейк, продолжение и экранизация того же романа (связи только по цепочкам)
            9500: movie(9500, "Роман: фильм 1961", "1961-01-01", 90, 4000),
            9501: movie(9501, "Роман: продолжение", "1965-01-01", 90, 900),
            9502: movie(9502, "Роман: ремейк", "1996-01-01", 100, 3000),
            9503: movie(9503, "Роман: далёкое ответвление", "2021-01-01", 100, 3000),
            2600: movie(2600, "Ответвление 1", "2020-01-01", 100, 300, coll=(800, "Ответвление (Коллекция)")),
            2601: movie(2601, "Ответвление 2", "2021-01-01", 100, 300, coll=(800, "Ответвление (Коллекция)")),
            # каталог студии: «Сказка» состоит в серии «Фильмы студии Н» вместе с чужими фильмами
            9000: movie(9000, "Сказка", "1961-01-25", 79, 5000, coll=(900, "Сказка (Коллекция)")),
            9001: movie(9001, "Сказка 2", "2003-01-01", 80, 900, coll=(900, "Сказка (Коллекция)")),
            **{9100 + i: movie(9100 + i, f"Чужой мультфильм {i}", f"19{50 + i}-01-01", 80, 800) for i in range(6)},
        },
        "tv": {
            3000: tv(3000, "Сага: Сериал", "2019-11-12", 2000, seasons=2),
            3001: tv(3001, "Сага: Мультсериал", "2008-10-03", 800, genres=(16,)),
            3002: tv(3002, "Сага: Фанатский", "2006-01-01", 10),
            3003: tv(3003, "Сага: Скоро на ТВ", "", 0, status="In Production"),
        },
        "collections": {900: [9001, 9000], 500: [1002, 1000, 1001], 700: [2500, 2501, 2502], 800: [2601, 2600]},   # порядок TMDB перепутан
        "collection_names": {900: "Сказка (Коллекция)", 500: "Сага (Коллекция)", 600: "Одиночка (Коллекция)", 700: "Сага в кубиках (Коллекция)", 800: "Ответвление (Коллекция)"},
        "external": {("movie", 9500): "Q9500", ("movie", 9000): "Q9000", ("movie", 1000): "Q100", ("tv", 3000): "Q300", ("movie", 7000): "Q700"},
        # Wikidata: qid -> (метка, {prop: [значения]})
        "wd": {
            "Q9600": ("Роман", {}),
            "Q9500": ("Фильм 1961", {"P144": ["Q9600"], "P156": ["Q9501"], "P4947": ["9500"]}),
            "Q9501": ("Продолжение", {"P155": ["Q9500"], "P4947": ["9501"]}),
            "Q9502": ("Ремейк", {"P144": ["Q9600"], "P156": ["Q9503"], "P4947": ["9502"]}),
            "Q9503": ("Ответвление", {"P155": ["Q9502"], "P4947": ["9503"]}),
            "Q900": ("фильмы студии Некто", {"P31": ["Q56884562"]}),
            "Q9000": ("Сказка", {"P179": ["Q900"], "P4947": ["9000"]}),
            **{f"Q91{i}": (f"Чужой {i}", {"P179": ["Q900"], "P4947": [str(9100 + i)]}) for i in range(6)},
            "Q1": ("Сага", {}), "Q2": ("Другая сага", {}),
            "Q100": ("Часть 1", {"P8345": ["Q1"], "P4947": ["1000"]}),
            "Q200": ("Изгой", {"P8345": ["Q1"], "P4947": ["2000"]}),
            "Q201": ("LEGO", {"P8345": ["Q1"], "P4947": ["2001"]}),
            "Q202": ("Мало", {"P8345": ["Q1"], "P4947": ["2002"]}),
            "Q203": ("Спец A", {"P8345": ["Q1"], "P4947": ["2003"]}),
            "Q204": ("Спец B", {"P8345": ["Q1"], "P4947": ["2004"]}),
            "Q210": ("Будущее", {"P8345": ["Q1"], "P4947": ["2100"]}),
            "Q220": ("Нет в TMDB", {"P8345": ["Q1"], "P4947": ["2200"]}),
            "Q300": ("Сериал", {"P8345": ["Q1"], "P4983": ["3000"]}),
            "Q301": ("Мульт", {"P8345": ["Q1"], "P4983": ["3001"]}),
            "Q302": ("Фанатский", {"P8345": ["Q1"], "P4983": ["3002"]}),
            "Q303": ("Скоро", {"P8345": ["Q1"], "P4983": ["3003"]}),
            "Q250": ("Кубики 1", {"P8345": ["Q1"], "P4947": ["2500"]}),
            "Q251": ("Кубики 2", {"P8345": ["Q1"], "P4947": ["2501"]}),
            "Q260": ("Ответвление 1", {"P8345": ["Q1"], "P4947": ["2600"]}),
            "Q700": ("Другая дверь", {"P8345": ["Q1"]}),                            # без TMDB-id: сама не участник
        },
        "search": [],
        # логотипы TMDB: у первой части нет вовсе, у второй русский и английский
        "images": {("movie", 1001): [{"iso_639_1": "en", "file_path": "/logoEN1001.png"}, {"iso_639_1": "ru", "file_path": "/logoRU1001.png"}],
                   ("movie", 1002): [{"iso_639_1": None, "file_path": "/logoNONE1002.png"}]},
    }


class World:
    """Один HTTP-сервер: и api.themoviedb.org, и Wikidata."""

    def __init__(self):
        self.data = fresh_world()
        self.counts = {"tmdb": 0, "wd": 0}
        self.wd_429 = 0            # столько ближайших запросов к Wikidata получат 429
        self.tmdb_down = False
        outer = self

        class H(http.server.BaseHTTPRequestHandler):
            def log_message(self, *a):
                pass

            def reply(self, status, obj):
                body = json.dumps(obj).encode()
                self.send_response(status)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)

            def do_GET(self):
                path, _, q = self.path.partition("?")
                params = dict(urllib.parse.parse_qsl(q))
                if path == "/app.min.js":
                    body = ("function key() { return '%s'; }" % KEY).encode()
                    self.send_response(200)
                    self.send_header("Content-Length", str(len(body)))
                    self.end_headers()
                    return self.wfile.write(body)
                if path == "/w/api.php":
                    return self.wikidata(params)
                outer.counts["tmdb"] += 1
                if outer.tmdb_down:
                    self.connection.close()
                    return
                if params.get("api_key") != KEY:
                    return self.reply(401, {"status_message": "Invalid API key"})
                d = outer.data
                if path == "/3/configuration":
                    return self.reply(200, {"images": {}})
                m = re.match(r"^/3/(movie|tv)/(\d+)/recommendations$", path)
                if m:
                    return self.reply(200, {"results": d.get("recs", {}).get((m[1], int(m[2])), [])})
                m = re.match(r"^/3/(movie|tv)/(\d+)/external_ids$", path)
                if m:
                    return self.reply(200, {"wikidata_id": d["external"].get((m[1], int(m[2])))})
                m = re.match(r"^/3/(movie|tv)/(\d+)/images$", path)
                if m:
                    return self.reply(200, {"logos": d["images"].get((m[1], int(m[2])), [])})
                m = re.match(r"^/3/(movie|tv)/(\d+)$", path)
                if m:
                    item = d["movies" if m[1] == "movie" else "tv"].get(int(m[2]))
                    return self.reply(200, item) if item else self.reply(404, {"status_code": 34})
                m = re.match(r"^/3/collection/(\d+)$", path)
                if m:
                    ids = d["collections"].get(int(m[1]))
                    if not ids:
                        return self.reply(404, {})
                    return self.reply(200, {"id": int(m[1]), "name": d["collection_names"].get(int(m[1]), "Коллекция"), "parts": [{"id": i} for i in ids]})
                if path == "/3/search/multi":
                    return self.reply(200, {"results": d["search"]})
                self.reply(404, {})

            def wikidata(self, p):
                outer.counts["wd"] += 1
                if outer.wd_429 > 0:
                    outer.wd_429 -= 1
                    return self.reply(429, {"error": "rate"})
                wd = outer.data["wd"]
                if p.get("action") == "wbgetentities":
                    ents = {}
                    for q in p["ids"].split("|"):
                        if q not in wd:
                            continue
                        label, claims = wd[q]
                        cl = {}
                        for prop, vals in claims.items():
                            item_props = ("P8345", "P179", "P144", "P155", "P156", "P4969")
                            cl[prop] = [{"mainsnak": {"datatype": "wikibase-item" if prop in item_props else "external-id",
                                                      "datavalue": {"value": {"id": v} if prop in item_props else v}}} for v in vals]
                        ents[q] = {"labels": {"ru": {"value": label}}, "claims": cl}
                    return self.reply(200, {"entities": ents})
                if p.get("action") == "query":
                    m = re.match(r"haswbstatement:(P\d+)=(Q\d+)(?: haswbstatement:(P\d+))?$", p["srsearch"])
                    hits = []
                    if m:
                        for q, (_, claims) in wd.items():
                            if m[2] in claims.get(m[1], []) and (not m[3] or m[3] in claims):
                                hits.append({"title": q})
                    return self.reply(200, {"query": {"search": hits}})
                self.reply(400, {"error": {"code": "bad", "info": "?"}})

        class S(socketserver.ThreadingMixIn, http.server.HTTPServer):
            daemon_threads = True

        self.server = S(("127.0.0.1", 0), H)
        self.url = f"http://127.0.0.1:{self.server.server_address[1]}"
        threading.Thread(target=self.server.serve_forever, daemon=True).start()

    def close(self):
        self.server.shutdown()
        self.server.server_close()


class Base(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.world = World()

    @classmethod
    def tearDownClass(cls):
        cls.world.close()

    def setUp(self):
        self.world.data = fresh_world()
        self.world.counts.update(tmdb=0, wd=0)
        self.world.wd_429 = 0
        self.world.tmdb_down = False
        self.tmpdir = Path(tempfile.mkdtemp(prefix="tapok-lib-"))
        self.cfg = Config(
            data_dir=self.tmpdir, token=TOKEN, listen_port=0, api_upstream=self.world.url, img_upstream=self.world.url,
            lampa_app_url=self.world.url + "/app.min.js", wikidata_api=self.world.url + "/w/api.php",
            wd_min_interval=0, wd_backoff=(0.01, 0.01), upstream_timeout=3)
        self.server, self.proxy = create_server(self.cfg)
        self.port = self.server.server_address[1]
        threading.Thread(target=self.server.serve_forever, daemon=True).start()
        self.lib = self.proxy.library
        self.lib.today = lambda: TODAY
        self.lib.start()

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()
        shutil.rmtree(self.tmpdir, ignore_errors=True)

    # --- удобства
    def build(self, kind="movie", tid=1000, **kw):
        f = self.lib.create(kind, tid, **kw)
        self.assertTrue(self.lib.wait_idle(20), "сборка не закончилась")
        return f["id"]

    def detail(self, fid, hidden=False):
        return self.lib.franchise_detail(fid, include_hidden=hidden)

    def by_group(self, d):
        return {g["key"]: [c["id"] for c in g["items"]] for g in d["groups"]}

    def api(self, method, path, body=None, token=TOKEN, raw=None):
        c = http.client.HTTPConnection("127.0.0.1", self.port, timeout=15)
        data = raw if raw is not None else (json.dumps(body).encode() if body is not None else None)
        c.request(method, f"/tmdb/{token}/lib/{path}", body=data, headers={"Content-Type": "application/json"} if data else {})
        r = c.getresponse()
        out = r.read()
        c.close()
        try:
            return r.status, json.loads(out)
        except ValueError:
            return r.status, None


class Resolve(Base):
    def test_full_build_groups_and_counts(self):
        fid = self.build()
        d = self.detail(fid)
        self.assertEqual(d["status"], "ready")
        self.assertEqual(d["title"], "Сага", "название франшизы берётся из Wikidata")
        g = self.by_group(d)
        self.assertEqual(g["collection:500"], [1000, 1001, 1002], "части коллекции по дате выхода, а не в порядке ответа TMDB")
        self.assertEqual(g["films"], [2004, 2000], "дубль 2003 отброшен (2004 голосов больше); по дате: 2010, затем 2016")
        self.assertEqual(g["upcoming"], [2100, 3003])
        self.assertEqual(g["series"], [3000])
        self.assertEqual(g["animation"], [3001])
        self.assertEqual(d["counts"]["visible"], 11, "9 + две части второй коллекции")

    def test_junk_collection_is_not_trusted(self):
        fid = self.build()
        full = self.detail(fid, hidden=True)
        self.assertNotIn("collection:700", [g["key"] for g in full["groups"]], "коллекция из коротких роликов не становится группой")
        ids = {c["id"] for g in full["groups"] for c in g["items"]}
        self.assertNotIn(2502, ids, "части недоверенной коллекции сверх названных Wikidata не подтягиваем")
        other = {c["id"] for g in full["groups"] if g["key"] == "other" for c in g["items"]}
        self.assertTrue({2500, 2501} <= other, "названные Wikidata ролики классифицируются по общим правилам и прячутся")

    def test_second_good_collection_is_a_group(self):
        d = self.detail(self.build())
        g = self.by_group(d)
        self.assertEqual(g["collection:800"], [2600, 2601], "вторая честная коллекция: обе части, даже та, которой нет в Wikidata")
        self.assertEqual({x["key"]: x["title"] for x in d["groups"]}["collection:800"], "Ответвление")

    def test_building_from_a_series_finds_the_same_collections(self):
        fid = self.build("tv", 3000)            # у сериала своей коллекции нет
        d = self.detail(fid)
        self.assertEqual(self.by_group(d)["collection:500"], [1000, 1001, 1002], "коллекция подтягивается по участникам франшизы")
        self.assertIn(3000, self.by_group(d)["series"])

    def test_summary_has_cover_from_first_part_of_main_collection(self):
        s = self.lib.franchise_summary(self.lib.franchise(self.build()))
        self.assertEqual(s["cover"], {"backdrop_path": "/backdrop001000.jpg", "poster_path": "/poster00001000.jpg"},
                         "обложка плитки: кадр самой ранней части основной коллекции")

    def test_cover_skips_hidden_and_absent_for_empty(self):
        fid = self.build()
        self.lib.hide(fid, "movie", 1000, True)
        self.assertEqual(self.lib.franchise_summary(self.lib.franchise(fid))["cover"]["backdrop_path"], "/backdrop001001.jpg")
        pending = self.lib.franchise_summary(self.lib.franchise(self.lib.create("movie", 6100)["id"]))
        self.assertIsNone(pending["cover"], "у ещё не собранной франшизы обложки нет")
        self.lib.wait_idle(10)

    def test_franchise_logo_prefers_interface_language_and_skips_items_without_logo(self):
        fid = self.build()
        s = self.lib.franchise_summary(self.lib.franchise(fid))
        self.assertEqual(s["logo"], "/logoRU1001.png", "у части 1 логотипа нет, берём у части 2, русский вместо английского")

    def test_studio_catalogue_series_is_not_a_franchise(self):
        old = lib.CATALOGUE_MIN
        lib.CATALOGUE_MIN = 4                       # в тесте «каталог» — 6 чужих фильмов, а не 90
        try:
            fid = self.build("movie", 9000)
        finally:
            lib.CATALOGUE_MIN = old
        d = self.detail(fid, hidden=True)
        ids = sorted(i for g in d["groups"] for i in [c["id"] for c in g["items"]])
        self.assertEqual(ids, [9000, 9001], "только сам фильм и его коллекция TMDB, без чужих мультфильмов студии")
        self.assertEqual(d["title"], "Сказка", "название из коллекции TMDB, а не «фильмы студии Некто»")
        self.assertIsNone(self.lib.franchise(fid)["wikidata_id"], "каталог не запоминаем как франшизу")

    def test_no_franchise_in_wikidata_collects_sequels_remakes_and_adaptations_by_links(self):
        fid = self.build("movie", 9500)
        d = self.detail(fid, hidden=True)
        ids = sorted(c["id"] for g in d["groups"] for c in g["items"])
        self.assertEqual(ids, [9500, 9501, 9502, 9503], "продолжение по цепочке, ремейк и его продолжение через общий роман")
        self.assertIsNone(self.lib.franchise(fid)["wikidata_id"])

    def test_popular_source_is_not_expanded(self):
        old = self.lib.wd.__class__.related
        calls = []
        def limited(self_, start, **kw):
            calls.append(kw); return old(self_, start, hub_limit=1)   # у романа два «основано на»: это уже хаб
        self.lib.wd.__class__.related = limited
        try:
            fid = self.build("movie", 9500)
        finally:
            self.lib.wd.__class__.related = old
        ids = sorted(c["id"] for g in self.detail(fid, hidden=True)["groups"] for c in g["items"])
        self.assertEqual(ids, [9500, 9501], "роман слишком популярен: его экранизации не подтягиваем")

    def test_add_options_and_scopes_for_a_manually_added_item(self):
        fid = self.build("movie", 9500)
        st, o = self.api("POST", f"franchises/{fid}/add-options", {"kind": "movie", "id": 2601})
        self.assertEqual((st, o["collection"]), (200, {"id": 800, "name": "Ответвление", "count": 2}))
        st, o = self.api("POST", f"franchises/{fid}/add-options", {"kind": "movie", "id": 2000})
        self.assertIsNone(o["collection"], "у фильма нет коллекции: предлагать нечего")
        self.assertEqual(self.api("POST", f"franchises/{fid}/add-options", {"kind": "movie", "id": 99999})[0], 404)

        st, d = self.api("POST", f"franchises/{fid}/add", {"kind": "movie", "id": 2000, "scope": "item"})
        ids = {c["id"] for g in d["groups"] for c in g["items"]}
        self.assertIn(2000, ids); self.assertNotIn(2600, ids)

        st, d = self.api("POST", f"franchises/{fid}/add", {"kind": "movie", "id": 2601, "scope": "collection"})
        groups = {g["key"]: sorted(c["id"] for c in g["items"]) for g in d["groups"]}
        self.assertEqual(groups["collection:800"], [2600, 2601], "вся коллекция, обе части, в своей группе")

        st, d = self.api("POST", f"franchises/{fid}/add", {"kind": "movie", "id": 2000, "scope": "collection"})
        self.assertEqual(st, 200, "у фильма нет коллекции: добавлен он один, без ошибки")

    def test_add_collection_keeps_users_choice_for_existing_items(self):
        fid = self.build("movie", 9500)
        self.api("POST", f"franchises/{fid}/add", {"kind": "movie", "id": 2601, "scope": "collection"})
        self.api("POST", f"franchises/{fid}/hide", {"kind": "movie", "id": 2600, "hidden": True})
        self.api("POST", f"franchises/{fid}/add", {"kind": "movie", "id": 2601, "scope": "collection"})
        d = self.detail(fid, hidden=True)
        item = [c for g in d["groups"] for c in g["items"] if c["id"] == 2600][0]
        self.assertTrue(item["hidden"] and item["hidden_by"] == "user", "повторное добавление коллекции не возвращает то, что пользователь скрыл")

    def test_add_related_pulls_everything_wikidata_links_to_the_item_in_background(self):
        fid = self.build("movie", 9500)
        st, d = self.api("POST", f"franchises/{fid}/add", {"kind": "movie", "id": 1000, "scope": "related"})
        self.assertEqual(st, 200)
        self.assertTrue(self.lib.wait_idle(20), "фоновое добавление закончилось")
        ids = {c["id"] for g in self.detail(fid, hidden=True)["groups"] for c in g["items"]}
        self.assertTrue({9500, 1000, 1001, 1002, 2000, 3000} <= ids, "франшиза «Сага» (Wikidata) и её коллекция добавлены к прежним")
        self.assertNotIn(2001, {c["id"] for g in self.detail(fid)["groups"] for c in g["items"]}, "короткое как обычно скрыто автоматикой")
        self.assertEqual(self.lib.franchise(fid)["busy"], 0)

    def rec(self, rid, title="Р", votes=500, va=7.0, date="2015-01-01", poster=True, kind="movie"):
        r = {"id": rid, "vote_count": votes, "vote_average": va, "overview": "о", "backdrop_path": "/b.jpg",
             "poster_path": "/p.jpg" if poster else None}
        r.update({"title": title, "release_date": date} if kind == "movie" else {"name": title, "first_air_date": date})
        return r

    def test_recommendations_rank_by_agreement_and_skip_seen_junk_and_unreleased(self):
        rec = self.rec
        self.world.data["recs"] = {
            ("movie", 1000): [rec(50, "Общий", va=7), rec(51, "Только первый"), rec(1001, "Уже смотрел"), rec(52, "Начатый"), rec(53, "Без постера", poster=False),
                              rec(54, "Мало голосов", votes=5), rec(55, "Ещё не вышел", date="2099-01-01"), dict(rec(57, "Для взрослых"), adult=True)],
            ("movie", 1001): [rec(50, "Общий"), rec(56, "Только второй")],
            ("tv", 3000): [rec(60, "Сериал для вас", kind="tv"), rec(61, "Сериал в будущем", kind="tv", date="2099-01-01")],
        }
        seeds = [{"kind": "movie", "id": 1000, "title": "Сага 1"}, {"kind": "movie", "id": 1001, "title": "Сага 2"}, {"kind": "tv", "id": 3000, "title": "Сериал"}]
        st, out = self.api("POST", "recommend", {"seeds": seeds, "exclude": [{"kind": "movie", "id": 52}]})
        self.assertEqual(st, 200)
        items = out["items"]
        ids = [(c["media_type"], c["id"]) for c in items]
        self.assertEqual(ids[0], ("movie", 50), "то, что рекомендуют сразу к двум просмотренным, стоит первым")
        self.assertEqual(set(ids), {("movie", 50), ("movie", 51), ("movie", 56), ("tv", 60)}, "контент для взрослых (57) в подборку не попадает")
        self.assertEqual(items[0]["because"], ["Сага 1", "Сага 2"], "по каким просмотренным попало")
        tv = [c for c in items if c["media_type"] == "tv"][0]
        self.assertEqual((tv["name"], tv["first_air_date"]), ("Сериал для вас", "2015-01-01"), "сериал в карточке как у TMDB")
        self.assertNotIn(("movie", 1001), ids, "просмотренное в подборку не попадает")

    def test_recommendations_input_is_validated_and_nothing_is_stored(self):
        self.assertEqual(self.api("POST", "recommend", {"seeds": "x"})[0], 400)
        self.assertEqual(self.api("POST", "recommend", {})[0], 400)
        self.assertEqual(self.api("POST", "recommend", {"seeds": []})[1], {"items": []})
        st, out = self.api("POST", "recommend", {"seeds": [{"kind": "book", "id": 1}, {"kind": "movie", "id": "abc"}, "мусор", {"kind": "movie", "id": -5}]})
        self.assertEqual((st, out), (200, {"items": []}), "мусор в списке не роняет запрос")
        self.assertEqual(self.lib.rows("SELECT name FROM sqlite_master WHERE name LIKE '%seed%' OR name LIKE '%watch%'"), [])

    def test_recommendations_use_only_the_freshest_seeds_and_respect_the_limit(self):
        self.world.data["recs"] = {("movie", 1000 + i): [self.rec(700 + i, f"Р{i}")] for i in range(60)}
        for i in range(60):
            self.world.data["movies"].setdefault(1000 + i, movie(1000 + i, f"М{i}", "2000-01-01", 100, 100))
        seeds = [{"kind": "movie", "id": 1000 + i, "title": f"М{i}"} for i in range(60)]
        out = self.lib.recommend(seeds, [])
        self.assertEqual(len(out), self.lib.REC_MAX_SEEDS, "по одному результату от каждого из 40 свежих")
        self.assertNotIn(700 + 59, [c["id"] for c in out], "остальные просмотренные не учитываются")
        self.assertEqual(len(self.lib.recommend(seeds, [], limit=5)), 5)

    def test_chosen_torrents_are_stored_per_user_and_replace_the_previous_choice(self):
        st, a = self.api("POST", "torrents", {"kind": "movie", "id": 550, "title": "Fight.Club.1080p", "MagnetUri": "magnet:?xt=urn:btih:AAA", "poster": "/p.jpg", "tracker": "rutor"})
        self.assertEqual((st, a["id"], a["kind"], a["MagnetUri"], a["tracker"]), (200, 550, "movie", "magnet:?xt=urn:btih:AAA", "rutor"))
        self.api("POST", "torrents", {"kind": "tv", "id": 550, "title": "Сериал", "Link": "https://t.example/file.torrent"})
        st, lst = self.api("GET", "torrents")
        self.assertEqual({(x["kind"], x["id"]) for x in lst["items"]}, {("movie", 550), ("tv", 550)}, "фильм и сериал с одним номером — разные записи")
        st, b = self.api("POST", "torrents", {"kind": "movie", "id": 550, "title": "Fight.Club.720p", "MagnetUri": "magnet:?xt=urn:btih:BBB"})
        items = {(x["kind"], x["id"]): x for x in self.api("GET", "torrents")[1]["items"]}
        self.assertEqual(items[("movie", 550)]["MagnetUri"], "magnet:?xt=urn:btih:BBB", "новый выбор заменяет прежний")
        self.assertEqual(len(items), 2)
        self.assertGreaterEqual(b["at"], a["at"])

    def test_chosen_torrents_validation_forget_and_isolation(self):
        self.assertEqual(self.api("POST", "torrents", {"kind": "movie", "id": 1})[0], 400, "без ссылки нечего запоминать")
        self.assertEqual(self.api("POST", "torrents", {"kind": "book", "id": 1, "MagnetUri": "m"})[0], 400)
        self.assertEqual(self.api("POST", "torrents", {"MagnetUri": "m"})[0], 400)
        long = self.api("POST", "torrents", {"kind": "movie", "id": 2, "title": "т" * 1000, "MagnetUri": "m" * 9000})[1]
        self.assertEqual((len(long["title"]), len(long["MagnetUri"])), (300, 4000), "длина ограничена")
        self.api("POST", "torrents", {"kind": "movie", "id": 3, "MagnetUri": "m3"})
        u2 = self.proxy.users.add_user("second@example.com"); t2 = self.proxy.users.issue_token(u2, "тв")
        self.assertEqual(self.api("GET", "torrents", token=t2)[1]["items"], [], "чужие выборы не видны")
        self.api("POST", "torrents", {"kind": "movie", "id": 3, "MagnetUri": "чужой"}, token=t2)
        self.assertEqual(self.api("GET", "torrents")[1]["items"][0]["MagnetUri"] in ("m3", "m" * 4000), True, "у владельца прежнее")
        st, r = self.api("POST", "torrents/forget", {"kind": "movie", "id": 3})
        self.assertEqual((st, r["deleted"]), (200, 1))
        self.assertEqual(self.api("POST", "torrents/forget", {})[0], 400)
        st, r = self.api("POST", "torrents/forget", {"all": True})
        self.assertEqual(r["deleted"], 1, "остался только фильм 2")
        self.assertEqual(len(self.api("GET", "torrents", token=t2)[1]["items"]), 1, "у второго пользователя всё на месте")

    def test_chosen_torrents_are_limited_per_user(self):
        old = lib.Library.CHOICES_MAX
        lib.Library.CHOICES_MAX = 3
        try:
            for i in range(1, 6):
                self.lib.choose(1, "movie", i, {"MagnetUri": f"m{i}"})
                time.sleep(0.002)
        finally:
            lib.Library.CHOICES_MAX = old
        ids = sorted(x["id"] for x in self.lib.choices(1))
        self.assertEqual(ids, [3, 4, 5], "остаются самые свежие")

    def test_franchise_list_carries_visible_member_ids_for_the_watching_order(self):
        fid = self.build("movie", 1000)
        st, lst = self.api("GET", "franchises")
        f = [x for x in lst["franchises"] if x["id"] == fid][0]
        d = self.detail(fid)
        want = sorted([c["media_type"], c["id"]] for g in d["groups"] for c in g["items"])
        self.assertEqual(sorted(f["members"]), want, "только видимые позиции")
        self.assertNotIn("members", self.api("GET", f"franchises/{fid}")[1], "в подробном ответе список лишний")

    def test_plugin_settings_are_stored_per_user_with_key_and_size_limits(self):
        st, r = self.api("POST", "settings", {"settings": {"tapokhub_fx_left": 7, "tapokhub_anim_crt": True, "tapokhub_token": "секрет", "tapokhub_torrents": "{}", "чужой_ключ": "1", "tapokhub_bad key": "1", "tapokhub_fx_top": "x" * 900}})
        self.assertEqual(st, 200)
        self.assertEqual(sorted(r["saved"]), ["tapokhub_anim_crt", "tapokhub_fx_left", "tapokhub_fx_top"], "токен, торренты и посторонние ключи не принимаются")
        got = self.api("GET", "settings")[1]["settings"]
        self.assertEqual(got["tapokhub_fx_left"]["value"], "7")
        self.assertEqual(len(got["tapokhub_fx_top"]["value"]), 500, "значение обрезано")
        self.api("POST", "settings", {"settings": {"tapokhub_fx_left": "9"}})
        self.assertEqual(self.api("GET", "settings")[1]["settings"]["tapokhub_fx_left"]["value"], "9", "новое значение заменяет прежнее")
        u2 = self.proxy.users.add_user("second@example.com"); t2 = self.proxy.users.issue_token(u2, "тв")
        self.assertEqual(self.api("GET", "settings", token=t2)[1]["settings"], {}, "у другого пользователя свои настройки")
        self.assertEqual(self.api("POST", "settings", {"settings": "не словарь"})[0], 400)
        self.assertEqual(self.api("POST", "settings", {})[0], 400)

    def test_dedupe_removes_the_same_collection_built_twice_and_keeps_the_oldest(self):
        a = self.build("movie", 1000)
        self.lib.store.conn().execute("UPDATE franchises SET user_id=1")
        # вторая копия: собрали от другого фильма той же франшизы под другим пользователем, потом слили
        u2 = self.proxy.users.add_user("second@example.com")
        st, f2 = self.api("POST", "franchises", {"kind": "movie", "id": 1000}, token=self.proxy.users.issue_token(u2, "тв"))
        self.assertTrue(self.lib.wait_idle(20))
        self.proxy.users.merge(u2, 1)
        ids = [r["id"] for r in self.lib.rows("SELECT id FROM franchises WHERE user_id=1 AND merged_into IS NULL AND status='ready'")]
        self.assertEqual(len(ids), 2, "после слияния коллекции две: одна и та же франшиза собрана дважды")
        self.assertEqual(self.lib.dedupe(1, dry=True), [(f2["id"], a)], "показывает дубль, но пока ничего не трогает")
        self.assertEqual(len(self.lib.rows("SELECT id FROM franchises")), 2)
        self.assertEqual(self.lib.dedupe(1), [(f2["id"], a)])
        self.assertEqual([r["id"] for r in self.lib.rows("SELECT id FROM franchises")], [a], "осталась старая")
        self.assertEqual(self.lib.rows("SELECT 1 FROM franchise_items WHERE franchise_id=?", f2["id"]), [], "состав дубля удалён")
        self.assertEqual(self.lib.dedupe(1), [], "повторный запуск ничего не находит")

    def test_dedupe_leaves_different_collections_alone(self):
        a = self.build("movie", 1000)
        b = self.build("movie", 9500)
        self.assertNotEqual(a, b)
        self.assertEqual(self.lib.dedupe(1), [])
        self.assertEqual(len(self.lib.rows("SELECT id FROM franchises")), 2)

    def test_stats_counts_distinct_visible_items_and_ready_collections(self):
        fid = self.build("movie", 1000)
        self.api("POST", "items/add", {"kind": "movie", "id": 1000})            # уже есть в коллекции: считается один раз
        self.api("POST", "items/add", {"kind": "tv", "id": 3001})               # отдельный сериал (в коллекции его нет или скрыт)
        d = self.detail(fid)
        movies = {c["id"] for g in d["groups"] for c in g["items"] if c["media_type"] == "movie"}
        tvs = {c["id"] for g in d["groups"] for c in g["items"] if c["media_type"] == "tv"} | {3001}
        st, s = self.api("GET", "stats")
        self.assertEqual(st, 200)
        self.assertEqual((s["movies"], s["tv"], s["collections"]), (len(movies), len(tvs), 1))
        self.assertEqual(sorted(s["ids"]["movie"]), sorted(movies))
        hidden = [c["id"] for g in self.detail(fid, hidden=True)["groups"] for c in g["items"] if c["hidden"]]
        self.assertTrue(hidden and not set(hidden) & set(s["ids"]["movie"]), "скрытое в счёт не идёт")

    def test_series_with_franchise_class_is_kept_even_when_big(self):
        self.world.data["wd"]["Q900"] = ("Большая сага", {"P31": ["Q196600"]})
        old = lib.CATALOGUE_MIN
        lib.CATALOGUE_MIN = 4
        try:
            fid = self.build("movie", 9000)
        finally:
            lib.CATALOGUE_MIN = old
        ids = {c["id"] for g in self.detail(fid, hidden=True)["groups"] for c in g["items"]}
        self.assertTrue({9000, 9001, 9100, 9105} <= ids, "медиафраншиза остаётся франшизой")

    def test_collection_name_is_cleaned(self):
        self.assertEqual(lib.clean_collection_name("101 далматинец (Коллекция мультфильмов)"), "101 далматинец")
        self.assertEqual(lib.clean_collection_name("Сага (Коллекция)"), "Сага")
        self.assertEqual(lib.clean_collection_name("Star Wars Collection"), "Star Wars")
        self.assertEqual(lib.clean_collection_name("Коллекция теней"), "Коллекция теней", "слово в начале названия не трогаем")

    def test_catalogue_check_applies_only_to_auto_resolved(self):
        self.assertTrue(lib.Library.is_catalogue("фильмы студии X", {}, "P179", 31))
        self.assertFalse(lib.Library.is_catalogue("Звёздные войны", {"P31": ["Q196600"]}, "P8345", 54))
        self.assertFalse(lib.Library.is_catalogue("Marvel", {"P31": ["Q196600"]}, "P179", 60))
        self.assertTrue(lib.Library.is_catalogue("Films by Studio", {}, "P8345", 20), "по названию хватает и половины порога")
        self.assertFalse(lib.Library.is_catalogue("Дилогия", {}, "P179", 3))

    def test_pick_logo_prefers_wide_wordmarks_then_language_then_rating(self):
        from tapokhub.libraries.tmdb_logos import pick_logo
        sq = {"iso_639_1": "ru", "file_path": "/ru_square.png", "width": 1916, "height": 1023, "vote_average": 9}
        en_wide = {"iso_639_1": "en", "file_path": "/en_wide.png", "width": 1275, "height": 499, "vote_average": 3}
        en_best = {"iso_639_1": "en", "file_path": "/en_best.png", "width": 1200, "height": 500, "vote_average": 7}
        ru_wide = {"iso_639_1": "ru", "file_path": "/ru_wide.png", "width": 1600, "height": 285, "vote_average": 1}
        self.assertEqual(pick_logo([sq, en_wide, en_best], "ru"), "/en_best.png", "русский квадратный мелкий: берём вытянутый английский, у него оценка выше")
        self.assertEqual(pick_logo([sq, en_best, ru_wide], "ru"), "/ru_wide.png", "есть вытянутый русский: он")
        self.assertEqual(pick_logo([sq], "ru"), "/ru_square.png", "вытянутых нет совсем: берём любой")
        self.assertIsNone(pick_logo([], "ru"))
        self.assertIsNone(pick_logo([{"iso_639_1": "ru"}], "ru"), "без файла нечего показывать")

    def test_composite_universe_does_not_borrow_logo_and_cover_of_its_first_part(self):
        # «Кинематографическая вселенная»: несколько коллекций, и название вселенной не связано ни с одной позицией
        fid = self.build()
        self.lib._set(fid, title="Кинематографическая вселенная Икс")
        self.lib.ensure_logo(fid, force=True)
        s = self.lib.franchise_summary(self.lib.franchise(fid))
        self.assertIsNone(s["logo"], "логотип части («Сага: Часть 2») не подписывает всю вселенную; остаётся текст названия")
        conn = self.lib.store.conn()
        card = json.loads(conn.execute("SELECT card FROM franchise_items WHERE franchise_id=? AND tmdb_id=2601", (fid,)).fetchone()[0])
        card.update(vote_average=9.4)
        conn.execute("UPDATE franchise_items SET card=? WHERE franchise_id=? AND tmdb_id=2601", (json.dumps(card), fid))
        self.assertEqual(self.lib.cover(fid)["backdrop_path"], card["backdrop_path"], "обложка: лучшая по рейтингу позиция, а не самая ранняя часть")
        self.assertNotEqual(card["backdrop_path"], "/backdrop001000.jpg")

    def test_franchise_named_like_its_parts_keeps_first_part_logo_and_cover(self):
        fid = self.build()                       # «Сага»: часть 1 называется «Сага: Часть 1», коллекций две
        self.lib.ensure_logo(fid, force=True)
        s = self.lib.franchise_summary(self.lib.franchise(fid))
        self.assertEqual(s["logo"], "/logoRU1001.png")
        self.assertEqual(s["cover"]["backdrop_path"], "/backdrop001000.jpg")

    def test_franchise_logo_absent_when_nobody_has_one(self):
        self.world.data["images"] = {}
        s = self.lib.franchise_summary(self.lib.franchise(self.build()))
        self.assertIsNone(s["logo"])
        self.assertIsNotNone(self.lib.franchise(1)["logo_checked"], "поиск был, повторно раньше чем через неделю не ищем")

    def test_logo_is_kept_and_not_refetched_within_a_week_but_rechecked_when_missing(self):
        fid = self.build()
        n = self.world.counts["tmdb"]
        self.lib.ensure_logo(fid)
        self.assertEqual(self.world.counts["tmdb"], n, "логотип уже найден: запросов нет")
        self.lib._set(fid, logo=None)                # потерялся: перепроверяем, не дожидаясь недели
        self.lib.ensure_logo(fid)
        self.assertEqual(self.lib.franchise(fid)["logo"], "/logoRU1001.png")

    def test_old_database_gets_logo_columns(self):
        c = self.lib.store.conn()
        c.execute("DROP TABLE franchises")
        c.execute("CREATE TABLE franchises(id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT NOT NULL, wikidata_id TEXT, wd_prop TEXT, root_kind TEXT NOT NULL, root_id INTEGER NOT NULL, status TEXT NOT NULL, busy INTEGER NOT NULL DEFAULT 0, error TEXT, choices TEXT, created_at INTEGER NOT NULL, resolved_at INTEGER, merged_into INTEGER)")
        lib.Library(self.proxy)
        cols = {r["name"] for r in c.execute("PRAGMA table_info(franchises)")}
        self.assertTrue({"logo", "logo_checked"} <= cols, "колонки добавлены к уже существующей таблице")

    def test_group_order_and_titles(self):
        d = self.detail(self.build())
        keys = [x["key"] for x in d["groups"]]
        self.assertEqual(keys[0], "collection:500", "группы коллекции идут первыми")
        self.assertEqual(keys, sorted(keys, key=lambda k: (0 if k.startswith("collection") else lib.GROUP_ORDER[k])))
        titles = {x["key"]: x["title"] for x in d["groups"]}
        self.assertEqual(titles["collection:500"], "Сага", "«(Коллекция)» из названия убрано")
        self.assertEqual(titles["films"], "Другие фильмы")
        self.assertEqual(titles["series"], "Сериалы")
        self.assertEqual(titles["animation"], "Мультсериалы")
        self.assertEqual(titles["upcoming"], "Скоро")

    def test_junk_goes_to_hidden_other_group(self):
        fid = self.build()
        normal = self.by_group(self.detail(fid))
        self.assertNotIn("other", normal, "в обычном режиме «Прочее» не видно")
        full = self.detail(fid, hidden=True)
        other = [g for g in full["groups"] if g["key"] == "other"][0]
        self.assertEqual({c["id"] for c in other["items"]}, {2001, 2002, 3002, 2500, 2501}, "короткая, малоголосная, фанатский сериал и ролики из коллекции-мусора")
        self.assertTrue(all(c["hidden"] and c["hidden_by"] == "auto" for c in other["items"]))
        self.assertEqual(full["counts"]["hidden"], 5)

    def test_duplicates_and_missing_tmdb_data_dropped(self):
        d = self.detail(self.build(), hidden=True)
        ids = {c["id"] for g in d["groups"] for c in g["items"]}
        self.assertNotIn(2003, ids, "дубль с меньшим числом голосов")
        self.assertIn(2004, ids)
        self.assertNotIn(2200, ids, "TMDB про неё ничего не знает")

    def test_upcoming_by_status_and_by_future_date(self):
        g = self.by_group(self.detail(self.build()))
        self.assertEqual(sorted(g["upcoming"]), [2100, 3003], "и по будущей дате, и по статусу «в производстве» без даты")

    def test_upcoming_flips_to_released_when_date_passes(self):
        self.lib.today = lambda: "2100-01-01"
        fid = self.build()
        g = self.by_group(self.detail(fid))
        self.assertNotIn(2100, g.get("upcoming", []), "дата прошла, но статус Post Production: считается ещё выходящим")
        # статус «Released» и дата в прошлом -> обычный фильм/«прочее»
        self.assertIn(2100, [c["id"] for gg in self.detail(fid, hidden=True)["groups"] for c in gg["items"]])

    def test_cards_are_lampa_ready(self):
        d = self.detail(self.build())
        c = [x for g in d["groups"] for x in g["items"] if x["id"] == 1000][0]
        self.assertEqual((c["media_type"], c["title"], c["release_date"]), ("movie", "Сага: Часть 1", "2001-05-01"))
        self.assertTrue(c["poster_path"].startswith("/poster"))
        self.assertLessEqual(len(c["overview"]), 300, "описание урезано")
        t = [x for g in d["groups"] for x in g["items"] if x["id"] == 3000][0]
        self.assertEqual((t["media_type"], t["name"], t["first_air_date"], t["seasons"]), ("tv", "Сага: Сериал", "2019-11-12", 2))

    def test_root_is_never_auto_hidden(self):
        self.world.data["movies"][1000].update(runtime=20, vote_count=3)
        self.world.data["movies"][1000].pop("belongs_to_collection")
        self.world.data["collections"][500] = [1001, 1002]
        fid = self.build()
        full = self.detail(fid, hidden=True)
        item = [c for g in full["groups"] for c in g["items"] if c["id"] == 1000][0]
        self.assertFalse(item["hidden"], "позицию, от которой создали коллекцию, не прячем")

    def test_adult_items_are_auto_hidden_by_flag_and_keywords(self):
        self.world.data["movies"][1002]["adult"] = True                                                     # признак TMDB
        self.world.data["movies"][1001]["keywords"] = {"keywords": [{"id": 155477, "name": "softcore"}]}    # эротика по ключевому слову
        self.world.data["tv"][3000]["keywords"] = {"results": [{"id": 10053, "name": "sexploitation"}]}     # у сериалов ключевые слова в results
        fid = self.build()
        self.assertNotIn(1001, {c["id"] for g in self.detail(fid)["groups"] for c in g["items"]})
        self.assertNotIn(1002, {c["id"] for g in self.detail(fid)["groups"] for c in g["items"]})
        self.assertNotIn(3000, {c["id"] for g in self.detail(fid)["groups"] for c in g["items"]}, "в обычном режиме не видно")
        other = [g for g in self.detail(fid, hidden=True)["groups"] if g["key"] == "other"][0]
        self.assertTrue({1001, 1002, 3000} <= {c["id"] for c in other["items"]}, "в режиме настройки видно в «Прочее»")
        self.assertTrue(all(c["hidden"] and c["hidden_by"] == "auto" for c in other["items"] if c["id"] in (1001, 1002, 3000)))
        self.assertIn(1000, {c["id"] for g in self.detail(fid)["groups"] for c in g["items"]}, "обычные части на месте")

    def test_broad_keywords_do_not_hide_normal_films(self):
        self.world.data["movies"][1001]["keywords"] = {"keywords": [{"id": 281741, "name": "nudity"}, {"id": 1, "name": "x"}]}
        fid = self.build()
        self.assertIn(1001, {c["id"] for g in self.detail(fid)["groups"] for c in g["items"]}, "«nudity» бывает у обычных фильмов")

    def test_adult_root_is_still_hidden_and_user_can_bring_it_back(self):
        self.world.data["movies"][1000]["adult"] = True
        fid = self.build()
        item = [c for g in self.detail(fid, hidden=True)["groups"] for c in g["items"] if c["id"] == 1000][0]
        self.assertTrue(item["hidden"], "исключение относится и к позиции, от которой создали коллекцию")
        self.assertTrue(self.lib.hide(fid, "movie", 1000, False), "вернуть вручную можно")
        self.lib.enqueue(fid); self.assertTrue(self.lib.wait_idle(10))
        item = [c for g in self.detail(fid, hidden=True)["groups"] for c in g["items"] if c["id"] == 1000][0]
        self.assertFalse(item["hidden"], "выбор пользователя сильнее автоматики и переживает обновление")

    def test_adult_details_request_asks_for_keywords(self):
        seen = []
        real = self.lib.tmdb
        self.lib.tmdb = lambda path, extra=None: (seen.append((path, extra)), real(path, extra))[1]
        self.lib.details("movie", 1000)
        self.assertIn(("movie/1000", [("append_to_response", "keywords")]), seen)

    def test_first_build_has_no_new_marks_or_events(self):
        fid = self.build()
        d = self.detail(fid, hidden=True)
        self.assertEqual(d["counts"]["new"], 0)
        events = self.lib.rows("SELECT type FROM lib_events")
        self.assertEqual([e["type"] for e in events], ["created"])


class FromOtherMember(Base):
    def test_creating_from_known_member_returns_same_franchise_without_new_work(self):
        fid = self.build("movie", 1000)
        wd_before = self.world.counts["wd"]
        f2 = self.lib.create("tv", 3000)
        self.assertEqual(f2["id"], fid)
        self.assertTrue(self.lib.wait_idle(5))
        self.assertEqual(self.world.counts["wd"], wd_before)

    def test_creating_from_unlisted_member_merges_into_existing(self):
        fid = self.build("movie", 1000)
        fid2 = self.build("movie", 7000)         # Q700 указывает на ту же франшизу Q1, но в участниках её нет
        self.assertNotEqual(fid, fid2)
        d2 = self.lib.franchise_detail(fid2)
        self.assertEqual(d2["merged_into"], fid)
        self.assertEqual(d2["status"], "merged")
        ids = {c["id"] for g in self.detail(fid, hidden=True)["groups"] for c in g["items"]}
        self.assertIn(7000, ids, "позиция, от которой пришли, оказалась в общей франшизе")
        self.assertEqual(len(self.lib.rows("SELECT id FROM franchises WHERE merged_into IS NULL")), 1)


class Fallbacks(Base):
    def test_tmdb_collection_only_when_no_wikidata(self):
        self.world.data["movies"][5000] = movie(5000, "Одиночка 1", "2000-01-01", 100, 800, coll=(600, "Одиночка (Коллекция)"))
        self.world.data["movies"][5001] = movie(5001, "Одиночка 2", "2004-01-01", 100, 700, coll=(600, "Одиночка (Коллекция)"))
        self.world.data["collections"][600] = [5001, 5000]
        fid = self.build("movie", 5000)
        d = self.detail(fid)
        self.assertEqual(self.by_group(d), {"collection:600": [5000, 5001]})
        self.assertEqual(d["title"], "Одиночка", "название франшизы = название коллекции TMDB")

    def test_single_film_without_anything_still_builds(self):
        self.world.data["movies"][6000] = movie(6000, "Совсем один", "2010-01-01", 95, 400)
        d = self.detail(self.build("movie", 6000))
        self.assertEqual(d["status"], "ready")
        self.assertEqual(self.by_group(d), {"films": [6000]})
        self.assertEqual(d["groups"][0]["title"], "Фильмы", "без коллекций группа называется просто «Фильмы»")

    def test_unknown_to_tmdb_gives_readable_error(self):
        fid = self.build("movie", 424242)
        d = self.lib.franchise_summary(self.lib.franchise(fid))
        self.assertEqual(d["status"], "error")
        self.assertIn("TMDB", d["error"])

    def test_multiple_franchises_ask_user_to_choose_then_build(self):
        self.world.data["movies"][4000] = movie(4000, "Пересечение", "2011-01-01", 100, 500)
        self.world.data["external"][("movie", 4000)] = "Q400"
        self.world.data["wd"]["Q400"] = ("Пересечение", {"P8345": ["Q1", "Q2"], "P4947": ["4000"]})
        self.world.data["movies"][4001] = movie(4001, "Другая сага 1", "2013-01-01", 100, 500)
        self.world.data["wd"]["Q410"] = ("Другая 1", {"P8345": ["Q2"], "P4947": ["4001"]})
        fid = self.build("movie", 4000)
        s = self.lib.franchise_summary(self.lib.franchise(fid))
        self.assertEqual(s["status"], "needs_choice")
        self.assertEqual({c["wikidata"] for c in s["choices"]}, {"Q1", "Q2"})
        self.assertEqual({c["title"] for c in s["choices"]}, {"Сага", "Другая сага"})
        self.lib.create("movie", 4000, wikidata="Q2")
        self.assertTrue(self.lib.wait_idle(20))
        d = self.detail(fid)
        self.assertEqual((d["status"], d["title"]), ("ready", "Другая сага"))
        self.assertEqual(sorted(i for g in self.by_group(d).values() for i in g), [4000, 4001])

    def test_wikidata_rate_limit_is_retried(self):
        self.world.wd_429 = 2
        d = self.detail(self.build())
        self.assertEqual(d["status"], "ready")
        self.assertGreaterEqual(self.world.counts["wd"], 4, "два 429 и успешные повторы")

    def test_wikidata_down_on_first_build_is_error_then_retry_works(self):
        self.world.wd_429 = 999
        fid = self.build()
        s = self.lib.franchise_summary(self.lib.franchise(fid))
        self.assertEqual(s["status"], "error")
        self.assertIn("wikidata", s["error"].lower())
        self.world.wd_429 = 0
        fid2 = self.build()                      # повторное нажатие «Создать коллекцию»
        self.assertEqual(fid2, fid)
        self.assertEqual(self.lib.franchise_summary(self.lib.franchise(fid))["status"], "ready")

    def test_wikidata_down_on_refresh_keeps_data(self):
        fid = self.build()
        # сбросить кеш Wikidata, чтобы обновление реально пошло в сеть
        self.lib.store.conn().execute("DELETE FROM wd_cache")
        self.world.wd_429 = 999
        self.lib.enqueue(fid)
        self.assertTrue(self.lib.wait_idle(20))
        s = self.lib.franchise_summary(self.lib.franchise(fid))
        self.assertEqual(s["status"], "ready", "собранная франшиза остаётся рабочей")
        self.assertTrue(s["error"])
        self.assertGreater(self.detail(fid)["counts"]["visible"], 0)

    def test_wikidata_responses_are_cached(self):
        fid = self.build()
        n = self.world.counts["wd"]
        self.lib.enqueue(fid)
        self.assertTrue(self.lib.wait_idle(20))
        self.assertEqual(self.world.counts["wd"], n, "повторная сборка не должна ходить в Wikidata")


class Tracking(Base):
    def test_new_member_is_marked_new_with_event(self):
        fid = self.build()
        self.world.data["movies"][2300] = movie(2300, "Сага: Новое", "2026-09-01", 120, 400)
        self.world.data["wd"]["Q230"] = ("Новое", {"P8345": ["Q1"], "P4947": ["2300"]})
        self.lib.store.conn().execute("DELETE FROM wd_cache")
        self.lib.store.conn().execute("DELETE FROM api_cache")
        self.lib.enqueue(fid)
        self.assertTrue(self.lib.wait_idle(20))
        d = self.detail(fid)
        item = [c for g in d["groups"] for c in g["items"] if c["id"] == 2300][0]
        self.assertTrue(item["is_new"])
        self.assertEqual(d["counts"]["new"], 1)
        ev = [e for e in self.lib.rows("SELECT * FROM lib_events WHERE type='new_item'")]
        self.assertEqual([(e["tmdb_id"], e["title"]) for e in ev], [(2300, "Сага: Новое")])

    def test_new_junk_item_is_silent(self):
        fid = self.build()
        self.world.data["movies"][2301] = movie(2301, "Сага: Клип", "2026-08-01", 3, 5)
        self.world.data["wd"]["Q231"] = ("Клип", {"P8345": ["Q1"], "P4947": ["2301"]})
        self.lib.store.conn().execute("DELETE FROM wd_cache")
        self.lib.store.conn().execute("DELETE FROM api_cache")
        self.lib.enqueue(fid)
        self.assertTrue(self.lib.wait_idle(20))
        self.assertEqual(self.lib.rows("SELECT 1 FROM lib_events WHERE type='new_item'"), [])
        self.assertEqual(self.detail(fid)["counts"]["new"], 0)

    def test_new_season_event(self):
        fid = self.build()
        self.world.data["tv"][3000]["number_of_seasons"] = 3
        self.lib.store.conn().execute("DELETE FROM api_cache")
        self.lib.enqueue(fid)
        self.assertTrue(self.lib.wait_idle(20))
        ev = self.lib.rows("SELECT * FROM lib_events WHERE type='new_season'")
        self.assertEqual([(e["tmdb_id"], e["title"]) for e in ev], [(3000, "Сага: Сериал: сезон 3")])
        item = [c for g in self.detail(fid)["groups"] for c in g["items"] if c["id"] == 3000][0]
        self.assertTrue(item["is_new"])
        self.assertEqual(item["seasons"], 3)

    def test_no_repeat_event_without_changes(self):
        fid = self.build()
        for _ in range(2):
            self.lib.store.conn().execute("DELETE FROM api_cache")
            self.lib.enqueue(fid)
            self.assertTrue(self.lib.wait_idle(20))
        self.assertEqual([e["type"] for e in self.lib.rows("SELECT type FROM lib_events")], ["created"])

    def test_new_mark_expires_after_14_days(self):
        fid = self.build()
        self.world.data["tv"][3000]["number_of_seasons"] = 3
        self.lib.store.conn().execute("DELETE FROM api_cache")
        self.lib.enqueue(fid)
        self.assertTrue(self.lib.wait_idle(20))
        self.lib.store.conn().execute("UPDATE franchise_items SET new_until = new_until - ?", (15 * lib.DAY,))
        item = [c for g in self.detail(fid)["groups"] for c in g["items"] if c["id"] == 3000][0]
        self.assertFalse(item["is_new"])

    def test_refresh_all_only_touches_stale_franchises(self):
        fid = self.build()
        self.assertEqual(self.lib.refresh_all(), 0, "только что собрана")
        self.lib.store.conn().execute("UPDATE franchises SET resolved_at = resolved_at - ?", (30 * 3600,))
        self.assertEqual(self.lib.refresh_all(), 1)
        self.assertTrue(self.lib.wait_idle(20))


class UserEdits(Base):
    def test_user_hide_and_unhide_survive_refresh(self):
        fid = self.build()
        self.assertTrue(self.lib.hide(fid, "tv", 3000, True))         # спрятал нужное
        self.assertTrue(self.lib.hide(fid, "movie", 2001, False))     # вернул автоматически скрытое
        self.lib.store.conn().execute("DELETE FROM api_cache")
        self.lib.enqueue(fid)
        self.assertTrue(self.lib.wait_idle(20))
        full = self.detail(fid, hidden=True)
        flat = {c["id"]: c for g in full["groups"] for c in g["items"]}
        self.assertTrue(flat[3000]["hidden"] and flat[3000]["hidden_by"] == "user")
        self.assertFalse(flat[2001]["hidden"], "выбор пользователя сильнее автоматики")
        visible = {i for g in self.by_group(self.detail(fid)).values() for i in g}
        self.assertNotIn(3000, visible)
        self.assertIn(2001, visible)

    def test_hiding_removes_new_mark(self):
        fid = self.build()
        self.world.data["tv"][3000]["number_of_seasons"] = 3
        self.lib.store.conn().execute("DELETE FROM api_cache")
        self.lib.enqueue(fid)
        self.assertTrue(self.lib.wait_idle(20))
        self.lib.hide(fid, "tv", 3000, True)
        self.assertEqual(self.detail(fid)["counts"]["new"], 0)

    def test_hide_unknown_item_reports_false(self):
        fid = self.build()
        self.assertFalse(self.lib.hide(fid, "movie", 999999, True))

    def test_manual_add_survives_refresh_and_can_be_removed(self):
        fid = self.build()
        self.world.data["movies"][8000] = movie(8000, "Сага: Найденное вручную", "2018-01-01", 100, 300)
        self.assertTrue(self.lib.add_item(fid, "movie", 8000))
        self.lib.store.conn().execute("DELETE FROM api_cache")
        self.lib.enqueue(fid)
        self.assertTrue(self.lib.wait_idle(20))
        item = [c for g in self.detail(fid)["groups"] for c in g["items"] if c["id"] == 8000][0]
        self.assertEqual((item["source"], item["hidden"]), ("manual", False))
        self.assertFalse(self.lib.remove_manual(fid, "movie", 2000), "не ручную позицию удалять нельзя: её можно только скрыть")
        self.assertTrue(self.lib.remove_manual(fid, "movie", 8000))
        self.assertNotIn(8000, {c["id"] for g in self.detail(fid, hidden=True)["groups"] for c in g["items"]})

    def test_manual_add_of_junk_is_visible_not_hidden(self):
        fid = self.build()
        self.world.data["movies"][8001] = movie(8001, "Сага: Короткометражка", "2018-01-01", 15, 5)
        self.assertTrue(self.lib.add_item(fid, "movie", 8001))
        item = [c for g in self.detail(fid)["groups"] for c in g["items"] if c["id"] == 8001][0]
        self.assertFalse(item["hidden"], "добавили руками: значит нужно")

    def test_manual_add_of_adult_is_visible_but_automatic_add_is_hidden(self):
        fid = self.build()
        self.world.data["movies"][8101] = dict(movie(8101, "Сага: Эротика", "2012-01-01", 100, 900), adult=True)
        self.world.data["movies"][8102] = dict(movie(8102, "Сага: Эротика 2", "2013-01-01", 100, 900), adult=True)
        self.assertTrue(self.lib.add_item(fid, "movie", 8101))
        item = [c for g in self.detail(fid)["groups"] for c in g["items"] if c["id"] == 8101][0]
        self.assertFalse(item["hidden"], "выбрали руками: значит нужно")
        self.assertTrue(self.lib.add_item(fid, "movie", 8102, manual=False))
        self.assertNotIn(8102, [c["id"] for g in self.detail(fid)["groups"] for c in g["items"]], "автоматически добавленное скрыто")
        full = [c for g in self.detail(fid, hidden=True)["groups"] for c in g["items"] if c["id"] == 8102][0]
        self.assertEqual((full["hidden"], full["hidden_by"]), (True, "auto"))

    def test_manual_add_into_collection_group(self):
        fid = self.build()
        self.world.data["movies"][8002] = movie(8002, "Сага: Часть 4", "2010-01-01", 110, 900, coll=(500, "Сага (Коллекция)"))
        self.assertTrue(self.lib.add_item(fid, "movie", 8002))
        self.assertEqual(self.by_group(self.detail(fid))["collection:500"], [1000, 1001, 1002, 8002], "по дате выхода: 2001, 2003, 2005, 2010")

    def test_manual_add_unknown_to_tmdb_fails(self):
        self.assertFalse(self.lib.add_item(self.build(), "movie", 424242))

    def test_manual_add_restores_hidden_item(self):
        fid = self.build()
        self.lib.hide(fid, "tv", 3000, True)
        self.assertTrue(self.lib.add_item(fid, "tv", 3000))
        item = [c for g in self.detail(fid)["groups"] for c in g["items"] if c["id"] == 3000][0]
        self.assertFalse(item["hidden"])


class Api(Base):
    def test_status_and_single_items(self):
        s, o = self.api("GET", "status?kind=movie&id=1000")
        self.assertEqual((s, o["in_library"], o["franchise"]), (200, False, None))
        s, o = self.api("POST", "items/add", {"kind": "movie", "id": 1000})
        self.assertEqual((s, o["in_library"]), (200, True))
        s, o = self.api("POST", "items/add", {"kind": "movie", "id": 1000})
        self.assertTrue(o["in_library"], "повторное добавление безопасно")
        s, o = self.api("GET", "items")
        self.assertEqual([(c["media_type"], c["id"], c["title"]) for c in o["items"]], [("movie", 1000, "Сага: Часть 1")])
        s, o = self.api("POST", "items/remove", {"kind": "movie", "id": 1000})
        self.assertFalse(o["in_library"])
        self.assertEqual(self.api("GET", "items")[1]["items"], [])

    def test_library_items_carry_group_for_cartoons_anime_manga_and_documentaries(self):
        d = self.world.data
        d["movies"][9001] = dict(movie(9001, "Мультфильм", "2010-01-01", 90, 900, genres=(16, 35)))                                     # анимация не японская
        d["movies"][9002] = dict(movie(9002, "Японский мультфильм", "2010-01-01", 90, 900, genres=(16,)), original_language="ja")      # японская анимация
        d["movies"][9003] = dict(movie(9003, "Игровая экранизация манги", "2012-01-01", 120, 900, genres=(28,)),
                                 keywords={"keywords": [{"id": 13141, "name": "based on manga"}]})                                     # живые актёры, но манга
        d["movies"][9004] = dict(movie(9004, "Документалка", "2015-01-01", 100, 900, genres=(99,)))
        d["movies"][9005] = dict(movie(9005, "Аниме по ключевому слову", "2011-01-01", 90, 900, genres=(16,)), keywords={"keywords": [{"id": 210024}]})
        d["tv"][9101] = dict(tv(9101, "Мультсериал", "2000-01-01", 500, genres=(16, 35)))
        d["tv"][9102] = dict(tv(9102, "Аниме-сериал", "2005-01-01", 500, genres=(16, 10759)), original_language="ja", keywords={"results": [{"id": 210024}]})
        for kind, tid in (("movie", 1000), ("movie", 9001), ("movie", 9002), ("movie", 9003), ("movie", 9004), ("movie", 9005), ("tv", 3000), ("tv", 9101), ("tv", 9102)):
            self.api("POST", "items/add", {"kind": kind, "id": tid})
        s, o = self.api("GET", "items")
        got = {(c["media_type"], c["id"]): c["group"] for c in o["items"]}
        self.assertEqual(got, {("movie", 1000): "movie", ("movie", 9001): "cartoon_movie", ("movie", 9002): "anime", ("movie", 9003): "anime",
                               ("movie", 9004): "docs", ("movie", 9005): "anime", ("tv", 3000): "tv", ("tv", 9101): "cartoon_tv", ("tv", 9102): "anime"})

    def test_add_unknown_or_bad_input(self):
        self.assertEqual(self.api("POST", "items/add", {"kind": "movie", "id": 424242})[0], 404)
        self.assertEqual(self.api("POST", "items/add", {"kind": "book", "id": 1})[0], 400)
        self.assertEqual(self.api("POST", "items/add", {"kind": "movie"})[0], 400)
        self.assertEqual(self.api("POST", "items/add", {"kind": "movie", "id": -5})[0], 400)
        self.assertEqual(self.api("GET", "status?kind=tv")[0], 400)

    def test_franchise_lifecycle_over_http(self):
        s, o = self.api("POST", "franchises", {"kind": "movie", "id": 1000})
        self.assertEqual(s, 200)
        self.assertIn(o["status"], ("pending", "resolving", "ready"))
        fid = o["id"]
        self.assertTrue(self.lib.wait_idle(20))
        s, o = self.api("GET", f"franchises/{fid}")
        self.assertEqual((s, o["status"], o["title"]), (200, "ready", "Сага"))
        self.assertNotIn("other", [g["key"] for g in o["groups"]])
        s, o = self.api("GET", f"franchises/{fid}?hidden=1")
        self.assertIn("other", [g["key"] for g in o["groups"]])
        s, st = self.api("GET", "status?kind=tv&id=3000")
        self.assertEqual(st["franchise"]["id"], fid, "любая позиция франшизы знает, в какой она коллекции")
        s, lst = self.api("GET", "franchises")
        self.assertEqual([f["id"] for f in lst["franchises"]], [fid])
        s, o = self.api("POST", f"franchises/{fid}/hide", {"kind": "movie", "id": 2000, "hidden": True})
        self.assertEqual(s, 200)
        flat = {c["id"]: c for g in o["groups"] for c in g["items"]}
        self.assertTrue(flat[2000]["hidden"], "ответ сразу отражает правку (в режиме настройки)")
        s, o = self.api("POST", f"franchises/{fid}/hide", {"kind": "movie", "id": 999999, "hidden": True})
        self.assertEqual(s, 404)
        s, o = self.api("POST", f"franchises/{fid}/refresh")
        self.assertEqual(s, 200)
        self.assertTrue(self.lib.wait_idle(20))
        s, o = self.api("POST", f"franchises/{fid}/delete")
        self.assertEqual((s, o), (200, {"deleted": fid}))
        self.assertEqual(self.api("GET", f"franchises/{fid}")[0], 404)
        self.assertEqual(self.lib.rows("SELECT 1 FROM franchise_items"), [])
        self.assertEqual(self.lib.rows("SELECT 1 FROM lib_events"), [], "события удалённой франшизы не висят")

    def test_status_of_pending_franchise_by_root(self):
        self.world.wd_429 = 0
        s, o = self.api("POST", "franchises", {"kind": "movie", "id": 1000})
        s, st = self.api("GET", "status?kind=movie&id=1000")
        self.assertIsNotNone(st["franchise"])
        self.assertTrue(self.lib.wait_idle(20))

    def test_manual_add_and_search_over_http(self):
        fid = self.build()
        self.world.data["movies"][8000] = movie(8000, "Сага: Найденное вручную", "2018-01-01", 100, 300)
        self.world.data["search"] = [
            {"media_type": "movie", **self.world.data["movies"][8000]},
            {"media_type": "person", "id": 1, "name": "Актёр"},
            {"media_type": "tv", **self.world.data["tv"][3001]},
            {"media_type": "movie", "adult": True, **self.world.data["movies"][8000], "id": 8999},
        ]
        s, o = self.api("GET", "search?query=" + urllib.parse.quote("сага"))
        self.assertEqual(s, 200)
        self.assertEqual([(c["media_type"], c["id"]) for c in o["results"]], [("movie", 8000), ("tv", 3001)], "люди и контент для взрослых отфильтрованы")
        self.assertEqual(self.api("GET", "search")[0], 400)
        s, o = self.api("POST", f"franchises/{fid}/add", {"kind": "movie", "id": 8000})
        self.assertEqual(s, 200)
        self.assertIn(8000, {c["id"] for g in o["groups"] for c in g["items"]})
        s, o = self.api("POST", f"franchises/{fid}/item-remove", {"kind": "movie", "id": 8000})
        self.assertEqual(s, 200)
        self.assertNotIn(8000, {c["id"] for g in o["groups"] for c in g["items"]})

    def test_events_feed_and_seen(self):
        fid = self.build()
        s, o = self.api("GET", "events")
        self.assertEqual([e["type"] for e in o["events"]], ["created"])
        eid = o["events"][0]["id"]
        self.assertEqual(self.api("POST", "events/seen", {"ids": [eid]})[0], 200)
        self.assertEqual(self.api("GET", "events")[1]["events"], [])

    def test_choose_over_http(self):
        self.world.data["movies"][4000] = movie(4000, "Пересечение", "2011-01-01", 100, 500)
        self.world.data["external"][("movie", 4000)] = "Q400"
        self.world.data["wd"]["Q400"] = ("Пересечение", {"P8345": ["Q1", "Q2"], "P4947": ["4000"]})
        fid = self.build("movie", 4000)
        s, o = self.api("GET", f"franchises/{fid}")
        self.assertEqual(o["status"], "needs_choice")
        s, o = self.api("POST", f"franchises/{fid}/choose", {"wikidata": "Q1"})
        self.assertEqual(s, 200)
        self.assertTrue(self.lib.wait_idle(20))
        self.assertEqual(self.api("GET", f"franchises/{fid}")[1]["title"], "Сага")

    def test_token_cors_and_limits(self):
        self.assertEqual(self.api("GET", "items", token="wrongtoken")[0], 404)
        self.assertEqual(self.api("POST", "items/add", {"kind": "movie", "id": 1000}, token="wrongtoken")[0], 404)
        self.assertEqual(self.api("POST", "items/add", raw=b"{not json")[0], 400)
        self.assertEqual(self.api("POST", "items/add", raw=b"[1,2]")[0], 400)
        self.assertEqual(self.api("GET", "nope")[0], 404)
        self.assertEqual(self.api("POST", "items/add", raw=b"x" * (70 * 1024))[0], 413)
        c = http.client.HTTPConnection("127.0.0.1", self.port, timeout=10)
        c.request("OPTIONS", f"/tmdb/{TOKEN}/lib/items/add")
        r = c.getresponse()
        r.read()
        self.assertEqual(r.status, 204)
        self.assertIn("POST", r.getheader("Access-Control-Allow-Methods"))
        self.assertEqual(r.getheader("Access-Control-Allow-Origin"), "*")

    def test_responses_are_never_cached(self):
        c = http.client.HTTPConnection("127.0.0.1", self.port, timeout=10)
        c.request("GET", f"/tmdb/{TOKEN}/lib/items")
        r = c.getresponse()
        r.read()
        self.assertEqual(r.getheader("Cache-Control"), "no-store")


class Persistence(Base):
    def test_unfinished_franchise_is_resumed_after_restart(self):
        self.lib.store.conn().execute(
            "INSERT INTO franchises(title,root_kind,root_id,status,created_at) VALUES('…','movie',1000,'resolving',?)", (int(time.time()),))
        lib2 = lib.Library(self.proxy)
        lib2.today = lambda: TODAY
        lib2.start()
        self.assertTrue(lib2.wait_idle(20))
        self.assertEqual(lib2.rows("SELECT status FROM franchises")[0]["status"], "ready")

    def test_data_survives_a_new_service_instance(self):
        fid = self.build()
        self.api("POST", "items/add", {"kind": "movie", "id": 1000})
        server2, proxy2 = create_server(Config(**{**self.cfg.__dict__}))
        try:
            self.assertEqual(proxy2.library.franchise_detail(fid)["title"], "Сага")
            self.assertEqual(len(proxy2.library.library_cards()), 1)
        finally:
            server2.server_close()


class MultiUser(Base):
    """У каждого пользователя своя библиотека; чужое не видно и не правится."""

    def setUp(self):
        super().setUp()
        self.u2 = self.proxy.users.add_user("second@example.com", "Второй")
        self.tok2 = self.proxy.users.issue_token(self.u2, "ТВ")

    def as_user(self, token, method, path, body=None):
        return self.api(method, path, body, token=token)

    def test_franchises_and_single_items_are_separate(self):
        fid = self.build("movie", 1000)
        self.api("POST", "items/add", {"kind": "movie", "id": 2000})
        st, mine = self.as_user(self.tok2, "GET", "franchises")
        self.assertEqual((st, mine["franchises"]), (200, []), "у второго ничего нет")
        self.assertEqual(self.as_user(self.tok2, "GET", "items")[1]["items"], [])
        self.assertEqual(self.as_user(self.tok2, "GET", "stats")[1]["movies"], 0)
        self.assertEqual(self.as_user(self.tok2, "GET", "status?kind=movie&id=1000")[1], {"in_library": False, "franchise": None})
        st, owner = self.api("GET", "franchises")
        self.assertEqual([f["id"] for f in owner["franchises"]], [fid], "у владельца прежнее")

    def test_registration_switch_over_http_is_for_the_owner_only(self):
        self.assertEqual(self.api("GET", "registration"), (200, {"admin": True, "open": False}), "без решения владельца регистрация закрыта")
        self.proxy.users.set_registration(True)
        self.assertEqual(self.api("GET", "registration"), (200, {"admin": True, "open": True}))
        self.assertEqual(self.as_user(self.tok2, "GET", "registration"), (200, {"admin": False}))
        self.assertEqual(self.as_user(self.tok2, "POST", "registration", {"open": False})[0], 403)
        self.assertTrue(self.proxy.users.registration_open())
        self.assertEqual(self.api("POST", "registration", {"open": False}), (200, {"admin": True, "open": False}))
        self.assertFalse(self.proxy.users.registration_open())

    def test_the_same_movie_builds_a_separate_franchise_for_each_user(self):
        fid1 = self.build("movie", 1000)
        st, f2 = self.as_user(self.tok2, "POST", "franchises", {"kind": "movie", "id": 1000})
        self.assertEqual(st, 200)
        self.assertNotEqual(f2["id"], fid1, "чужую коллекцию не отдаём, собирается своя")
        self.assertTrue(self.lib.wait_idle(20))
        self.assertEqual(self.lib.franchise(f2["id"])["user_id"], self.u2)
        self.assertEqual(self.lib.franchise(fid1)["user_id"], 1)
        self.assertEqual(self.as_user(self.tok2, "GET", "franchises")[1]["franchises"][0]["id"], f2["id"])
        self.assertEqual(len(self.api("GET", "franchises")[1]["franchises"]), 1)

    def test_other_users_franchise_is_invisible_and_not_editable(self):
        fid = self.build("movie", 1000)
        for method, path, body in [("GET", f"franchises/{fid}", None), ("GET", f"franchises/{fid}?hidden=1", None),
                                   ("POST", f"franchises/{fid}/hide", {"kind": "movie", "id": 1000, "hidden": True}),
                                   ("POST", f"franchises/{fid}/add", {"kind": "movie", "id": 2000, "scope": "item"}),
                                   ("POST", f"franchises/{fid}/add-options", {"kind": "movie", "id": 2000}),
                                   ("POST", f"franchises/{fid}/refresh", {}), ("POST", f"franchises/{fid}/delete", {})]:
            self.assertEqual(self.as_user(self.tok2, method, path, body)[0], 404, f"{method} {path}")
        self.assertIsNotNone(self.lib.franchise(fid), "не удалилась")
        self.assertFalse([c for g in self.detail(fid, hidden=True)["groups"] for c in g["items"] if c["id"] == 1000 and c["hidden"]])

    def test_events_are_per_user_and_marking_seen_touches_only_own(self):
        fid = self.build("movie", 1000)
        self.lib.event(fid, "movie", 1, "new_item", "Что-то новое")
        self.assertEqual(self.as_user(self.tok2, "GET", "events")[1]["events"], [])
        ev = self.api("GET", "events")[1]["events"]
        self.assertTrue(ev)
        self.as_user(self.tok2, "POST", "events/seen", {"all": True})
        self.as_user(self.tok2, "POST", "events/seen", {"ids": [e["id"] for e in ev]})
        self.assertEqual(len(self.api("GET", "events")[1]["events"]), len(ev), "чужие «просмотрено» не сработали")
        self.api("POST", "events/seen", {"all": True})
        self.assertEqual(self.api("GET", "events")[1]["events"], [])

    def test_same_wikidata_franchise_is_not_merged_across_users(self):
        a = self.build("movie", 1000)
        st, f2 = self.as_user(self.tok2, "POST", "franchises", {"kind": "movie", "id": 2000})
        self.assertTrue(self.lib.wait_idle(20))
        self.assertIsNone(self.lib.franchise(f2["id"])["merged_into"], "слияние только внутри одного пользователя")
        self.assertEqual(self.lib.franchise(f2["id"])["status"], "ready")
        self.assertIsNone(self.lib.franchise(a)["merged_into"])

    def test_token_of_a_disabled_user_and_unknown_token_get_nothing(self):
        self.proxy.users.set_disabled(self.u2, True)
        self.assertEqual(self.as_user(self.tok2, "GET", "franchises")[0], 404)
        self.assertEqual(self.as_user("nope-nope-nope", "GET", "franchises")[0], 404)

    def test_whoami_and_tmdb_proxy_work_for_any_device_token(self):
        def get(path):
            c = http.client.HTTPConnection("127.0.0.1", self.port, timeout=15)
            c.request("GET", path)
            r = c.getresponse(); out = r.read(); c.close()
            return r.status, out
        st, out = get(f"/tmdb/{self.tok2}/whoami")
        self.assertEqual((st, json.loads(out)["email"]), (200, "second@example.com"))
        self.assertEqual(json.loads(get(f"/tmdb/{TOKEN}/whoami")[1])["id"], 1)
        self.assertEqual(get("/tmdb/wrong-wrong/whoami")[0], 404)
        self.assertEqual(get(f"/tmdb/{self.tok2}/health")[0], 200)
        st, _ = get(f"/tmdb/{self.tok2}/api/https://api.themoviedb.org/3/movie/1000?api_key={KEY}&language=ru")
        self.assertEqual(st, 200, "TMDB-прокси доступен любому устройству с токеном")

    def test_login_over_http_exchanges_cub_account_for_a_device_token(self):
        from test_users import FakeCub
        cub = FakeCub()
        try:
            self.proxy.users.cub_domains = ("cub.test",)
            self.proxy.users.cub_url = cub.url
            self.proxy.users.add_user("petya@example.com", "Петя")
            self.proxy.users.set_registration(True)

            def login(payload, raw=None):
                c = http.client.HTTPConnection("127.0.0.1", self.port, timeout=15)
                c.request("POST", "/tmdb/auth/cub", body=raw if raw is not None else json.dumps(payload).encode(), headers={"Content-Type": "application/json"})
                r = c.getresponse(); out = r.read(); c.close()
                return r.status, json.loads(out)
            st, res = login({"domain": "cub.test", "token": "good-token", "profile": "p1", "device": "Телефон"})
            self.assertEqual(st, 200)
            self.assertEqual(res["user"]["email"], "petya@example.com")
            new_tok = res["token"]
            st, mine = self.as_user(new_tok, "GET", "franchises")
            self.assertEqual((st, mine["franchises"]), (200, []), "новое устройство сразу работает и видит только своё")
            st, stranger = login({"domain": "cub.test", "token": "stranger-token"})
            self.assertEqual((st, stranger["user"]["email"]), (200, "stranger@example.com"), "новая почта регистрируется сама")
            self.assertEqual(self.as_user(stranger["token"], "GET", "franchises")[1]["franchises"], [], "у нового пользователя пустая библиотека")
            self.proxy.users.set_registration(False)
            self.assertEqual(login({"domain": "cub.test", "token": "nobody-token"})[0], 403)
            self.assertEqual(login({"domain": "evil.test", "token": "good-token"})[0], 400)
            self.assertEqual(login(None, raw=b"not json")[0], 400)
            c = http.client.HTTPConnection("127.0.0.1", self.port, timeout=15)
            c.request("GET", "/tmdb/auth/cub")
            self.assertEqual(c.getresponse().status, 405)
        finally:
            cub.close()


class Migration(unittest.TestCase):
    def test_old_database_is_adopted_by_the_owner(self):
        import sqlite3
        tmp = Path(tempfile.mkdtemp(prefix="tapok-mig-"))
        try:
            db = sqlite3.connect(tmp / "tapokhub.sqlite3")
            db.executescript("""
                CREATE TABLE library_items(kind TEXT NOT NULL, tmdb_id INTEGER NOT NULL, added_at INTEGER NOT NULL, PRIMARY KEY(kind, tmdb_id));
                INSERT INTO library_items VALUES('movie', 603, 100), ('tv', 82856, 200);
                CREATE TABLE franchises(id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT NOT NULL, wikidata_id TEXT, wd_prop TEXT,
                    root_kind TEXT NOT NULL, root_id INTEGER NOT NULL, status TEXT NOT NULL, busy INTEGER NOT NULL DEFAULT 0,
                    error TEXT, choices TEXT, created_at INTEGER NOT NULL, resolved_at INTEGER, merged_into INTEGER);
                INSERT INTO franchises(title,root_kind,root_id,status,created_at) VALUES('Матрица','movie',603,'ready',1);
            """)
            db.commit(); db.close()
            cfg = Config(data_dir=tmp, token=TOKEN, listen_port=0, wd_min_interval=0)
            proxy = Proxy(cfg)
            c = proxy.store.conn()
            self.assertEqual([tuple(r) for r in c.execute("SELECT user_id, kind, tmdb_id FROM library_items ORDER BY tmdb_id")], [(1, "movie", 603), (1, "tv", 82856)])
            self.assertEqual(c.execute("SELECT user_id FROM franchises").fetchone()[0], 1)
            Proxy(cfg)     # повторный запуск на уже перенесённой базе ничего не ломает
        finally:
            shutil.rmtree(tmp, ignore_errors=True)


class Classify(unittest.TestCase):
    def setUp(self):
        class P:
            cfg = Config(data_dir=Path(tempfile.mkdtemp()))
            store = Store(cfg.db_path)
        P.langs = lambda self=None: ["ru"]
        self.lib = lib.Library(P())
        self.lib.today = lambda: TODAY

    def n(self, **kw):
        base = {"kind": "movie", "id": 1, "title": "x", "original": "x", "date": "2010-01-01", "runtime": 100, "votes": 500, "rating": 7,
                "animation": False, "status": "Released", "collection_id": None, "collection_name": None, "poster": None, "backdrop": None,
                "overview": "", "seasons": None}
        base.update(kw)
        return base

    def test_normalize_reads_adult_flag_and_keywords_of_movie_and_tv(self):
        m = {"id": 1, "title": "x", "release_date": "2010-01-01"}
        self.assertFalse(lib.normalize("movie", m)["adult"])
        self.assertTrue(lib.normalize("movie", dict(m, adult=True))["adult"])
        self.assertTrue(lib.normalize("movie", dict(m, keywords={"keywords": [{"id": 190370}]}))["adult"])
        self.assertTrue(lib.normalize("tv", {"id": 2, "name": "y", "keywords": {"results": [{"id": 325693}]}})["adult"])
        self.assertFalse(lib.normalize("movie", dict(m, keywords={"keywords": [{"id": 281741}]}))["adult"])
        self.assertFalse(lib.normalize("movie", dict(m, keywords=None))["adult"], "ответ без keywords (кеш прежних запросов)")
        self.assertEqual(self.lib.classify(self.n(adult=True), (500, "Сага")), ("other", "Прочее", True), "даже часть коллекции TMDB")

    def test_library_group_rules(self):
        g = lib.library_group
        self.assertEqual(g(self.n(genres=[28])), "movie")
        self.assertEqual(g(self.n(kind="tv", genres=[18])), "tv")
        self.assertEqual(g(self.n(genres=[16, 10751])), "cartoon_movie")
        self.assertEqual(g(self.n(kind="tv", genres=[16])), "cartoon_tv")
        self.assertEqual(g(self.n(genres=[16], lang="ja")), "anime", "японская анимация")
        self.assertEqual(g(self.n(genres=[16], lang="en", keywords=[210024])), "anime", "ключевое слово anime")
        self.assertEqual(g(self.n(genres=[28], keywords=[295446])), "anime", "манга")
        self.assertEqual(g(self.n(genres=[28], keywords=[13141])), "anime", "по манге, даже с живыми актёрами")
        self.assertEqual(g(self.n(genres=[99])), "docs")
        self.assertEqual(g(self.n(genres=[99, 16])), "cartoon_movie", "анимация важнее документального")
        self.assertEqual(g(self.n()), "movie", "записи без жанров (кеш старых запросов) — по виду")
        self.assertEqual(g(self.n(kind="tv")), "tv")
        self.assertEqual(g(self.n(genres=[35], lang="ja")), "movie", "японская, но не анимация и без манги: обычный фильм")

    def test_thresholds(self):
        c = self.lib.classify
        self.assertEqual(c(self.n(), None)[0], "films")
        self.assertEqual(c(self.n(runtime=59), None), ("other", "Прочее", True))
        self.assertEqual(c(self.n(runtime=60), None)[0], "films")
        self.assertEqual(c(self.n(votes=49), None)[2], True)
        self.assertEqual(c(self.n(votes=50), None)[2], False)
        self.assertEqual(c(self.n(runtime=None), None)[0], "other")
        self.assertEqual(c(self.n(kind="tv", votes=99), None)[0], "other")
        self.assertEqual(c(self.n(kind="tv", votes=100), None)[0], "series")
        self.assertEqual(c(self.n(kind="tv", votes=100, animation=True), None)[0], "animation")

    def test_collection_membership_beats_thresholds(self):
        self.assertEqual(self.lib.classify(self.n(runtime=10, votes=0), (500, "Сага")), ("collection:500", "Сага", False))

    def test_upcoming_rules(self):
        c = self.lib.classify
        self.assertEqual(c(self.n(date="2027-01-01"), None)[0], "upcoming")
        self.assertEqual(c(self.n(date="", status="In Production"), None)[0], "upcoming")
        self.assertEqual(c(self.n(date="2027-01-01", votes=0, runtime=0), None)[2], False, "выходящее не прячем")
        self.assertEqual(c(self.n(date="2020-01-01", status="In Production"), None)[0], "films", "дата в прошлом важнее статуса")

    def test_helpers(self):
        self.assertEqual(lib.clean_collection_name("Звёздные Войны (Коллекция)"), "Звёздные Войны")
        self.assertEqual(lib.clean_collection_name("Star Wars Collection"), "Star Wars")
        self.assertEqual(lib.norm_title("Ёлки-палки!"), "елки палки")


class Limits(Base):
    """Пределы: число позиций и коллекций у одного пользователя, размер кеша ответов TMDB."""

    def test_items_are_capped_but_known_ones_still_work(self):
        self.lib.ITEMS_MAX = 2
        for tid in (1000, 1001):
            self.assertEqual(self.api("POST", "items/add", {"kind": "movie", "id": tid})[0], 200)
        st, out = self.api("POST", "items/add", {"kind": "movie", "id": 1002})
        self.assertEqual(st, 429)
        self.assertIn("предел", out["error"])
        self.assertEqual(self.api("POST", "items/add", {"kind": "movie", "id": 1000})[0], 200, "уже добавленная позиция предел не задевает")
        self.api("POST", "items/remove", {"kind": "movie", "id": 1001})
        self.assertEqual(self.api("POST", "items/add", {"kind": "movie", "id": 1002})[0], 200, "после удаления место есть")

    def test_franchises_are_capped(self):
        self.lib.FRANCHISES_MAX = 1
        self.assertEqual(self.api("POST", "franchises", {"kind": "movie", "id": 1000})[0], 200)
        self.assertTrue(self.lib.wait_idle(20))
        st, out = self.api("POST", "franchises", {"kind": "movie", "id": 9000})     # другая франшиза
        self.assertEqual(st, 429)
        self.assertEqual(self.api("POST", "franchises", {"kind": "movie", "id": 1000})[0], 200, "та же коллекция: не новая")

    def add(self, user, kind, tid):
        return self.lib.handle("POST", "items/add", "", json.dumps({"kind": kind, "id": tid}).encode(), user=user)[0]

    def test_demo_caps_apply_per_kind_and_not_to_the_owner(self):
        cfg = self.proxy.cfg
        cfg.limit_movies, cfg.limit_tv = 2, 1
        for tid in (1000, 1001):
            self.assertEqual(self.add(2, "movie", tid), 200)
        st, out = self.lib.handle("POST", "items/add", "", json.dumps({"kind": "movie", "id": 1002}).encode(), user=2)
        self.assertEqual(st, 429)
        self.assertIn("демо", out["error"])
        self.assertEqual(self.add(2, "movie", 1000), 200, "уже добавленный фильм предел не задевает")
        self.assertEqual(self.add(2, "tv", 3000), 200, "сериалы считаются отдельно от фильмов")
        self.assertEqual(self.add(2, "tv", 3001), 429)
        self.assertEqual(self.add(3, "movie", 1002), 200, "у другого пользователя своя квота")
        for tid in (1000, 1001, 1002):
            self.assertEqual(self.add(1, "movie", tid), 200, "владельца демо-пределы не касаются")

    def test_personal_caps_beat_general_ones_and_reach_the_owner(self):
        self.assertEqual(self.lib.set_user_caps(1, {"movie": 1, "tv": 0, "bad": 5}), {"movie": 1}, "нулевые и чужие ключи отбрасываются")
        self.assertEqual(self.add(1, "movie", 1000), 200)
        self.assertEqual(self.add(1, "movie", 1001), 429, "своя квота действует и на владельца")
        self.assertEqual(self.add(1, "tv", 3000), 200, "то, что не задано, у владельца без предела")
        self.proxy.cfg.limit_movies = 3
        self.lib.set_user_caps(2, {"movie": 1})
        self.assertEqual(self.add(2, "movie", 1000), 200)
        self.assertEqual(self.add(2, "movie", 1001), 429, "своя квота (1) строже общей (3)")
        self.lib.set_user_caps(2, {})
        self.assertEqual(self.add(2, "movie", 1001), 200, "без своей квоты снова общая")

    def test_demo_franchise_cap(self):
        self.proxy.cfg.limit_franchises = 1
        ok = self.lib.handle("POST", "franchises", "", json.dumps({"kind": "movie", "id": 1000}).encode(), user=2)[0]
        self.assertEqual(ok, 200)
        self.assertTrue(self.lib.wait_idle(20))
        st, out = self.lib.handle("POST", "franchises", "", json.dumps({"kind": "movie", "id": 9000}).encode(), user=2)
        self.assertEqual(st, 429)
        self.assertIn("демо", out["error"])
        self.assertEqual(self.lib.handle("POST", "franchises", "", json.dumps({"kind": "movie", "id": 1000}).encode(), user=2)[0], 200)

    def test_response_cache_is_trimmed_oldest_first(self):
        self.proxy.cfg.api_max_total = 10_000
        c = self.proxy.store.conn()
        for i in range(30):
            c.execute("INSERT INTO api_cache(key,status,ctype,body,fetched_at,hits,last_hit) VALUES(?,?,?,?,?,0,?)",
                      (f"k{i}", 200, "application/json", b"x" * 1000, 1000 + i, 1000 + i))
        c.execute("UPDATE api_cache SET last_hit=99999 WHERE key='k0'")       # старая, но недавно запрошенная запись остаётся
        removed = self.proxy.evict_api()
        left = {r["key"] for r in c.execute("SELECT key FROM api_cache")}
        total = c.execute("SELECT SUM(LENGTH(body)) t FROM api_cache").fetchone()["t"]
        self.assertGreater(removed, 0)
        self.assertLessEqual(total, 9_000)
        self.assertIn("k0", left)
        self.assertIn("k29", left, "свежие остаются")
        self.assertNotIn("k1", left, "давно не запрашивавшиеся уходят первыми")
        self.assertEqual(self.proxy.evict_api(), 0, "в пределах предела ничего не удаляется")

    def test_cache_is_checked_while_serving_requests(self):
        from tapokhub.modules import proxy as proxy_mod
        old = proxy_mod.EVICT_EVERY
        proxy_mod.EVICT_EVERY = 2
        self.proxy.cfg.api_max_total = 1
        try:
            for tid in (1000, 1001, 1002, 1003):
                self.lib.details("movie", tid)
        finally:
            proxy_mod.EVICT_EVERY = old
        n = self.proxy.store.conn().execute("SELECT COUNT(*) c FROM api_cache").fetchone()["c"]
        self.assertLess(n, 4, "лишнее убирается по ходу работы, а не только раз в 6 часов")


if __name__ == "__main__":
    unittest.main(verbosity=2)
