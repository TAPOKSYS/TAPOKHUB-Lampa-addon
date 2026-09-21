"""Исправления по аудиту безопасности: заголовки, ограничитель частоты, потолок соединений, проверка полей, токен в журнале."""
import os as _os
_os.environ["TAPOK_LANG"] = "ru"      # тесты проверяют русские тексты; английские: test_i18n.py
import http.client
import json
import logging
import socket
import sys
import tempfile
import threading
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from tapokhub.core.config import Config
from tapokhub.core.net import RateLimiter
from tapokhub.modules import api
from tapokhub.modules.api import create_server

TOKEN = "t" * 24


class Clock:
    def __init__(self):
        self.t = 1000.0

    def __call__(self):
        return self.t


class RateLimiterTests(unittest.TestCase):
    def test_window_slides_and_keys_are_separate(self):
        clock = Clock()
        lim = RateLimiter(3, 60, now=clock)
        self.assertEqual([lim.allow("a") for _ in range(4)], [True, True, True, False])
        self.assertTrue(lim.allow("b"), "у другого ключа свой счёт")
        clock.t += 61
        self.assertTrue(lim.allow("a"), "окно прошло")

    def test_zero_means_no_limit(self):
        lim = RateLimiter(0)
        self.assertTrue(all(lim.allow("a") for _ in range(1000)))


class ServerTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.servers = []

    def tearDown(self):
        for server, thread in self.servers:
            server.shutdown()
            thread.join()
            server.server_close()
        self.tmp.cleanup()

    def start(self, **kw):
        cfg = Config(data_dir=Path(self.tmp.name) / "data", token=TOKEN, listen_port=0, **kw)
        server, proxy = create_server(cfg)
        thread = threading.Thread(target=server.serve_forever)
        thread.start()
        self.servers.append((server, thread))
        return server, proxy

    def call(self, server, method, path, body=None):
        conn = http.client.HTTPConnection("127.0.0.1", server.server_port, timeout=5)
        conn.request(method, path, body=json.dumps(body).encode() if body is not None else None)
        r = conn.getresponse()
        data = r.read()
        conn.close()
        return r.status, dict(r.getheaders()), data

    def test_every_answer_carries_security_headers(self):
        server, _ = self.start()
        for path in ("/healthz", f"/tmdb/{TOKEN}/whoami", "/tmdb/wrong-token/whoami"):
            st, h, _ = self.call(server, "GET", path)
            self.assertEqual(h["X-Content-Type-Options"], "nosniff", path)
            self.assertEqual(h["X-Frame-Options"], "DENY", path)
            self.assertEqual(h["Referrer-Policy"], "no-referrer", path)
            self.assertIn("frame-ancestors 'none'", h["Content-Security-Policy"], path)
            self.assertNotIn("unsafe", h["Content-Security-Policy"], path)

    def test_hint_page_and_assets_have_their_own_csp(self):
        web = Path(self.tmp.name) / "web"
        (web / "tapokhub-assets").mkdir(parents=True)
        (web / "tapokhub.js").write_text("x", encoding="utf-8")
        (web / "tapokhub-assets" / "logo.svg").write_text("<svg xmlns='http://www.w3.org/2000/svg'/>", encoding="utf-8")
        server, _ = self.start(web_dir=web)
        _, h, _ = self.call(server, "GET", "/")
        self.assertIn("style-src 'unsafe-inline'", h["Content-Security-Policy"], "стили страницы-подсказки внутри")
        self.assertNotIn("script-src", h["Content-Security-Policy"])
        self.assertIn("default-src 'none'", h["Content-Security-Policy"], "скриптам взяться неоткуда")
        _, h, _ = self.call(server, "GET", "/tapokhub-assets/logo.svg")
        self.assertIn("sandbox", h["Content-Security-Policy"], "SVG, открытый напрямую, не исполняет скрипты")

    def test_requests_are_limited_per_user(self):
        server, proxy = self.start(rate_limit=5)
        codes = [self.call(server, "GET", f"/tmdb/{TOKEN}/whoami")[0] for _ in range(7)]
        self.assertEqual(codes, [200] * 5 + [429] * 2)
        st, h, body = self.call(server, "GET", f"/tmdb/{TOKEN}/whoami")
        self.assertEqual(h["Retry-After"], "60")
        self.assertIn("error", json.loads(body))
        other = proxy.users.add_user("other@example.com")
        self.assertEqual(self.call(server, "GET", f"/tmdb/{proxy.users.issue_token(other)}/whoami")[0], 200, "у другого пользователя свой счёт")
        self.assertEqual(self.call(server, "GET", "/healthz")[0], 200, "проверка живости лимитом не закрыта")

    def test_heavy_actions_have_a_smaller_limit(self):
        server, _ = self.start(heavy_limit=2)
        codes = [self.call(server, "POST", f"/tmdb/{TOKEN}/lib/recommend", {"seeds": []})[0] for _ in range(3)]
        self.assertEqual(codes, [200, 200, 429])
        self.assertEqual(self.call(server, "GET", f"/tmdb/{TOKEN}/lib/stats")[0], 200, "обычное чтение не считается тяжёлым")

    def test_wikidata_fields_are_validated(self):
        server, _ = self.start()
        for wikidata, prop in (("Q1 haswbstatement:P31=Q5", "P8345"), ("Q42", "P31"), (42, "P8345"), ("Q42|Q43", "P179")):
            st, _, body = self.call(server, "POST", f"/tmdb/{TOKEN}/lib/franchises", {"kind": "movie", "id": 1, "wikidata": wikidata, "prop": prop})
            self.assertEqual(st, 400, (wikidata, prop))

    def test_events_seen_ignores_non_numbers(self):
        server, _ = self.start()
        st, _, body = self.call(server, "POST", f"/tmdb/{TOKEN}/lib/events/seen", {"ids": [1, "x", None, {"a": 1}]})
        self.assertEqual((st, json.loads(body)), (200, {"ok": True}), "раньше нечисловой элемент давал ошибку 500")

    def test_token_is_not_written_to_the_debug_log(self):
        server, _ = self.start()
        records = []

        class Grab(logging.Handler):
            def emit(self, record):
                records.append(record.getMessage())

        log = logging.getLogger("tapokhub")
        old = log.level
        log.setLevel(logging.DEBUG)
        handler = Grab()
        log.addHandler(handler)
        try:
            self.call(server, "GET", f"/tmdb/{TOKEN}/whoami")
        finally:
            log.removeHandler(handler)
            log.setLevel(old)
        joined = "\n".join(records)
        self.assertIn("/tmdb/<token>/whoami", joined)
        self.assertNotIn(TOKEN, joined)

    def test_connections_over_the_cap_get_503_instead_of_a_thread(self):
        old = api.MAX_CONNECTIONS
        api.MAX_CONNECTIONS = 2
        try:
            server, _ = self.start()
        finally:
            api.MAX_CONNECTIONS = old
        held = [socket.create_connection(("127.0.0.1", server.server_port), timeout=5) for _ in range(2)]      # молчащие соединения занимают места
        try:
            for s in held:
                s.sendall(b"GET /healthz HTTP/1.1\r\nHost: x\r\n\r\n")
                self.assertIn(b"200", s.recv(4096))
            extra = socket.create_connection(("127.0.0.1", server.server_port), timeout=5)
            extra.sendall(b"GET /healthz HTTP/1.1\r\nHost: x\r\n\r\n")
            self.assertTrue(extra.recv(4096).startswith(b"HTTP/1.1 503"))
            extra.close()
        finally:
            for s in held:
                s.close()


if __name__ == "__main__":
    unittest.main()
