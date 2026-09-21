"""Встроенная раздача плагина (Docker и установка без домена): адрес сервера в плагине, картинки, /healthz, первый запуск контейнера."""
import os as _os
_os.environ["TAPOK_LANG"] = "ru"      # тесты проверяют русские тексты; английские: test_i18n.py
import http.client
import os
import stat
import sys
import tempfile
import threading
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from tapokhub import cli
from tapokhub.core.config import Config, load_config
from tapokhub.modules.api import create_server
from tapokhub.modules.users import OWNER
from tapokhub.modules.web import PLACEHOLDER

PLUGIN = "var TH = {proxyHost: '%s', assets: '%s/tapokhub-assets', old: 'https://a.pcsrf.ru'};" % (PLACEHOLDER, PLACEHOLDER)


class WebTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        self.web = self.root / "web"
        (self.web / "tapokhub-assets").mkdir(parents=True)
        (self.web / "tapokhub.js").write_text(PLUGIN, encoding="utf-8")
        (self.web / "tapokhub-assets" / "crt.png").write_bytes(b"\x89PNG-test")
        (self.web / "tapokhub-assets" / "notes.txt").write_text("не картинка")
        (self.root / "secret.png").write_bytes(b"secret")
        self.servers = []

    def tearDown(self):
        for server, thread in self.servers:
            server.shutdown()
            thread.join()
            server.server_close()
        self.tmp.cleanup()

    def start(self, **kw):
        cfg = Config(data_dir=self.root / "data", token="t" * 24, listen_port=0, **kw)
        server, _ = create_server(cfg)
        thread = threading.Thread(target=server.serve_forever)
        thread.start()
        self.servers.append((server, thread))
        return server.server_port

    def get(self, port, path, headers=None, method="GET"):
        conn = http.client.HTTPConnection("127.0.0.1", port, timeout=5)
        conn.request(method, path, headers=headers or {})
        r = conn.getresponse()
        body = r.read()
        conn.close()
        return r.status, dict(r.getheaders()), body

    def test_healthz_needs_no_token_and_shows_no_data(self):
        port = self.start()
        st, h, body = self.get(port, "/healthz")
        self.assertEqual(st, 200)
        self.assertIn(b'"ok": true', body)
        self.assertNotIn(b"images", body, "статистики кеша и настроек не отдаём")

    def test_short_path_serves_the_same_plugin(self):
        port = self.start(web_dir=self.web)
        full = self.get(port, "/tapokhub.js", {"Host": "192.168.1.5:8080"})
        for path in ("/t", "/t.js"):
            st, h, body = self.get(port, path, {"Host": "192.168.1.5:8080"})
            self.assertEqual((st, body), (200, full[2]), path)
            self.assertTrue(h["Content-Type"].startswith("application/javascript"), path)
        st, _, page = self.get(port, "/", {"Host": "192.168.1.5:8080"})
        self.assertIn(b"http://192.168.1.5:8080/t<", page, "страница-подсказка показывает короткий адрес")
        self.assertIn(b"http://192.168.1.5:8080/tapokhub.js<", page, "и полный")

    def test_plugin_gets_address_from_host_header(self):
        port = self.start(web_dir=self.web)
        st, h, body = self.get(port, "/tapokhub.js", {"Host": "192.168.1.5:8080"})
        text = body.decode()
        self.assertEqual(st, 200)
        self.assertIn("proxyHost: 'http://192.168.1.5:8080'", text)
        self.assertIn("http://192.168.1.5:8080/tapokhub-assets", text)
        self.assertNotIn("tapokhub.placeholder", text)
        self.assertNotIn("a.pcsrf.ru", text, "и адрес по умолчанию публичной сборки заменён")
        self.assertTrue(h["Content-Type"].startswith("application/javascript"))
        self.assertIn("no-store", h["Cache-Control"])
        self.assertEqual(h["Access-Control-Allow-Origin"], "*")
        st, _, _ = self.get(port, "/tapokhub.js", {"Host": "192.168.1.5:8080"}, method="HEAD")
        self.assertEqual(st, 200)

    def test_https_behind_reverse_proxy_and_public_url_override(self):
        port = self.start(web_dir=self.web)
        _, _, body = self.get(port, "/tapokhub.js", {"Host": "tapok.example.com", "X-Forwarded-Proto": "https"})
        self.assertIn("proxyHost: 'https://tapok.example.com'", body.decode())
        _, _, body = self.get(port, "/tapokhub.js", {"Host": "tapok.example.com", "X-Forwarded-Proto": "javascript:"})
        self.assertIn("proxyHost: 'http://tapok.example.com'", body.decode(), "любое значение кроме https считается http")
        port2 = self.start(web_dir=self.web, public_url="https://hub.example.org:8443")
        _, _, body = self.get(port2, "/tapokhub.js", {"Host": "evil.example"})
        self.assertIn("proxyHost: 'https://hub.example.org:8443'", body.decode(), "заданный адрес сильнее Host")

    def test_bad_host_header_is_not_injected_into_plugin(self):
        port = self.start(web_dir=self.web)
        for bad in ("a'b.example", "x y", "evil/../", "<script>", "a" * 300):
            st, _, body = self.get(port, "/tapokhub.js", {"Host": bad})
            self.assertEqual(st, 404, bad)
            self.assertNotIn(b"proxyHost", body)

    def test_assets_only_plain_image_names_inside_the_folder(self):
        port = self.start(web_dir=self.web)
        st, h, body = self.get(port, "/tapokhub-assets/crt.png")
        self.assertEqual((st, h["Content-Type"], body), (200, "image/png", b"\x89PNG-test"))
        for path in ("/tapokhub-assets/notes.txt", "/tapokhub-assets/missing.png", "/tapokhub-assets/../secret.png",
                     "/tapokhub-assets/..%2fsecret.png", "/tapokhub-assets/%2e%2e/secret.png", "/tapokhub-assets/sub/crt.png", "/tapokhub-assets/"):
            self.assertEqual(self.get(port, path)[0], 404, path)

    def test_index_page_shows_plugin_address_and_http_warning(self):
        port = self.start(web_dir=self.web)
        st, h, body = self.get(port, "/", {"Host": "192.168.1.5:8080"})
        text = body.decode()
        self.assertEqual(st, 200)
        self.assertIn("http://192.168.1.5:8080/tapokhub.js", text)
        self.assertIn("без HTTPS", text)
        _, _, body = self.get(port, "/", {"Host": "tapok.example.com", "X-Forwarded-Proto": "https"})
        self.assertNotIn("без HTTPS", body.decode())

    def test_without_web_dir_nothing_extra_is_served(self):
        port = self.start()
        self.assertEqual(self.get(port, "/")[0], 404)
        self.assertEqual(self.get(port, "/tapokhub.js")[0], 404, "с nginx плагин отдаёт он, сервер молчит")
        self.assertEqual(self.get(port, "/tapokhub-assets/crt.png")[0], 404)

    def test_missing_plugin_file_and_bad_public_url(self):
        (self.web / "tapokhub.js").unlink()
        port = self.start(web_dir=self.web)
        self.assertEqual(self.get(port, "/tapokhub.js")[0], 404)
        with self.assertRaises(ValueError):
            create_server(Config(data_dir=self.root / "d2", token="t" * 24, listen_port=0, web_dir=self.web, public_url="ftp://x"))
        with self.assertRaises(ValueError):
            create_server(Config(data_dir=self.root / "d3", token="t" * 24, listen_port=0, web_dir=self.web, public_url="http://a b"))

    def test_plugin_edit_is_picked_up_without_restart(self):
        port = self.start(web_dir=self.web)
        self.get(port, "/tapokhub.js", {"Host": "h:1"})
        (self.web / "tapokhub.js").write_text("var TH = {proxyHost: '%s', v: 2};" % PLACEHOLDER)
        os.utime(self.web / "tapokhub.js", (1, 2_000_000_000))
        self.assertIn("v: 2", self.get(port, "/tapokhub.js", {"Host": "h:1"})[2].decode())

    def test_config_from_environment(self):
        env = {"TAPOK_WEB_DIR": "/app/web", "TAPOK_PUBLIC_URL": "http://10.0.0.5:8080/", "TAPOK_AUTO_TOKEN": "1",
               "TAPOK_ADMIN_EMAIL": " me@example.com ", "TAPOK_REGISTRATION": "Closed", "TAPOK_TOKEN_FILE": "/data/token",
               "TAPOK_LISTEN": "0.0.0.0:8080", "TAPOK_DATA": "/data"}
        with patch.dict(os.environ, env, clear=True):
            cfg = load_config()
        self.assertEqual((cfg.web_dir, cfg.public_url, cfg.auto_token, cfg.admin_email, cfg.registration),
                         (Path("/app/web"), "http://10.0.0.5:8080", True, "me@example.com", "closed"))
        self.assertEqual((cfg.listen_host, cfg.listen_port, cfg.token_file), ("0.0.0.0", 8080, Path("/data/token")))
        with patch.dict(os.environ, {"TAPOK_REGISTRATION": "maybe"}, clear=True):
            self.assertEqual(load_config().registration, "", "неизвестное значение не меняет регистрацию")
        with patch.dict(os.environ, {"TAPOK_LIMIT_MOVIES": "30", "TAPOK_LIMIT_TV": " 5 ", "TAPOK_LIMIT_FRANCHISES": "много"}, clear=True):
            cfg = load_config()
            self.assertEqual((cfg.limit_movies, cfg.limit_tv, cfg.limit_franchises), (30, 5, 0), "не число: предел не задан")


class FirstStartTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)

    def tearDown(self):
        self.tmp.cleanup()

    def env(self, **extra):
        env = {"TAPOK_DATA": str(self.root / "data"), "TAPOK_TOKEN_FILE": str(self.root / "data" / "token"), "TAPOK_LISTEN": "127.0.0.1:0"}
        env.update(extra)
        return env

    def serve_once(self, env):
        """cli serve, остановленный сразу после запуска: возвращает код выхода."""
        with patch.dict(os.environ, env, clear=True), patch("tapokhub.modules.api.Server.serve_forever", side_effect=KeyboardInterrupt), \
                patch("tapokhub.cli.warm_loop"), patch("tapokhub.modules.library.Library.start"):
            return cli.main(["serve"])

    def test_no_token_and_no_auto_token_refuses_to_start(self):
        self.assertEqual(self.serve_once(self.env()), 2)

    def test_auto_token_is_created_once_private_and_kept(self):
        self.assertEqual(self.serve_once(self.env(TAPOK_AUTO_TOKEN="1")), 0)
        f = self.root / "data" / "token"
        token = f.read_text()
        self.assertGreaterEqual(len(token), 32)
        self.assertEqual(stat.S_IMODE(f.stat().st_mode), 0o600)
        self.assertEqual(self.serve_once(self.env(TAPOK_AUTO_TOKEN="1")), 0)
        self.assertEqual(f.read_text(), token, "при перезапуске токен тот же")

    def test_registration_and_admin_email_applied_only_on_first_start(self):
        env = self.env(TAPOK_AUTO_TOKEN="1", TAPOK_REGISTRATION="closed", TAPOK_ADMIN_EMAIL="Admin@Example.com")
        self.assertEqual(self.serve_once(env), 0)
        with patch.dict(os.environ, self.env(), clear=True):
            cfg = load_config()
        from tapokhub.modules.proxy import Proxy
        proxy = Proxy(cfg)
        self.assertFalse(proxy.users.registration_open())
        self.assertEqual(proxy.users.user(OWNER)["email"], "admin@example.com")
        proxy.users.set_registration(True)
        proxy.users.set_email(OWNER, "other@example.com")
        proxy.store.close()
        self.assertEqual(self.serve_once(env), 0)
        proxy = Proxy(cfg)
        self.assertTrue(proxy.users.registration_open(), "ручное решение администратора не перетирается перезапуском")
        self.assertEqual(proxy.users.user(OWNER)["email"], "other@example.com")
        proxy.store.close()

    def test_bad_public_url_stops_start_with_message(self):
        web = self.root / "web"
        web.mkdir()
        self.assertEqual(self.serve_once(self.env(TAPOK_AUTO_TOKEN="1", TAPOK_WEB_DIR=str(web), TAPOK_PUBLIC_URL="tapok.example.com")), 2)


if __name__ == "__main__":
    unittest.main()
