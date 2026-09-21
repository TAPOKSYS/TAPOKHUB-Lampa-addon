#!/usr/bin/env python3
"""Тесты пользователей и входа через CUB (поддельный CUB). Запуск: python3 server/test_users.py"""

import os as _os
_os.environ["TAPOK_LANG"] = "ru"      # тесты проверяют русские тексты; английские: test_i18n.py
import http.server
import json
import shutil
import socketserver
import sys
import tempfile
import threading
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from tapokhub.core.store import Store  # noqa: E402
from tapokhub.modules import users as us  # noqa: E402


class FakeCub:
    """Отвечает на /api/users/get как CUB: по заголовку token определяет почту."""

    def __init__(self):
        outer = self
        self.accounts = {"good-token": {"id": 77, "email": "Petya@Example.com"}, "stranger-token": {"id": 5, "email": "stranger@example.com"}}
        self.mode = "ok"        # ok | down | 500
        self.calls = []

        class H(http.server.BaseHTTPRequestHandler):
            def log_message(self, *a):
                pass

            def do_GET(self):
                outer.calls.append({"path": self.path, "token": self.headers.get("token"), "profile": self.headers.get("profile")})
                if outer.mode == "500":
                    self.send_response(500); self.end_headers(); return
                if outer.mode == "700":     # так CUB отвечает на неверный токен
                    body = json.dumps({"error": True, "code": 700, "text": "Вход не выполнен"}).encode()
                    self.send_response(500); self.send_header("Content-Length", str(len(body))); self.end_headers(); self.wfile.write(body); return
                acc = outer.accounts.get(self.headers.get("token"))
                if not acc:
                    self.send_response(401); self.end_headers(); return
                body = json.dumps({"secuses": True, "user": acc}).encode()
                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)

        class S(socketserver.ThreadingMixIn, http.server.HTTPServer):
            daemon_threads = True

        self.server = S(("127.0.0.1", 0), H)
        self.url = f"http://127.0.0.1:{self.server.server_address[1]}/api/users/get"
        threading.Thread(target=self.server.serve_forever, daemon=True).start()

    def close(self):
        self.server.shutdown()
        self.server.server_close()


class Clock:
    def __init__(self):
        self.t = 1_000_000.0

    def __call__(self):
        return self.t


class UsersTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.cub = FakeCub()

    @classmethod
    def tearDownClass(cls):
        cls.cub.close()

    def setUp(self):
        self.cub.mode = "ok"
        self.cub.calls.clear()
        self.tmp = Path(tempfile.mkdtemp(prefix="tapok-users-"))
        self.store = Store(self.tmp / "t.sqlite3")
        self.clock = Clock()
        self.users = us.Users(self.store, "master-token-1234567890", ("cub.test", "other.test"), timeout=3, now=self.clock, cub_url=self.cub.url.replace("127.0.0.1", "{domain}").replace("{domain}", "127.0.0.1"))

    def tearDown(self):
        self.store.close()
        shutil.rmtree(self.tmp, ignore_errors=True)

    # ---- токены устройств

    def test_master_token_is_owner_and_garbage_is_nobody(self):
        self.assertEqual(self.users.authenticate("master-token-1234567890"), us.OWNER)
        self.assertIsNone(self.users.authenticate("nope"))
        self.assertIsNone(self.users.authenticate(""))

    def test_device_token_belongs_to_its_user_only_and_is_stored_hashed(self):
        a = self.users.add_user("a@example.com")
        b = self.users.add_user("b@example.com")
        ta = self.users.issue_token(a, "телефон")
        tb = self.users.issue_token(b, "ТВ")
        self.assertEqual((self.users.authenticate(ta), self.users.authenticate(tb)), (a, b))
        raw = self.store.conn().execute("SELECT group_concat(token_hash) h FROM devices").fetchone()["h"]
        self.assertNotIn(ta, raw)
        self.assertNotIn(tb, raw)

    def test_revoke_disable_and_enable(self):
        a = self.users.add_user("a@example.com")
        t1, t2 = self.users.issue_token(a, "1"), self.users.issue_token(a, "2")
        self.assertEqual(self.users.authenticate(t1), a)
        dev = self.users.list_users()[-1]["devices"][0]["id"]
        self.assertTrue(self.users.revoke(dev))
        self.assertIsNone(self.users.authenticate(t1), "отозванное устройство перестало работать сразу")
        self.assertEqual(self.users.authenticate(t2), a, "остальные устройства работают")
        self.users.set_disabled(a, True)
        self.assertIsNone(self.users.authenticate(t2))
        self.users.set_disabled(a, False)
        self.assertEqual(self.users.authenticate(t2), a)

    def test_token_check_is_cached_for_a_minute(self):
        a = self.users.add_user("a@example.com")
        t = self.users.issue_token(a)
        self.assertEqual(self.users.authenticate(t), a)
        self.store.conn().execute("DELETE FROM devices")          # удалили в обход (другой процесс, CLI)
        self.assertEqual(self.users.authenticate(t), a, "в пределах минуты держится кеш")
        self.clock.t += us.CACHE_TTL + 1
        self.assertIsNone(self.users.authenticate(t), "после минуты отзыв вступил в силу")

    def test_device_limit_evicts_the_oldest(self):
        a = self.users.add_user("a@example.com")
        first = self.users.issue_token(a, "первое")
        for i in range(us.MAX_DEVICES):
            self.users.issue_token(a, f"устройство {i}")
        self.assertIsNone(self.users.authenticate(first))
        self.assertEqual(len(self.users.list_users()[-1]["devices"]), us.MAX_DEVICES)

    def test_owner_exists_from_the_start_and_email_is_normalized(self):
        self.assertEqual(self.users.user(us.OWNER)["name"], "владелец")
        self.users.set_email(us.OWNER, "  Me@Example.COM ")
        self.assertEqual(self.users.find("me@example.com")["id"], us.OWNER)
        self.assertEqual(self.users.add_user("ME@example.com"), us.OWNER, "та же почта — тот же пользователь")

    # ---- вход через CUB

    def login(self, token="good-token", domain="cub.test", who="1.1.1.1", profile="p1", device="Pixel"):
        return self.users.login_cub(who, domain, token, profile, device)

    def test_login_with_allowed_email_issues_a_working_device_token(self):
        uid = self.users.add_user("petya@example.com", "Петя")
        res = self.login()
        self.assertEqual(res["user"]["email"], "petya@example.com")
        self.assertEqual(self.users.authenticate(res["token"]), uid, "почта сравнивается без учёта регистра")
        self.assertEqual(self.cub.calls[-1]["token"], "good-token")
        self.assertEqual(self.cub.calls[-1]["profile"], "p1")
        dev = self.users.list_users()[-1]["devices"][0]
        self.assertIn("Pixel", dev["label"]); self.assertEqual(dev["source"], "cub")

    def test_login_never_stores_the_account_token(self):
        self.users.add_user("petya@example.com")
        self.login()
        dump = "".join(str(tuple(r)) for t in ("users", "devices") for r in self.store.conn().execute(f"SELECT * FROM {t}"))
        self.assertNotIn("good-token", dump)

    def test_registration_is_closed_until_the_owner_opens_it(self):
        self.assertFalse(self.users.registration_open(), "нет решения владельца: закрыто")
        with self.assertRaises(us.LoginError) as e:
            self.login(token="stranger-token")
        self.assertEqual(e.exception.status, 403)

    def test_a_successful_login_of_a_known_user_does_not_use_up_the_limit(self):
        self.users.add_user("petya@example.com")
        for _ in range(us.LOGIN_MAX * 2):
            self.login()
        with self.assertRaises(us.LoginError) as e:      # а неудачные попытки лимит расходуют
            for _ in range(us.LOGIN_MAX + 1):
                try:
                    self.login(token="who-knows")
                except us.LoginError as err:
                    if err.status == 429:
                        raise
        self.assertEqual(e.exception.status, 429)

    def test_new_email_registers_a_new_user_automatically(self):
        self.users.set_registration(True)
        res = self.login(token="stranger-token")
        self.assertEqual(res["user"]["email"], "stranger@example.com")
        self.assertEqual(res["user"]["name"], "stranger")
        uid = res["user"]["id"]
        self.assertGreater(uid, us.OWNER)
        self.assertEqual(self.users.authenticate(res["token"]), uid)
        again = self.login(token="stranger-token", who="2.2.2.2")
        self.assertEqual(again["user"]["id"], uid, "второе устройство того же человека — тот же пользователь")
        self.assertEqual(len([u for u in self.users.list_users() if u["email"] == "stranger@example.com"]), 1)

    def test_registration_can_be_closed_and_reopened(self):
        self.users.set_registration(False)
        with self.assertRaises(us.LoginError) as e:
            self.login(token="stranger-token")
        self.assertEqual(e.exception.status, 403)
        self.users.add_user("stranger@example.com")
        self.assertTrue(self.login(token="stranger-token")["token"], "заранее заведённого пускаем и при закрытой регистрации")
        self.users.set_registration(True)
        self.assertTrue(self.login()["token"])

    def test_registration_api_is_owner_only(self):
        self.users.set_registration(True)
        other = self.users.add_user("other@example.com")
        self.assertEqual(self.users.registration_api("GET", {}, other), (200, {"admin": False}), "остальные не видят значение")
        self.assertEqual(self.users.registration_api("POST", {"open": False}, other)[0], 403)
        self.assertTrue(self.users.registration_open(), "чужая попытка ничего не меняет")
        self.assertEqual(self.users.registration_api("POST", {"open": False}, us.OWNER), (200, {"admin": True, "open": False}))
        self.assertFalse(self.users.registration_open())
        self.assertEqual(self.users.registration_api("POST", {"open": "no"}, us.OWNER)[0], 400, "нужен именно true или false")
        self.assertEqual(self.users.registration_api("POST", {}, us.OWNER)[0], 400)
        self.assertEqual(self.users.registration_api("GET", {}, us.OWNER), (200, {"admin": True, "open": False}))
        self.assertEqual(self.users.registration_api("POST", {"open": True}, us.OWNER), (200, {"admin": True, "open": True}))
        self.assertEqual(self.users.registration_api("DELETE", {}, us.OWNER)[0], 405)

    def test_disabled_user_is_refused_and_bad_account_too(self):
        uid = self.users.add_user("petya@example.com")
        self.users.set_disabled(uid, True)
        with self.assertRaises(us.LoginError) as e:
            self.login()
        self.assertEqual(e.exception.status, 403)
        with self.assertRaises(us.LoginError) as e:
            self.login(token="who-knows")
        self.assertEqual(e.exception.status, 403, "CUB не узнал токен")

    def test_merge_moves_devices_data_and_email(self):
        self.users.set_registration(True)
        owner = us.OWNER
        self.users.set_email(owner, "old@example.com")
        new = self.users.login_cub("1.1.1.1", "cub.test", "good-token", 1, "Телефон")["user"]["id"]      # зарегистрировался отдельно
        from tapokhub.modules.library import LIB_SCHEMA
        self.store.conn().executescript(LIB_SCHEMA)
        self.store.conn().execute("INSERT INTO franchises(title, root_kind, root_id, status, created_at, user_id) VALUES('Сага', 'movie', 1, 'ready', 1, ?)", (new,))
        self.store.conn().execute("INSERT INTO library_items VALUES(?, 'movie', 1, 100)", (new,))
        self.store.conn().execute("INSERT INTO library_items VALUES(?, 'movie', 1, 200)", (owner,))      # такая же позиция уже у владельца
        tok = self.users.issue_token(new, "ТВ")
        self.users.merge(new, owner)
        self.assertEqual(self.users.authenticate(tok), owner, "устройства переехали")
        self.assertIsNone(self.users.user(new))
        self.assertEqual(self.users.user(owner)["email"], "petya@example.com", "вход через CUB теперь ведёт к владельцу")
        self.assertEqual(self.store.conn().execute("SELECT COUNT(*) FROM franchises WHERE user_id=?", (owner,)).fetchone()[0], 1)
        self.assertEqual(self.store.conn().execute("SELECT COUNT(*) FROM library_items WHERE user_id=?", (owner,)).fetchone()[0], 1, "дубли не создаются")
        with self.assertRaises(ValueError):
            self.users.merge(owner, owner)

    def test_login_input_checks_and_cub_failures(self):
        self.users.add_user("petya@example.com")
        with self.assertRaises(us.LoginError) as e:
            self.login(domain="evil.example")
        self.assertEqual(e.exception.status, 400, "домен только из списка: сервер не ходит куда попало")
        with self.assertRaises(us.LoginError) as e:
            self.login(token="")
        self.assertEqual(e.exception.status, 400)
        with self.assertRaises(us.LoginError) as e:
            self.login(token="x" * 5000)
        self.assertEqual(e.exception.status, 400)
        self.cub.mode = "500"
        with self.assertRaises(us.LoginError) as e:
            self.login()
        self.assertEqual(e.exception.status, 424, "не 5xx: Cloudflare подменил бы ответ страницей без CORS, и Lampa увидела бы только «network»")
        self.assertIn("500", e.exception.message)

    def test_new_mirror_domains_are_added_by_the_admin_only(self):
        self.users.add_user("petya@example.com")
        with self.assertRaises(us.LoginError) as e:
            self.login(domain="mirror.test")
        self.assertEqual(e.exception.status, 400)
        self.assertIn("mirror.test", e.exception.message, "в сообщении домен: его видно и пользователю, и в журнале")
        self.assertEqual(self.users.add_domain(" Mirror.Test "), "mirror.test")
        self.assertTrue(self.login(domain="mirror.test")["token"])
        self.assertTrue(self.users.remove_domain("mirror.test"))
        with self.assertRaises(us.LoginError):
            self.login(domain="mirror.test")
        for bad in ("http://x.test", "x.test/path", "nodots", "a b.test", ""):
            with self.assertRaises(ValueError):
                self.users.add_domain(bad)

    def test_http_only_mirror_needs_an_explicit_admin_flag(self):
        self.assertEqual(self.users.schemes("cub.test"), ["https"])
        self.assertEqual(self.users.schemes("cubleave.store"), [], "неизвестный домен: никуда не ходим")
        self.users.add_domain("cubleave.store", http=True)
        self.assertEqual(self.users.schemes("cubleave.store"), ["http"], "по http только то, что разрешено явно")
        self.users.add_domain("cubleave.store")
        self.assertEqual(self.users.schemes("cubleave.store"), ["https", "http"], "https пробуем первым")
        self.assertTrue(self.users.remove_domain("cubleave.store"))
        self.assertEqual(self.users.schemes("cubleave.store"), [], "убираются обе записи")

    def test_cub_answer_700_means_wrong_account_token_and_is_a_403(self):
        self.users.add_user("petya@example.com")
        self.cub.mode = "700"
        with self.assertRaises(us.LoginError) as e:
            self.login()
        self.assertEqual(e.exception.status, 403)
        self.assertIn("Вход не выполнен", e.exception.message)

    def test_login_attempts_are_throttled_per_address(self):
        self.users.add_user("petya@example.com")
        for _ in range(us.LOGIN_MAX):
            try:
                self.login(token="who-knows", who="9.9.9.9")
            except us.LoginError:
                pass
        with self.assertRaises(us.LoginError) as e:
            self.login(token="who-knows", who="9.9.9.9")
        self.assertEqual(e.exception.status, 429)
        self.assertTrue(self.login(who="8.8.8.8")["token"], "другой адрес не пострадал")
        self.clock.t += us.LOGIN_WINDOW + 1
        self.assertTrue(self.login(who="9.9.9.9")["token"], "окно прошло")


if __name__ == "__main__":
    unittest.main(verbosity=1)
