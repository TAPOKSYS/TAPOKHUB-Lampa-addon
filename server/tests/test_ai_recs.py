#!/usr/bin/env python3
"""Тесты ИИ-подборки дня на поддельных TMDB и ИИ. Запуск: python3 server/tests/test_ai_recs.py"""

import os as _os
_os.environ["TAPOK_LANG"] = "ru"
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
from tapokhub.modules.api import create_server  # noqa: E402
from tapokhub.modules.ai_recs import parse_titles  # noqa: E402

KEY = "d" * 32
TOKEN = "t0k3n" * 5
AIKEY = "sk-secret-ai-key"


def item(kind, i, title, year, votes=500, poster=True, adult=False):
    d = {"id": i, "vote_count": votes, "vote_average": 7.0, "poster_path": f"/p{i}.jpg" if poster else None, "backdrop_path": f"/b{i}.jpg",
         "overview": "о", "adult": adult, "genres": []}
    if kind == "movie":
        d.update(title=title, original_title=title + " orig", release_date=f"{year}-01-01")
    else:
        d.update(name=title, original_name=title + " orig", first_air_date=f"{year}-01-01")
    return d


class World:
    """Один HTTP-сервер: и TMDB, и ИИ (POST /v1/chat/completions)."""

    def __init__(self):
        self.movies = {1: item("movie", 1, "Мой фильм", 2010), 2: item("movie", 2, "Другой мой", 2015)}
        self.tv = {5: item("tv", 5, "Мой сериал", 2012)}
        self.search = {}                       # (kind, название) -> результаты поиска TMDB
        self.ai_answer = {"items": []}
        self.ai_status = 200
        self.ai_requests = []
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

            def do_POST(self):
                body = json.loads(self.rfile.read(int(self.headers.get("Content-Length") or 0)))
                outer.ai_requests.append((self.path, self.headers.get("Authorization"), body))
                if outer.ai_status != 200:
                    return self.reply(outer.ai_status, {"error": AIKEY})
                self.reply(200, {"choices": [{"message": {"content": json.dumps(outer.ai_answer, ensure_ascii=False)}}]})

            def do_GET(self):
                path, _, q = self.path.partition("?")
                params = dict(urllib.parse.parse_qsl(q))
                if path == "/app.min.js":
                    body = ("function key() { return '%s'; }" % KEY).encode()
                    self.send_response(200)
                    self.send_header("Content-Length", str(len(body)))
                    self.end_headers()
                    return self.wfile.write(body)
                m = re.match(r"^/3/(movie|tv)/(\d+)$", path)
                if m:
                    it = (outer.movies if m[1] == "movie" else outer.tv).get(int(m[2]))
                    return self.reply(200, it) if it else self.reply(404, {})
                m = re.match(r"^/3/search/(movie|tv)$", path)
                if m:
                    return self.reply(200, {"results": outer.search.get((m[1], params.get("query")), [])})
                self.reply(404, {})

        class S(socketserver.ThreadingMixIn, http.server.HTTPServer):
            daemon_threads = True

        self.server = S(("127.0.0.1", 0), H)
        self.url = f"http://127.0.0.1:{self.server.server_address[1]}"
        threading.Thread(target=self.server.serve_forever, daemon=True).start()


class Base(unittest.TestCase):
    ai_key = AIKEY

    @classmethod
    def setUpClass(cls):
        cls.world = World()

    @classmethod
    def tearDownClass(cls):
        cls.world.server.shutdown()
        cls.world.server.server_close()

    def setUp(self):
        w = self.world
        w.search, w.ai_answer, w.ai_status, w.ai_requests = {}, {"items": []}, 200, []
        self.day = ["2026-11-07"]
        self.tmpdir = Path(tempfile.mkdtemp(prefix="tapok-ai-"))
        self.cfg = Config(data_dir=self.tmpdir, token=TOKEN, listen_port=0, api_upstream=w.url, img_upstream=w.url,
                          lampa_app_url=w.url + "/app.min.js", upstream_timeout=3, ai_url=w.url, ai_key=self.ai_key, ai_model="m")
        self.server, self.proxy = create_server(self.cfg)
        self.port = self.server.server_address[1]
        threading.Thread(target=self.server.serve_forever, daemon=True).start()
        self.proxy.library.today = lambda: self.day[0]
        self.ai = self.proxy.ai
        self.proxy.store.meta_set("tmdb_key", KEY)
        c = self.proxy.store.conn()
        for kind, tid in (("movie", 1), ("movie", 2), ("tv", 5)):
            c.execute("INSERT INTO library_items(user_id,kind,tmdb_id,added_at) VALUES(1,?,?,?)", (kind, tid, int(time.time())))

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()
        shutil.rmtree(self.tmpdir, ignore_errors=True)

    def api(self, method, path, body=None, token=TOKEN):
        c = http.client.HTTPConnection("127.0.0.1", self.port, timeout=15)
        c.request(method, f"/tmdb/{token}/lib/{path}", body=json.dumps(body or {}).encode() if method == "POST" else None, headers={"Content-Type": "application/json"})
        r = c.getresponse()
        out = r.read()
        c.close()
        return r.status, json.loads(out)

    def want(self, n):
        """n выдуманных ответов ИИ с настоящими парами в TMDB."""
        items = []
        for i in range(n):
            tid = 100 + i
            title = f"Новинка {i}"
            self.world.movies[tid] = item("movie", tid, title, 2020)
            self.world.search[("movie", title)] = [item("movie", tid, title, 2020)]
            items.append({"title": title, "year": 2020, "kind": "movie", "why": f"потому что {i}"})
        self.world.ai_answer = {"items": items}


