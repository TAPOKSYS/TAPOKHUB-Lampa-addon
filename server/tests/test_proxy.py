#!/usr/bin/env python3
"""Тесты кеширующего прокси на поддельном TMDB. Запуск: python3 server/test_proxy.py"""

import os as _os
_os.environ["TAPOK_LANG"] = "ru"      # тесты проверяют русские тексты; английские: test_i18n.py
import http.client
import http.server
import json
import re
import shutil
import socketserver
import sqlite3
import sys
import tempfile
import threading
import time
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from tapokhub.cli import main  # noqa: E402
from tapokhub.core.common import DAY, HOUR  # noqa: E402
from tapokhub.core.config import Config  # noqa: E402
from tapokhub.libraries.tmdb_logos import pick_logo  # noqa: E402
from tapokhub.modules.api import create_server  # noqa: E402
from tapokhub.modules.proxy import cache_key, extract_key, ttl_for  # noqa: E402

GOOD_KEY = "a" * 32
OTHER_KEY = "b" * 32
BAD_KEY = "c" * 32
LAMPA_KEY = "d" * 32
TOKEN = "t0k3n" * 5

PNG = b"\x89PNG\r\n\x1a\n" + b"\x00" * 64


def movie(mid: int) -> dict:
    return {"id": mid, "title": f"Movie {mid}", "poster_path": f"/poster{mid:08d}.jpg", "backdrop_path": f"/backdrop{mid:06d}.jpg", "release_date": "2001-01-01"}


class FakeTmdb:
    """Поддельные api.themoviedb.org и image.tmdb.org в одном сервере."""

    def __init__(self):
        self.counts: dict[str, int] = {}
        self.keys_seen: list[str] = []
        self.mode = "ok"          # ok | down | slow | 500
        self.valid_keys = {GOOD_KEY, OTHER_KEY, LAMPA_KEY}
        self.lampa_js = "/* x */ function key() {\n    return '%s';\n  }\n" % LAMPA_KEY
        outer = self

        class H(http.server.BaseHTTPRequestHandler):
            def log_message(self, *a):
                pass

            def reply(self, status, body, ctype="application/json"):
                self.send_response(status)
                self.send_header("Content-Type", ctype)
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)

            def do_GET(self):
                path, _, q = self.path.partition("?")
                outer.counts[path] = outer.counts.get(path, 0) + 1
                outer.counts["*"] = outer.counts.get("*", 0) + 1
                if path == "/app.min.js":
                    return self.reply(200, outer.lampa_js.encode(), "application/javascript")
                if outer.mode == "down":
                    self.close_connection = True
                    self.connection.close()
                    return
                if outer.mode == "500":
                    return self.reply(500, b'{"status_message":"boom"}')
                if outer.mode == "slow":
                    time.sleep(0.4)
                if path.startswith("/t/p/"):
                    if path.endswith("notimage.jpg"):
                        return self.reply(200, b"<html>captcha</html>", "text/html")
                    if path.endswith("missing00.jpg"):
                        return self.reply(404, b"nope", "text/plain")
                    return self.reply(200, PNG, "image/png" if path.endswith(".png") else "image/jpeg")
                params = dict(x.split("=", 1) for x in q.split("&") if "=" in x)
                key = params.get("api_key", "")
                outer.keys_seen.append(key)
                if key not in outer.valid_keys:
                    return self.reply(401, b'{"status_code":7,"status_message":"Invalid API key"}')
                if path == "/3/configuration":
                    return self.reply(200, b'{"images":{}}')
                m = re.match(r"^/3/collection/(\d+)$", path)
                if m:
                    ids = {"1241": [671, 672], "9485": [9799, 13804], "399": [1]}.get(m[1])
                    if not ids:
                        return self.reply(404, b'{"status_code":34}')
                    return self.reply(200, json.dumps({"id": int(m[1]), "name": "C", "parts": [movie(i) for i in ids]}).encode())
                m = re.match(r"^/3/(movie|tv)/(\d+)/images$", path)
                if m:
                    return self.reply(200, json.dumps({"logos": [{"iso_639_1": "en", "file_path": f"/logoEN{m[2]:0>6}.png"}, {"iso_639_1": "ru", "file_path": f"/logoRU{m[2]:0>6}.png"}]}).encode())
                m = re.match(r"^/3/(movie|tv)/(\d+)$", path)
                if m:
                    if m[2] == "999999":
                        return self.reply(404, b'{"status_code":34}')
                    return self.reply(200, json.dumps(movie(int(m[2]))).encode())
                self.reply(404, b"{}")

        class S(socketserver.ThreadingMixIn, http.server.HTTPServer):
            daemon_threads = True

        self.server = S(("127.0.0.1", 0), H)
        self.url = f"http://127.0.0.1:{self.server.server_address[1]}"
        threading.Thread(target=self.server.serve_forever, daemon=True).start()

    def reset(self):
        self.counts.clear()
        self.keys_seen.clear()
        self.mode = "ok"

    def n(self, prefix: str = "*") -> int:
        if prefix == "*":
            return self.counts.get("*", 0)
        return sum(v for k, v in self.counts.items() if k.startswith(prefix))

    def close(self):
        self.server.shutdown()
        self.server.server_close()


class Base(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmdb = FakeTmdb()

    @classmethod
    def tearDownClass(cls):
        cls.tmdb.close()

    def setUp(self):
        self.tmdb.reset()
        self.tmpdir = Path(tempfile.mkdtemp(prefix="tapok-test-"))
        self.cfg = Config(
            data_dir=self.tmpdir, token=TOKEN, listen_port=0,
            api_upstream=self.tmdb.url, img_upstream=self.tmdb.url, lampa_app_url=self.tmdb.url + "/app.min.js",
            upstream_timeout=3,
        )
        self.server, self.proxy = create_server(self.cfg)
        self.port = self.server.server_address[1]
        threading.Thread(target=self.server.serve_forever, daemon=True).start()

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()
        shutil.rmtree(self.tmpdir, ignore_errors=True)

    def raw(self, path: str, headers: dict | None = None, method: str = "GET"):
        c = http.client.HTTPConnection("127.0.0.1", self.port, timeout=10)
        c.request(method, path, headers=headers or {})
        r = c.getresponse()
        body = r.read()
        h = {k.lower(): v for k, v in r.getheaders()}
        c.close()
        return r.status, body, h

    def api(self, sub: str, key: str = GOOD_KEY, extra: str = "", token: str = TOKEN):
        q = f"api_key={key}" + (("&" + extra) if extra else "")
        return self.raw(f"/tmdb/{token}/api/https://api.themoviedb.org/3/{sub}?{q}")

    def img(self, size: str, name: str, headers: dict | None = None, token: str = TOKEN):
        return self.raw(f"/tmdb/{token}/img/https://image.tmdb.org/t/p/{size}/{name}", headers)

    def age_api_rows(self, seconds: int):
        c = sqlite3.connect(str(self.cfg.db_path))
        c.execute("UPDATE api_cache SET fetched_at = fetched_at - ?", (seconds,))
        c.commit()
        c.close()


class ApiCache(Base):
    def test_miss_then_hit(self):
        s1, b1, h1 = self.api("movie/671", extra="language=ru")
        s2, b2, h2 = self.api("movie/671", extra="language=ru")
        self.assertEqual((s1, s2), (200, 200))
        self.assertEqual(b1, b2)
        self.assertEqual((h1["x-tapok-cache"], h2["x-tapok-cache"]), ("miss", "hit"))
        self.assertEqual(self.tmdb.n("/3/movie/671"), 1)
        self.assertEqual(json.loads(b1)["id"], 671)

    def test_api_key_is_not_part_of_cache_key(self):
        self.api("movie/671", key=GOOD_KEY, extra="language=ru")
        self.api("movie/671", key=OTHER_KEY, extra="language=ru")
        self.assertEqual(self.tmdb.n("/3/movie/671"), 1, "данные одни, ключи у клиентов разные")

    def test_query_params_order_does_not_matter_but_language_does(self):
        self.api("movie/671", extra="language=ru&append_to_response=images")
        self.api("movie/671", extra="append_to_response=images&language=ru")
        self.assertEqual(self.tmdb.n("/3/movie/671"), 1)
        self.api("movie/671", extra="language=en&append_to_response=images")
        self.assertEqual(self.tmdb.n("/3/movie/671"), 2)

    def test_client_key_forwarded_upstream(self):
        self.api("movie/1", key=OTHER_KEY)
        self.assertEqual(self.tmdb.keys_seen[-1], OTHER_KEY)

    def test_invalid_key_passes_through_and_is_not_cached_or_learned(self):
        st, body, _ = self.api("movie/671", key=BAD_KEY)
        self.assertEqual(st, 401)
        self.assertIn(b"Invalid API key", body)
        self.assertIsNone(self.proxy.key(), "неверный ключ запоминать нельзя")
        st2, _, _ = self.api("movie/671", key=GOOD_KEY)
        self.assertEqual(st2, 200, "неудача не должна отравить кеш")

    def test_working_key_is_learned_from_lampa_request(self):
        self.assertIsNone(self.proxy.key())
        self.api("movie/671", key=GOOD_KEY)
        self.assertEqual(self.proxy.key(), GOOD_KEY)
        self.assertEqual(self.proxy.store.meta_get("tmdb_key_source"), "lampa-request")

    def test_key_is_learned_only_from_the_owner(self):
        """Обычный пользователь может ходить в TMDB со своим ключом, но подменить ключ сервера не может."""
        uid = self.proxy.users.add_user("guest@example.com")
        guest = self.proxy.users.issue_token(uid, "гость")
        self.assertIsNone(self.proxy.key())
        st, _, _ = self.api("movie/671", key=OTHER_KEY, token=guest)
        self.assertEqual(st, 200, "запрос гостя выполняется его ключом")
        self.assertIsNone(self.proxy.key(), "ключ гостя сервером не запоминается")
        self.api("movie/672", key=GOOD_KEY)
        self.assertEqual(self.proxy.key(), GOOD_KEY, "ключ владельца запоминается")
        self.api("movie/673", key=OTHER_KEY, token=guest)
        self.assertEqual(self.proxy.key(), GOOD_KEY, "и не заменяется ключом гостя")

    def test_404_is_cached_briefly(self):
        s1, _, _ = self.api("movie/999999")
        s2, _, h2 = self.api("movie/999999")
        self.assertEqual((s1, s2), (404, 404))
        self.assertEqual(h2["x-tapok-cache"], "hit")
        self.assertEqual(self.tmdb.n("/3/movie/999999"), 1)

    def test_stale_copy_served_when_tmdb_is_down(self):
        self.api("collection/1241", extra="language=ru")
        self.age_api_rows(3 * DAY)                 # копия протухла
        self.tmdb.mode = "down"
        st, body, h = self.api("collection/1241", extra="language=ru")
        self.assertEqual(st, 200)
        self.assertEqual(h["x-tapok-cache"], "stale")
        self.assertEqual(json.loads(body)["id"], 1241)

    def test_stale_copy_served_on_upstream_5xx(self):
        self.api("movie/671")
        self.age_api_rows(3 * DAY)
        self.tmdb.mode = "500"
        st, _, h = self.api("movie/671")
        self.assertEqual((st, h["x-tapok-cache"]), (200, "stale"))

    def test_too_old_copy_is_not_served(self):
        self.api("movie/671")
        self.age_api_rows(40 * DAY)                # старше stale_max (30 суток)
        self.tmdb.mode = "down"
        st, _, _ = self.api("movie/671")
        self.assertEqual(st, 502)

    def test_down_without_any_copy_is_502_not_a_hang(self):
        self.tmdb.mode = "down"
        t = time.time()
        st, _, _ = self.api("movie/671")
        self.assertEqual(st, 502)
        self.assertLess(time.time() - t, 6)

    def test_refetch_after_ttl(self):
        self.api("movie/671")
        self.age_api_rows(2 * DAY)
        st, _, h = self.api("movie/671")
        self.assertEqual((st, h["x-tapok-cache"]), (200, "miss"))
        self.assertEqual(self.tmdb.n("/3/movie/671"), 2)

    def test_concurrent_identical_requests_make_one_upstream_call(self):
        self.tmdb.mode = "slow"
        out = []
        ts = [threading.Thread(target=lambda: out.append(self.api("movie/671", extra="language=ru")[0])) for _ in range(8)]
        [t.start() for t in ts]
        [t.join() for t in ts]
        self.assertEqual(out, [200] * 8)
        self.assertEqual(self.tmdb.n("/3/movie/671"), 1)

    def test_language_is_recorded_for_warming(self):
        self.api("movie/671", extra="language=uk")
        self.assertIn("uk", self.proxy.store.seen_values("lang"))


class Security(Base):
    def test_wrong_token_is_404_everywhere(self):
        for sub in ("movie/1", "collection/1241"):
            self.assertEqual(self.api(sub, token="wrongtoken")[0], 404)
        self.assertEqual(self.img("w300", "poster00000671.jpg", token="wrongtoken")[0], 404)
        self.assertEqual(self.raw("/tmdb/wrongtoken/health")[0], 404)
        self.assertEqual(self.tmdb.n(), 0, "с неверным токеном в TMDB не ходим")

    def test_not_a_proxy_for_other_hosts(self):
        st, _, _ = self.raw(f"/tmdb/{TOKEN}/api/https://evil.example.com/3/movie/1?api_key={GOOD_KEY}")
        self.assertEqual(st, 404)
        st, _, _ = self.raw(f"/tmdb/{TOKEN}/img/https://evil.example.com/t/p/w300/poster00000671.jpg")
        self.assertEqual(st, 404)
        self.assertEqual(self.tmdb.n(), 0)

    def test_bad_api_paths_rejected(self):
        for sub in ("movie/../../etc/passwd", "movie/1%00", "a%20b"):
            st, _, _ = self.raw(f"/tmdb/{TOKEN}/api/https://api.themoviedb.org/3/{sub}?api_key={GOOD_KEY}")
            self.assertIn(st, (400, 404), sub)
        self.assertEqual(self.tmdb.n("/3/"), 0)

    def test_bad_image_paths_rejected(self):
        for size, name in [("w300", "..%2f..%2fetc%2fpasswd"), ("w300", "a.jpg"), ("evil", "poster00000671.jpg"), ("w300", "poster00000671.exe"), ("../x", "poster00000671.jpg")]:
            st, _, _ = self.img(size, name)
            self.assertIn(st, (400, 404), (size, name))
        self.assertEqual(self.tmdb.n("/t/p/"), 0)
        self.assertEqual([p for p in self.cfg.img_dir.rglob("*") if p.is_file()], [])

    def test_health_hides_the_key(self):
        self.api("movie/1", key=GOOD_KEY)
        st, body, _ = self.raw(f"/tmdb/{TOKEN}/health")
        self.assertEqual(st, 200)
        self.assertNotIn(GOOD_KEY.encode(), body)
        self.assertTrue(json.loads(body)["key_known"])

    def test_health_reports_version(self):
        from tapokhub import __version__
        st, body, _ = self.raw(f"/tmdb/{TOKEN}/health")
        self.assertEqual(st, 200)
        self.assertEqual(json.loads(body)["version"], __version__)
        self.assertEqual(__version__, (Path(__file__).resolve().parents[2] / "VERSION").read_text().strip(), "версия сервера равна файлу VERSION")

    def test_options_cors(self):
        st, _, h = self.raw(f"/tmdb/{TOKEN}/api/https://api.themoviedb.org/3/movie/1", method="OPTIONS")
        self.assertEqual(st, 204)
        self.assertEqual(h["access-control-allow-origin"], "*")

    def test_short_token_refused_to_serve(self):
        import os
        old = {k: os.environ.get(k) for k in ("TAPOK_TOKEN", "TAPOK_DATA")}
        os.environ["TAPOK_TOKEN"] = "short"
        os.environ["TAPOK_DATA"] = str(self.tmpdir / "x")
        try:
            self.assertEqual(main(["serve"]), 2, "с коротким токеном сервис не запускается")
        finally:
            for k, v in old.items():
                if v is None:
                    os.environ.pop(k, None)
                else:
                    os.environ[k] = v


class Images(Base):
    def test_miss_stores_file_then_hit_without_upstream(self):
        s1, b1, h1 = self.img("w300", "poster00000671.jpg")
        self.assertEqual((s1, h1["x-tapok-cache"], h1["content-type"]), (200, "miss", "image/jpeg"))
        self.assertEqual(b1, PNG)
        self.assertTrue((self.cfg.img_dir / "w300" / "poster00000671.jpg").is_file())
        n = self.tmdb.n("/t/p/")
        s2, b2, h2 = self.img("w300", "poster00000671.jpg")
        self.assertEqual((s2, h2["x-tapok-cache"], b2), (200, "hit", PNG))
        self.assertEqual(self.tmdb.n("/t/p/"), n)

    def test_headers_for_canvas_and_cloudflare(self):
        _, _, h = self.img("w1280", "backdrop000671.jpg")
        self.assertEqual(h["access-control-allow-origin"], "*", "Background рисует картинки через crossOrigin=Anonymous")
        self.assertIn("immutable", h["cache-control"])
        self.assertIn("max-age=31536000", h["cache-control"])

    def test_etag_304(self):
        _, _, h = self.img("w300", "poster00000671.jpg")
        st, body, _ = self.img("w300", "poster00000671.jpg", headers={"If-None-Match": h["etag"]})
        self.assertEqual((st, body), (304, b""))

    def test_png_logo_content_type(self):
        _, _, h = self.img("w500", "logoEN000671.png")
        self.assertEqual(h["content-type"], "image/png")

    def test_upstream_not_image_is_502_and_not_stored(self):
        st, _, _ = self.img("w300", "notimage.jpg")
        self.assertEqual(st, 502)
        self.assertFalse((self.cfg.img_dir / "w300" / "notimage.jpg").exists())

    def test_upstream_404_passes_through(self):
        st, _, _ = self.img("w300", "missing00.jpg")
        self.assertEqual(st, 404)

    def test_down_serves_existing_files_fails_missing(self):
        self.img("w300", "poster00000671.jpg")
        self.tmdb.mode = "down"
        self.assertEqual(self.img("w300", "poster00000671.jpg")[0], 200)
        self.assertEqual(self.img("w300", "poster00009999.jpg")[0], 502)

    def test_concurrent_downloads_once(self):
        self.tmdb.mode = "slow"
        out = []
        ts = [threading.Thread(target=lambda: out.append(self.img("w300", "poster00000671.jpg")[0])) for _ in range(6)]
        [t.start() for t in ts]
        [t.join() for t in ts]
        self.assertEqual(out, [200] * 6)
        self.assertEqual(self.tmdb.n("/t/p/"), 1)

    def test_size_is_recorded(self):
        self.img("w300", "poster00000671.jpg")
        self.assertIn("w300", self.proxy.store.seen_values("size"))

    def test_eviction_removes_least_recently_used(self):
        self.cfg.img_max_total = 3 * len(PNG)
        for i in range(1, 7):
            self.img("w300", f"poster0000000{i}.jpg")
            time.sleep(0.02)
        c = self.proxy.store.conn()
        c.execute("UPDATE images SET last_hit = ? WHERE name = ?", (1, "poster00000001.jpg"))   # самая давняя
        removed = self.proxy.evict_images()
        self.assertGreaterEqual(removed, 3)
        self.assertFalse((self.cfg.img_dir / "w300" / "poster00000001.jpg").exists())
        left = c.execute("SELECT COALESCE(SUM(bytes),0) b FROM images").fetchone()["b"]
        self.assertLessEqual(left, self.cfg.img_max_total)


class Keys(Base):
    def test_extract_key_prefers_function_key(self):
        js = "var h='%s'; function key() {\n return '%s';\n }" % (OTHER_KEY, GOOD_KEY)
        self.assertEqual(extract_key(js)[0], GOOD_KEY)

    def test_extract_key_falls_back_to_any_32hex_literal(self):
        self.assertEqual(extract_key("x = \"%s\"" % GOOD_KEY), [GOOD_KEY])
        self.assertEqual(extract_key("nothing here"), [])

    def test_refresh_from_lampa_learns_valid_key(self):
        self.assertTrue(self.proxy.refresh_key_from_lampa())
        self.assertEqual(self.proxy.key(), LAMPA_KEY)
        self.assertEqual(self.proxy.store.meta_get("tmdb_key_source"), "lampa")

    def test_refresh_from_lampa_never_stores_a_key_tmdb_rejects(self):
        self.tmdb.lampa_js = "function key() { return '%s'; }" % BAD_KEY
        self.assertFalse(self.proxy.refresh_key_from_lampa())
        self.assertIsNone(self.proxy.key())

    def test_ensure_key_replaces_a_key_that_stopped_working(self):
        self.proxy.store.meta_set("tmdb_key", OTHER_KEY)
        self.proxy.store.meta_set("tmdb_key_checked", "1")
        self.proxy.store.conn().execute("UPDATE meta SET updated_at = 1 WHERE k = 'tmdb_key_checked'")   # давно не проверяли
        self.tmdb.valid_keys.discard(OTHER_KEY)                        # TMDB его отозвал
        try:
            self.assertEqual(self.proxy.ensure_key(), LAMPA_KEY)
        finally:
            self.tmdb.valid_keys.add(OTHER_KEY)

    def test_ensure_key_without_any_key_asks_lampa(self):
        self.assertEqual(self.proxy.ensure_key(), LAMPA_KEY)


class Warm(Base):
    def test_warm_fills_cache_for_collections(self):
        rep = self.proxy.warm()
        self.assertEqual(rep["errors"], 0, rep)
        self.assertEqual(rep["collections"], 2)                        # 1241 и 9485 из seed
        self.assertGreaterEqual(rep["movies"], 5)                      # 2 + 2 части + extra 384018
        for f in ("w300/poster00000671.jpg", "w1280/backdrop000671.jpg", "w500/logoRU000671.png"):
            self.assertTrue((self.cfg.img_dir / f).is_file(), f)
        self.assertIsNotNone(self.proxy.last_warm)

    def test_warm_uses_the_same_cache_keys_as_the_plugin(self):
        self.proxy.warm()
        n = self.tmdb.n()
        for sub, extra in [("collection/1241", "language=ru"), ("movie/671", "language=ru"),
                           ("movie/671/images", "include_image_language=ru,en,null&language=ru")]:
            st, _, h = self.api(sub, extra=extra)
            self.assertEqual((st, h["x-tapok-cache"]), (200, "hit"), sub)
        self.assertEqual(self.tmdb.n(), n, "плагин после прогрева не должен ходить в TMDB")

    def test_warm_prefers_ru_logo_like_the_plugin(self):
        self.proxy.warm()
        self.assertTrue((self.cfg.img_dir / "w500" / "logoRU000671.png").is_file())
        self.assertFalse((self.cfg.img_dir / "w500" / "logoEN000671.png").exists())

    def test_second_warm_does_not_redownload(self):
        self.proxy.warm()
        n = self.tmdb.n("/t/p/")
        self.proxy.warm()
        self.assertEqual(self.tmdb.n("/t/p/"), n)

    def test_warm_survives_tmdb_outage_and_reports_it(self):
        self.proxy.ensure_key()
        self.tmdb.mode = "down"
        rep = self.proxy.warm()
        self.assertGreater(rep["errors"], 0)

    def test_warm_learns_key_from_lampa_when_none_known(self):
        self.assertIsNone(self.proxy.key())
        self.proxy.warm()
        self.assertEqual(self.proxy.key(), LAMPA_KEY)

    def test_warm_uses_languages_lampa_actually_requests(self):
        self.api("movie/1", extra="language=uk")
        self.tmdb.reset()
        self.proxy.warm()
        self.assertGreater(self.tmdb.n("/3/collection/1241"), 0)
        self.assertEqual(self.proxy.langs()[0], "uk")

    def test_collections_cli_roundtrip(self):
        c = self.proxy.store.conn()
        c.execute("INSERT OR REPLACE INTO collections VALUES('pred','Хищник',399,'[]',9)")
        self.assertIn("pred", [x["id"] for x in self.proxy.collections()])
        self.proxy.warm()
        self.assertTrue((self.cfg.img_dir / "w300" / "poster00000001.jpg").is_file())


class Policy(unittest.TestCase):
    def test_ttl_for(self):
        day, hr = DAY, HOUR
        self.assertEqual(ttl_for("collection/1241"), day)
        self.assertEqual(ttl_for("movie/671"), day)
        self.assertEqual(ttl_for("movie/671/images"), day)
        self.assertEqual(ttl_for("tv/1396/season/1"), day)
        self.assertEqual(ttl_for("movie/671/recommendations"), 6 * hr)
        self.assertEqual(ttl_for("search/movie"), 600)
        self.assertEqual(ttl_for("discover/movie"), 600)
        self.assertEqual(ttl_for("trending/all/day"), 600)
        self.assertEqual(ttl_for("configuration"), 7 * day)
        self.assertEqual(ttl_for("something/else"), hr)

    def test_pick_logo_order_matches_plugin(self):
        L = lambda i, p: {"iso_639_1": i, "file_path": p}
        self.assertEqual(pick_logo([L("de", "/de"), L("en", "/en"), L("ru", "/ru"), L(None, "/n")], "ru"), "/ru")
        self.assertEqual(pick_logo([L("de", "/de"), L(None, "/n"), L("en", "/en")], "ru"), "/en")
        self.assertEqual(pick_logo([L("de", "/de"), L(None, "/n")], "ru"), "/n")
        self.assertEqual(pick_logo([L("de", "/de")], "ru"), "/de")
        self.assertIsNone(pick_logo([], "ru"))
        self.assertIsNone(pick_logo([{"iso_639_1": "ru"}], "ru"))

    def test_cache_key_ignores_api_key_and_orders_params(self):
        a = cache_key("movie/1", [("api_key", "x"), ("language", "ru"), ("b", "2")])
        b = cache_key("movie/1", [("b", "2"), ("language", "ru"), ("api_key", "y")])
        self.assertEqual(a, b)
        self.assertNotIn("api_key", a)


class Health(Base):
    def test_stats_counters(self):
        self.api("movie/671")
        self.api("movie/671")
        self.img("w300", "poster00000671.jpg")
        self.img("w300", "poster00000671.jpg")
        _, body, _ = self.raw(f"/tmdb/{TOKEN}/health")
        h = json.loads(body)
        self.assertEqual((h["stats"]["api_miss"], h["stats"]["api_hit"]), (1, 1))
        self.assertEqual((h["stats"]["img_miss"], h["stats"]["img_hit"]), (1, 1))
        self.assertEqual(h["images"], 1)
        self.assertEqual(h["api_entries"], 1)


if __name__ == "__main__":
    unittest.main(verbosity=2)