class Parse(unittest.TestCase):
    def test_formats_and_garbage(self):
        self.assertEqual(parse_titles("не json"), [])
        self.assertEqual(parse_titles("[1, 2]"), [])
        out = parse_titles('{"items": [{"title": "А", "year": "2019-05", "kind": "series", "why": "х"}, {"title": ""}, "строка"]}')
        self.assertEqual(out, [{"title": "А", "year": 2019, "kind": "tv", "why": "х"}])
        self.assertEqual(parse_titles('[{"title": "Б", "year": "abc"}]')[0]["year"], 0)


class Refresh(Base):
    def test_saves_eighteen_and_calls_ai_once_with_library(self):
        self.want(22)
        res = self.ai.refresh()
        self.assertEqual(len(res["items"]), 18)
        self.assertEqual(res["day"], "2026-11-07")
        self.assertEqual(res["items"][0]["why"], "потому что 0")
        self.assertEqual(res["items"][0]["media_type"], "movie")
        path, auth, body = self.world.ai_requests[0]
        self.assertEqual(path, "/v1/chat/completions")
        self.assertEqual(auth, "Bearer " + AIKEY)
        text = body["messages"][1]["content"]
        for name in ("Мой фильм", "Другой мой", "Мой сериал"):
            self.assertIn(name, text)
        self.ai.refresh()                       # сегодня уже есть: второй раз ИИ не трогаем
        self.assertEqual(len(self.world.ai_requests), 1)

    def test_next_day_skips_old_picks(self):
        self.want(22)
        first = {x["id"] for x in self.ai.refresh()["items"]}
        self.day[0] = "2026-11-08"
        second = self.ai.refresh()
        self.assertEqual(second["day"], "2026-11-08")
        self.assertEqual(len(second["items"]), 4)           # остались только 4 новых из 22 в ответе ИИ
        self.assertFalse(first & {x["id"] for x in second["items"]})
        self.assertIn("Новинка 0", self.world.ai_requests[1][2]["messages"][1]["content"])   # прежние советы ИИ напомнили

    def test_filters_library_unknown_noposter_adult(self):
        w = self.world
        w.movies[200] = item("movie", 200, "Без постера", 2020, poster=False)
        w.movies[201] = item("movie", 201, "Взрослое", 2020, adult=True)
        w.search[("movie", "Мой фильм")] = [w.movies[1]]                       # уже в библиотеке
        w.search[("movie", "Без постера")] = [w.movies[200]]
        w.search[("movie", "Взрослое")] = [w.movies[201]]
        w.movies[300] = item("movie", 300, "Годное", 2021)
        w.search[("movie", "Годное")] = [w.movies[300]]
        w.ai_answer = {"items": [{"title": t, "year": 2020 if t != "Годное" else 2021, "kind": "movie", "why": ""}
                                 for t in ("Мой фильм", "Выдумка", "Без постера", "Взрослое", "Годное", "Годное")]}
        res = self.ai.refresh()
        self.assertEqual([x["id"] for x in res["items"]], [300])               # и дубль «Годное» схлопнулся

    def test_lampa_history_is_skipped_and_ping_waits_two_hours(self):
        w = self.world
        w.movies[310] = item("movie", 310, "Виденное в Lampa", 2020)
        w.movies[311] = item("movie", 311, "Новое", 2021)
        w.search[("movie", "Виденное в Lampa")] = [w.movies[310]]
        w.search[("movie", "Новое")] = [w.movies[311]]
        w.ai_answer = {"items": [{"title": t, "year": 2020, "kind": "movie", "why": ""} for t in ("Виденное в Lampa", "Новое")]}
        self.assertEqual(self.api("POST", "ai-picks/ping", {"seen": ["movie:310", "мусор", "tv:x"]})[0], 200)
        for _ in range(100):                                                   # ping запускает сборку в фоне
            if not self.ai.busy and self.ai.get(1)["items"]:
                break
            time.sleep(0.05)
        self.assertEqual([x["id"] for x in self.ai.get(1)["items"]], [311])
        self.assertEqual(self.ai.seen(), {("movie", 310)})
        n = len(w.ai_requests)
        self.api("POST", "ai-picks/ping", {"seen": []})
        time.sleep(0.3)
        self.assertEqual(len(w.ai_requests), n)                                # не прошло двух часов — ИИ не спрашиваем

    def test_failure_keeps_previous_and_hides_key(self):
        self.want(3)
        self.ai.refresh()
        self.day[0] = "2026-11-08"
        self.world.ai_status = 402
        res = self.ai.refresh()
        self.assertEqual(len(res["items"]), 3)                                  # вчерашняя подборка осталась
        self.assertEqual(res["day"], "2026-11-07")
        self.assertEqual(res["error"], "HTTP 402")
        self.assertNotIn(AIKEY, json.dumps(res))

    def test_empty_library(self):
        self.proxy.store.conn().execute("DELETE FROM library_items")
        res = self.ai.refresh()
        self.assertEqual(res["items"], [])
        self.assertTrue(res["error"])
        self.assertEqual(self.world.ai_requests, [])


class Http(Base):
    def test_owner_gets_items(self):
        self.want(2)
        self.ai.refresh()
        st, body = self.api("GET", "ai-picks")
        self.assertEqual(st, 200)
        self.assertTrue(body["enabled"])
        self.assertEqual(len(body["items"]), 2)

    def test_other_user_sees_nothing(self):
        self.want(2)
        self.ai.refresh()
        self.assertEqual(self.ai.get(2), {"enabled": False, "items": []})

    def test_refresh_runs_in_background(self):
        self.want(4)
        st, body = self.api("POST", "ai-picks/refresh")
        self.assertEqual(st, 200)
        self.assertTrue(body["busy"])
        for _ in range(100):
            if self.api("GET", "ai-picks")[1]["items"]:
                break
            time.sleep(0.05)
        self.assertEqual(len(self.api("GET", "ai-picks")[1]["items"]), 4)


class Key(Base):
    ai_key = ""

    def post(self, body, user=1):
        return self.proxy.library.handle("POST", "ai-key", "", json.dumps(body).encode(), user)

    def test_key_from_settings_enables_and_never_leaks(self):
        self.want(3)
        self.assertFalse(self.ai.enabled)
        st, info = self.post({"key": "sk-" + "a" * 30 + "WXYZ"})
        self.assertEqual((st, info["set"], info["source"], info["hint"]), (200, True, "settings", "WXYZ"))
        self.assertNotIn("a" * 30, json.dumps(info))
        for _ in range(100):                       # после ввода подборка собирается сама, в фоне
            if self.api("GET", "ai-picks")[1]["items"]:
                break
            time.sleep(0.05)
        self.assertEqual(len(self.api("GET", "ai-picks")[1]["items"]), 3)
        self.assertEqual(self.world.ai_requests[0][1], "Bearer sk-" + "a" * 30 + "WXYZ")
        st, got = self.api("GET", "ai-key")
        self.assertTrue(got["set"] and "a" * 30 not in json.dumps(got))

    def test_bad_key_rejected_and_clear(self):
        self.assertEqual(self.post({"key": "коротко"})[0], 400)
        self.assertEqual(self.post({"key": "has space " + "x" * 20})[0], 400)
        self.assertEqual(self.post({"key": 5})[0], 400)
        self.assertFalse(self.ai.enabled)
        self.post({"key": "k" * 24})
        time.sleep(0.3)
        st, info = self.post({"key": ""})
        self.assertEqual((st, info["set"]), (200, False))
        self.assertFalse(self.ai.enabled)

    def test_only_owner(self):
        self.assertEqual(self.post({"key": "k" * 24}, user=2)[0], 403)
        self.assertEqual(self.proxy.library.handle("GET", "ai-key", "", b"", 2), (200, {"admin": False}))
        self.assertFalse(self.ai.enabled)

    def test_settings_key_beats_server_key(self):
        self.cfg.ai_key = "env-" + "e" * 20
        self.assertEqual(self.ai.key(), "env-" + "e" * 20)
        self.assertEqual(self.ai.key_info()["source"], "server")
        self.post({"key": "s" * 24})
        time.sleep(0.3)
        self.assertEqual(self.ai.key(), "s" * 24)
        self.post({"key": ""})
        self.assertEqual(self.ai.key(), "env-" + "e" * 20)


class Disabled(Base):
    ai_key = ""

    def test_no_key_means_off(self):
        self.assertEqual(self.api("GET", "ai-picks")[1], {"enabled": False, "items": []})
        self.assertEqual(self.api("POST", "ai-picks/refresh")[0], 403)
        self.assertEqual(self.api("POST", "ai-picks/ping")[0], 403)
        self.assertEqual(self.world.ai_requests, [])


if __name__ == "__main__":
    unittest.main()
